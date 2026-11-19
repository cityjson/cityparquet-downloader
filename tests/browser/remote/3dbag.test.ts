// The national 3DBAG package (14.4 GB, one file) opened from its public host, footers
// only. Opt-in: CITYPARQUET_REMOTE=1 (`just test-remote`).
import { expect, test } from "vitest";
import {
  DEFAULT_SOURCE,
  describeSql,
  kvSql,
  openPackage,
  parseSource,
  parseTable,
  resolveSource,
  rowGroupsSql,
} from "@/core";
import { getEngine } from "@/engine/session";

const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
};

test("3DBAG opens from its footers: 329 row groups, the RD New extent in WGS 84", async () => {
  const engine = await getEngine();
  const source = await timed("resolve", () =>
    resolveSource(parseSource(DEFAULT_SOURCE, location.href), (u, i) => fetch(u, i)),
  );
  expect(source.listedBy).toBe("metadata");
  const [table] = source.tables;
  if (!table) throw new Error("no table");
  expect(table.name).toBe("building");

  const kv = await timed("kv", () => engine.query(kvSql(table.files)));
  const columns = await timed("describe", () => engine.query(describeSql(table.files)));
  const groups = await timed("row groups", () => engine.query(rowGroupsSql(table.files)));
  const info = parseTable(table.name, table.files, kv, columns, groups);
  expect(info.rowGroups).toHaveLength(329);
  expect(info.rowCount).toBeGreaterThan(20_000_000);
  expect(info.lods).toEqual(["0.0", "1.2", "1.3", "2.2"]);
  console.log(`columns ${info.columns.length}, attributes ${info.attributes.length}`);

  const opened = await timed("openPackage (all of it again)", () => openPackage(engine, source));
  const extent = opened.extentWgs84;
  console.log(`extent ${JSON.stringify(extent)}`);
  // The Netherlands, longitude first.
  expect(extent?.xmin).toBeGreaterThan(3);
  expect(extent?.xmax).toBeLessThan(7.5);
  expect(extent?.ymin).toBeGreaterThan(50.5);
  expect(extent?.ymax).toBeLessThan(54);
});
