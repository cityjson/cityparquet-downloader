import { describe, expect, test } from "vite-plus/test";
import type { Chunk, ChunkKey } from "@/core/chunk";
import { parseFilter } from "@/core/filter";
import type { RowGroup } from "@/core/footer";
import {
  compileSelection,
  estimateBytes,
  fromMercator,
  parseExtent,
  type ScopeChunk,
  SELECTION_ROW_LIMIT,
  type Selection,
  selectionPageSql,
  toMercator,
} from "@/core/selection";
import type { Sql } from "@/core/sql";
import { WEB_MERCATOR_HALF } from "@/core/tile";
import { parseUrl } from "@/core/url";

const file = parseUrl("https://h/p/building.parquet");

/** Chunk `i` of table `building`: `rows` rows, its WGS 84 box one degree wide at `x`. */
function chunk(i: number, rows: number, x: number): ScopeChunk {
  const c: Chunk = {
    key: `building|${i}|${file}` as ChunkKey,
    table: "building",
    file,
    fileIndex: 0,
    index: i,
    start: i * rows,
    rows,
    bbox: null,
    wgs84: { xmin: x, ymin: 50, xmax: x + 1, ymax: 51 },
  };
  return { chunk: c, id: 10 + i };
}

const table = {
  name: "building",
  columns: [
    { name: "id", type: "VARCHAR" },
    { name: "object_type", type: "VARCHAR" },
    { name: "roof", type: "VARCHAR" },
    { name: "year", type: "BIGINT" },
  ],
};
const none: Selection = {
  table: "building",
  extent: null,
  filter: null,
  hiddenTypes: { all: false, types: [] },
};
const square = parseExtent([
  [4.2, 50.2],
  [4.4, 50.2],
  [4.4, 50.4],
  [4.2, 50.4],
]);

