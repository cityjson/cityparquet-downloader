import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine, type Engine } from "../../src/engine/duckdb";

const PACKAGE = "https://cityparquet.open3d.city/data/plateau/chuo-ku";

let engine: Engine;

beforeAll(async () => {
  engine = await createEngine();
}, 120_000);

afterAll(async () => {
  await engine?.terminate();
});

test("runs DuckDB 2 with the cityjson and three_d extensions loaded", async () => {
  const [version] = await engine.query("SELECT library_version AS v FROM pragma_version()");
  expect(String(version?.v)).toMatch(/^v2\./);

  const loaded = await engine.query(
    "SELECT extension_name AS name FROM duckdb_extensions() WHERE loaded ORDER BY name",
  );
  expect(loaded.map((row) => row.name)).toEqual(expect.arrayContaining(["cityjson", "three_d"]));
});

test("reads a remote CityParquet file in place", async () => {
  const [row] = await engine.query(
    `SELECT count(*) AS n FROM read_parquet('${PACKAGE}/building.parquet')`,
  );
  expect(Number(row?.n)).toBeGreaterThan(0);
});
