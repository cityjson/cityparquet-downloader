// The one place that talks to duckdb-wasm. Everything else sends SQL through `Engine`.
import * as duckdb from "@duckdb/duckdb-wasm";
import baseWasm from "@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url";
import baseWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url";

export type Row = Record<string, unknown>;

export interface Engine {
  /** Runs one statement and returns its rows as plain JSON values (BIGINT as number). */
  query(sql: string): Promise<Row[]>;
  /** Tears the worker down. Create a new engine afterwards. */
  terminate(): Promise<void>;
}

/**
 * The extensions the app needs, all signed builds for the DuckDB version duckdb-wasm
 * embeds: `cityjson` reads and writes CityParquet packages, `three_d` works on the 3D
 * geometry they carry, `parquet` and `httpfs` read the files in place over HTTP.
 */
const CORE_EXTENSIONS = ["parquet"];
const COMMUNITY_EXTENSIONS = ["cityjson", "three_d"];

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

export async function createEngine(): Promise<Engine> {
  // The single-threaded bundle: it needs no cross-origin isolation, so the app can be
  // served from any static host.
  const worker = new Worker(baseWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
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
    async terminate() {
      await conn.close().catch(() => undefined);
      await db.terminate();
    },
  };
}
