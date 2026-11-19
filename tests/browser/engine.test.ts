import { expect, test } from "vite-plus/test";
import { discardEngine, getEngine, withEngine } from "@/engine/session";

const names = async () =>
  (
    await (
      await getEngine()
    ).query("SELECT extension_name AS name FROM duckdb_extensions() WHERE loaded ORDER BY name")
  ).map((row) => row.name);

test("runs DuckDB 2 with parquet, spatial, cityjson and three_d loaded, and not httpfs", async () => {
  const engine = await getEngine();
  const [version] = await engine.query("SELECT library_version AS v FROM pragma_version()");
  expect(String(version?.v)).toMatch(/^v2\./);

  // A read over HTTP, which must go through duckdb-wasm's own HTTP and not autoload httpfs.
  const url = new URL("/fixtures/delft/building.parquet", location.href).href;
  const [row] = await engine.query(`SELECT count(*) AS n FROM read_parquet('${url}')`);
  expect(row?.n).toBe(748);

  const loaded = await names();
  expect(loaded).toEqual(expect.arrayContaining(["cityjson", "parquet", "spatial", "three_d"]));
  expect(loaded).not.toContain("httpfs");
});

test("a fatal error discards the worker, and the next use gets a fresh, working one", async () => {
  const before = await getEngine();
  await expect(
    withEngine(async () => {
      throw new Error("RuntimeError: memory access out of bounds");
    }),
  ).rejects.toThrow();
  const after = await getEngine();
  expect(after).not.toBe(before);
  await expect(before.query("SELECT 1")).rejects.toThrow();
  expect(await after.query("SELECT 42 AS v")).toEqual([{ v: 42 }]);
  await discardEngine();
});

test("files written to the virtual file system can be read back and dropped", async () => {
  const engine = await getEngine();
  await engine.exec("COPY (SELECT 1 AS a) TO 'out.csv' (HEADER false)");
  const bytes = await engine.readFile("out.csv");
  expect(new TextDecoder().decode(bytes).trim()).toBe("1");
  expect(await engine.query("SELECT file FROM glob('*')")).toEqual([{ file: "out.csv" }]);
  // Gone from the listing. (copyFileToBuffer on a missing path does not throw, so a
  // read-back cannot show it.)
  await engine.dropFiles(["out.csv"]);
  expect(await engine.query("SELECT file FROM glob('*')")).toEqual([]);
});
