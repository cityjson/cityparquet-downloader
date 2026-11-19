// A drawn area and a filter on the national 3DBAG file, through the app's own SQL: the
// scope's row groups, their footprints as the map loads them, the filter's columns and
// the count. Opt-in: CITYPARQUET_REMOTE=1. Nothing here is pinned to a row count, since
// the data is published by others: the area's answer is checked against the same test
// run in the package CRS on the geometry read again, with the area's edges densified.
import { expect, test } from "vite-plus/test";
import {
  chunksOf,
  compileSelection,
  createFeaturesSql,
  DEFAULT_SOURCE,
  footprintOf,
  loadAttrsSql,
  loadChunkSql,
  materialiseSql,
  openPackage,
  outlinesSql,
  parseExtent,
  parseFilter,
  parseSource,
  resolveSource,
  type Selection,
  selectionCountSql,
  toMercator,
} from "@/core";
import { getEngine } from "@/engine/session";

const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
};

// About 250 by 250 metres of central Delft, the area the fixture tests draw.
const RING: [number, number][] = [
  [4.3595, 52.0092],
  [4.362, 52.0089],
  [4.3627, 52.0103],
  [4.361, 52.0111],
  [4.3593, 52.0104],
];

/** The ring with each edge cut into steps that are straight in Web Mercator, as WKT in 3857. */
function densified(steps = 64): string {
  const m = RING.map(toMercator);
  const closed = [...m, m[0] as [number, number]];
  const points: string[] = [];
  for (let i = 0; i < m.length; i++) {
    const [x0, y0] = closed[i] as [number, number];
    const [x1, y1] = closed[i + 1] as [number, number];
    for (let s = 0; s < steps; s++) {
      points.push(`${x0 + ((x1 - x0) * s) / steps} ${y0 + ((y1 - y0) * s) / steps}`);
    }
  }
  return `POLYGON((${[...points, points[0]].join(", ")}))`;
}

test("an area and a filter over Delft select what the package CRS agrees on", async () => {
  const engine = await getEngine();
  const source = await resolveSource(parseSource(DEFAULT_SOURCE, location.href), (u, i) =>
    fetch(u, i),
  );
  const info = await timed("open", () => openPackage(engine, source));
  const table = info.tables[0];
  if (table?.crs.kind !== "known") throw new Error("no building table with a CRS");
  const crs = table.crs.horizontal.definition;

  const own = chunksOf(table);
  const outlines = outlinesSql(own, crs);
  for (const r of outlines ? await timed("outlines", () => engine.query(outlines)) : []) {
    const c = own[Number(r.i)];
    if (c) {
      c.wgs84 = {
        xmin: Number(r.xmin),
        ymin: Number(r.ymin),
        xmax: Number(r.xmax),
        ymax: Number(r.ymax),
      };
    }
  }
  const chunks = own.map((chunk, id) => ({ chunk, id }));
  const parsed = parseFilter(
    {
      combinator: "and",
      conditions: [
        { id: "a", column: "oorspronkelijkbouwjaar", op: "lt", value: "1950", value2: "" },
      ],
    },
    table.columns,
  );
  if (!parsed.ok) throw new Error("the filter does not parse");
  const base: Selection = {
    table: table.name,
    extent: parseExtent(RING),
    filter: null,
    hiddenTypes: { all: false, types: [] },
  };
  const area = compileSelection(base, table, chunks, []);
  const filtered = compileSelection({ ...base, filter: parsed.filter }, table, chunks, []);
  const scope = area.scope.chunks;
  console.log(`scope: row groups ${scope.map((c) => c.chunk.index).join(", ")}`);
  expect(scope.length).toBeGreaterThan(0);
  expect(scope.length).toBeLessThan(10);

  for (const s of createFeaturesSql) await engine.exec(s);
  for (const c of scope) {
    await timed(`footprints of row group ${c.chunk.index}`, () =>
      engine.exec(loadChunkSql(c.chunk, footprintOf(table), crs, c.id)),
    );
  }
  for (const c of scope) {
    await timed(`filter columns of row group ${c.chunk.index}`, () =>
      engine.exec(loadAttrsSql(c, filtered.columns, [])),
    );
  }
  const count = async (plan: typeof area) => {
    for (const s of materialiseSql(table.name, scope, plan)) await engine.exec(s);
    const [row] = await engine.query(selectionCountSql(scope, plan));
    return Number(row?.n);
  };
  const inArea = await timed("count the area", () => count(area));
  const inAreaOld = await timed("count the area and the filter", () => count(filtered));
  console.log(`area ${inArea}, of them built before 1950 ${inAreaOld}`);
  expect(inAreaOld).toBeGreaterThan(0);
  expect(inAreaOld).toBeLessThan(inArea);

  // The same area in the package CRS, on the geometry read again.
  const wkt = densified().replaceAll("'", "''");
  const from = crs.replaceAll("'", "''");
  const reads = scope.map(
    ({ chunk }) =>
      `SELECT geometry_lod0_0 AS g FROM read_parquet('${chunk.file}', file_row_number := true)
       WHERE file_row_number >= ${chunk.start} AND file_row_number < ${chunk.start + chunk.rows}`,
  );
  const [check] = await timed("the same area in the package CRS", () =>
    engine.query(
      `SELECT count(*)::INTEGER AS n FROM (${reads.join(" UNION ALL ")})
       WHERE g IS NOT NULL AND ST_Intersects(g,
         ST_Transform(ST_GeomFromText('${wkt}'), 'EPSG:3857', '${from}', always_xy := true))`,
    ),
  );
  expect(inArea).toBe(Number(check?.n));
});
