// The one place that talks to duckdb-wasm. Everything else sends SQL through `Engine`.
import type { Engine, Row } from "@cityjson/cjconv-core";
import * as duckdb from "@duckdb/duckdb-wasm";
import baseWasm from "@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url";
import baseWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url";

export interface BrowserEngine extends Engine {
  /** Reads a file DuckDB wrote to its virtual file system (a `COPY … TO` target). */
  readFile(path: string): Promise<Uint8Array>;
  /** Frees virtual-FS files once they are no longer needed. */
  dropFiles(paths: string[]): Promise<void>;
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

export async function createEngine(): Promise<BrowserEngine> {
  // The single-threaded bundle: it needs no cross-origin isolation, so the app can be
  // served from any static host.
  const worker = new Worker(baseWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  try {
    await db.instantiate(baseWasm);
    await db.open({});
    const conn = await db.connect();
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
      async exec(sql) {
        await conn.query(sql);
      },
      async readFile(path) {
        return db.copyFileToBuffer(path);
      },
      async dropFiles(paths) {
        for (const path of paths) await db.dropFile(path).catch(() => undefined);
      },
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