describe("parseExtent", () => {
  test("drops a closing vertex and refuses fewer than three vertices or non-numbers", () => {
    expect(
      parseExtent([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ]).ring,
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(() =>
      parseExtent([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    ).toThrow(/three/);
    expect(() =>
      parseExtent([
        [0, 0],
        [1, Number.NaN],
        [2, 2],
      ]),
    ).toThrow(/number/);
    expect(() =>
      parseExtent([
        [0, 0],
        [1, 91],
        [2, 2],
      ]),
    ).toThrow(/latitude/);
  });
});

test("toMercator matches EPSG:3857 at the edges and at Delft", () => {
  expect(toMercator([180, 0])[0]).toBeCloseTo(WEB_MERCATOR_HALF, 6);
  expect(toMercator([0, 85.0511287798066])[1]).toBeCloseTo(WEB_MERCATOR_HALF, 0);
  // DuckDB spatial: ST_Transform(ST_Point(4.36, 52.01), 'EPSG:4326', 'EPSG:3857', always_xy := true)
  const [x, y] = toMercator([4.36, 52.01]);
  expect(x).toBeCloseTo(485352.9798586728, 6);
  expect(y).toBeCloseTo(6801933.784650408, 6);
  const [lon, lat] = fromMercator([x, y]);
  expect(lon).toBeCloseTo(4.36, 12);
  expect(lat).toBeCloseTo(52.01, 12);
});

describe("compileSelection: the scope", () => {
  const chunks = [chunk(0, 100, 3), chunk(1, 100, 4), chunk(2, 100, 5)];

  test("a drawn area scopes the row groups its box overlaps", () => {
    const plan = compileSelection({ ...none, extent: square }, table, chunks, []);
    expect(plan.kind).toBe("ready");
    expect(plan.scope.basis).toBe("extent");
    expect(plan.scope.chunks.map((c) => c.id)).toEqual([11]);
    expect(plan.scope.rows).toBe(100);
  });

  test("without an area, a table that fits the limit is its own scope", () => {
    const plan = compileSelection(none, table, chunks, [chunks[1] as ScopeChunk]);
    expect(plan.scope.basis).toBe("table");
    expect(plan.scope.chunks).toHaveLength(3);
  });

  test("without an area, a large table is scoped to the row groups in view", () => {
    const big = [chunk(0, 300_000, 3), chunk(1, 300_000, 4)];
    const plan = compileSelection(none, table, big, [big[1] as ScopeChunk]);
    expect(plan.kind).toBe("ready");
    expect(plan.scope.basis).toBe("view");
    expect(plan.scope.chunks.map((c) => c.id)).toEqual([11]);
  });

  test("a scope over the limit is refused, with its size", () => {
    const big = [chunk(0, 300_000, 3), chunk(1, 300_000, 4)];
    const plan = compileSelection(none, table, big, big);
    expect(plan).toMatchObject({ kind: "too-large", limit: SELECTION_ROW_LIMIT });
    expect(plan.scope.rows).toBe(600_000);
  });
});

describe("compileSelection: the predicate", () => {
  const chunks = [chunk(1, 100, 4)];
  const filter = (() => {
    const p = parseFilter(
      {
        combinator: "or",
        conditions: [
          { id: "a", column: "roof", op: "eq", value: "slanted", value2: "" },
          { id: "b", column: "object_type", op: "ne", value: "X", value2: "" },
        ],
      },
      table.columns,
    );
    if (!p.ok || !p.filter) throw new Error("bad filter");
    return p.filter;
  })();

  test("everything in scope without an area, a filter or hidden types", () => {
    const plan = compileSelection(none, table, chunks, []);
    if (plan.kind !== "ready") throw new Error(plan.kind);
    expect(plan.where).toBe("TRUE");
    expect(plan.columns).toEqual([]);
  });

  test("the area in Web Mercator, AND the filter, AND the shown object types", () => {
    const plan = compileSelection(
      {
        ...none,
        extent: square,
        filter,
        hiddenTypes: { all: false, types: ["BuildingPart", "O'Hare"] },
      },
      table,
      chunks,
      [],
    );
    if (plan.kind !== "ready") throw new Error(plan.kind);
    const ring = [
      [4.2, 50.2],
      [4.4, 50.2],
      [4.4, 50.4],
      [4.2, 50.4],
      [4.2, 50.2],
    ]
      .map(([lon, lat]) => toMercator([lon as number, lat as number]).join(" "))
      .join(", ");
    expect(plan.where).toBe(
      `(ST_Intersects(__geom, ST_MakeValid(ST_GeomFromText('POLYGON((${ring}))'))))` +
        ` AND ("object_type" NOT IN ('BuildingPart', 'O''Hare'))` +
        ` AND (("roof" = 'slanted') OR ("object_type" IS DISTINCT FROM 'X'))`,
    );
  });

  test("a table hidden in the legend selects nothing", () => {
    const plan = compileSelection(
      { ...none, filter, hiddenTypes: { all: true, types: [] } },
      table,
      chunks,
      [],
    );
    if (plan.kind !== "ready") throw new Error(plan.kind);
    expect(plan.where).toBe("FALSE");
  });

  test("only attribute columns are read; the map already holds id, feature_id and object_type", () => {
    const plan = compileSelection({ ...none, filter }, table, chunks, []);
    if (plan.kind !== "ready") throw new Error(plan.kind);
    expect(plan.columns).toEqual(["roof"]);
  });
});

test("the page orders by the column's own type, not by its text", () => {
  const sql = selectionPageSql(
    [chunk(1, 100, 4)],
    { where: "TRUE" as Sql, columns: [] },
    ["year"],
    {
      sort: { column: "year", direction: "desc" },
      limit: 20,
      offset: 40,
    },
  );
  expect(sql).toContain(`CAST(s."year" AS VARCHAR) AS "year"`);
  expect(sql).toContain(`ORDER BY s."year" DESC NULLS LAST, s.__uid`);
  expect(sql).toContain("LIMIT 20 OFFSET 40");
});

test("estimateBytes scales the scope's row groups by the selected share", () => {
  const group = (bytes: number): RowGroup => ({
    file,
    index: 0,
    rows: 100,
    bytes,
    bbox: null,
    columnBytes: { id: bytes / 4, roof: bytes / 4 },
  });
  expect(estimateBytes([group(1000), group(3000)], 50)).toBe(1000);
  expect(estimateBytes([group(1000), group(3000)], 50, ["roof"])).toBe(250);
  expect(estimateBytes([], 0)).toBe(0);
});
