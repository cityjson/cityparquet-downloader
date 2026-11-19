// The one place that talks to duckdb-wasm. Everything else sends SQL through `Engine`.
import type { Engine, Row } from "@cityjson/cjconv-core";
import * as duckdb from "@duckdb/duckdb-wasm";
import baseWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url";

export interface BrowserEngine extends Engine {
  /** The first column of the first row as bytes (a BLOB, such as a vector tile); null for NULL or no row. */
  queryBytes(sql: string): Promise<Uint8Array | null>;
  /** Reads a file DuckDB wrote to its virtual file system (a `COPY … TO` target). */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Where large files are written: a directory in the browser's origin private file
   * system (`opfs://…`), on disk and outside DuckDB's memory; or `/scratch`, in memory,
   * where the browser has none.
   */
  scratch: string;
  /** A file DuckDB wrote, as a Blob: for one under `opfs://` the file on disk, not a copy in memory. */
  openFile(path: string): Promise<Blob>;
  /** Frees virtual-FS files once they are no longer needed. */
  dropFiles(paths: string[]): Promise<void>;
  /** Removes everything under `scratch` that is on disk. */
  clearScratch(): Promise<void>;
  /** Tears the worker down. Create a new engine afterwards. */
  terminate(): Promise<void>;
}

/**
 * Signed builds for the DuckDB version duckdb-wasm embeds. `parquet` reads the files,
 * `spatial` transforms coordinates and makes vector tiles, `cityjson` reads and writes
 * the city model formats, `three_d` works on 3D geometry. `httpfs` is not one of them:
 * loaded in wasm it breaks range reads, and duckdb-wasm's own HTTP reads remote files.
 */
const CORE_EXTENSIONS = ["parquet", "spatial"];
const COMMUNITY_EXTENSIONS = ["cityjson", "three_d"];

/**
 * The engine's wasm. Cloudflare Workers serve static assets of at most 25 MiB and
 * `duckdb-base.wasm` is 33.7 MB, so a build with `VITE_DUCKDB_CDN=1` fetches it from
 * jsDelivr at the installed duckdb-wasm version, which the bundled worker matches;
 * otherwise it is bundled. The worker stays same-origin either way.
 */
async function wasmUrl(): Promise<string> {
  if (import.meta.env.VITE_DUCKDB_CDN === "1")
    return `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${__DUCKDB_WASM_VERSION__}/dist/duckdb-base.wasm`;
  return (await import("@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url")).default;
}

/** Arrow rows → plain JSON values: BIGINT becomes number, STRUCT and LIST plain objects. */
function toRows(table: { toArray(): { toJSON(): unknown }[] }): Row[] {
  return table
    .toArray()
    .map(
      (row) =>
        JSON.parse(
          JSON.stringify(row.toJSON(), (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)),
        ) as Row,
    );
}

const OPFS = "opfs://";
/** The app's directory in the origin private file system. */
const SCRATCH = `${OPFS}cityparquet-downloader`;

/** The directory duckdb-wasm keeps `opfs://<path>` files in, or null without the file system. */
async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const duckdb = await root.getDirectoryHandle("duckdb", { create: true });
    return await duckdb.getDirectoryHandle("fs", { create: true });
  } catch {
    return null;
  }
}

/** The directory holding `path` (an `opfs://` one) and its name in it. */
async function locate(root: FileSystemDirectoryHandle, path: string) {
  const parts = path.slice(OPFS.length).split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return { dir, name };
}

export async function createEngine(): Promise<BrowserEngine> {
  // The single-threaded bundle: it needs no cross-origin isolation, so the app can be
  // served from any static host.
  const worker = new Worker(baseWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  try {
    await db.instantiate(await wasmUrl());
    // Range reads only, all three flags explicit. This build's defaults force whole-file
    // HTTP reads (a plain HEAD, then a GET with no Range), which for a national package
    // (14 GB) exhausts the tab's memory. A server without range support is an error.
    await db.open({
      filesystem: {
        forceFullHTTPReads: false,
        reliableHeadRequests: true,
        allowFullHTTPReads: false,
      },
      // `opfs://` files named in SQL are opened for the query and closed after it.
      opfs: { fileHandling: "auto" },
    });
    const conn = await db.connect();
    const disk = await opfsRoot();
    const clearScratch = async () => {
      if (!disk) return;
      await disk
        .removeEntry(SCRATCH.slice(OPFS.length), { recursive: true })
        .catch(() => undefined);
    };
    // Files a page left behind when it was closed or reloaded.
    await clearScratch();
    for (const name of CORE_EXTENSIONS) {
      await conn.query(`INSTALL ${name}`);
      await conn.query(`LOAD ${name}`);
    }
    for (const name of COMMUNITY_EXTENSIONS) {
      await conn.query(`INSTALL ${name} FROM community`);
      await conn.query(`LOAD ${name}`);
    }
    return {
      async query(sql) {
        return toRows(await conn.query(sql));
      },
      async queryBytes(sql) {
        const value: unknown = (await conn.query(sql)).getChildAt(0)?.get(0);
        return value instanceof Uint8Array ? value : null;
      },
      async exec(sql) {
        await conn.query(sql);
      },
      async readFile(path) {
        return db.copyFileToBuffer(path);
      },
      scratch: disk ? SCRATCH : "/scratch",
      async openFile(path) {
        if (!disk || !path.startsWith(OPFS)) {
          return new Blob([(await db.copyFileToBuffer(path)) as Uint8Array<ArrayBuffer>]);
        }
        const { dir, name } = await locate(disk, path);
        return (await dir.getFileHandle(name)).getFile();
      },
      async dropFiles(paths) {
        for (const path of paths) {
          if (disk && path.startsWith(OPFS)) {
            const at = await locate(disk, path).catch(() => null);
            await at?.dir.removeEntry(at.name).catch(() => undefined);
          } else await db.dropFile(path).catch(() => undefined);
        }
      },
      clearScratch,
      async terminate() {
        await conn.close().catch(() => undefined);
        await db.terminate();
      },
    };
  } catch (error) {
    await db.terminate().catch(() => undefined);
    throw error;
  }
}
