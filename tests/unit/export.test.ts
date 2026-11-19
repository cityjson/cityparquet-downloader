import { describe, expect, test } from "vite-plus/test";
import { type Chunk, type ChunkKey, chunksOf } from "@/core/chunk";
import {
  exportFraction,
  checkRequest,
  EXPORT_SIZE_LIMIT,
  type ExportRequest,
  estimateExport,
  exportColumns,
  neighbours,
  outputLayout,
  planExport,
  transformOptions,
  writeSql,
} from "@/core/export";
import type { RowGroup, TableInfo } from "@/core/footer";
import { parseUrl } from "@/core/url";

const file = parseUrl("https://h/p/building.parquet");

const columns = [
  "id",
  "feature_id",
  "object_type",
  "parents",
  "children",
  "children_roles",
  "address",
  "bbox",
  "geometry_lod0_0",
  "geometry_properties_lod0_0",
  "material_lod0_0",
  "texture_lod0_0",
  "geometry_lod2_2",
  "geometry_properties_lod2_2",
  "material_lod2_2",
  "texture_lod2_2",
  "template",
  "other",
  "roof",
  "year",
].map((name) => ({ name, type: name === "year" ? "BIGINT" : "VARCHAR" }));

const groups: RowGroup[] = [0, 1, 2].map((index) => ({
  file,
  index,
  rows: 100,
  bytes: 1000,
  bbox: null,
  columnBytes: { id: 100, feature_id: 100, geometry_lod2_2: 500, roof: 50, year: 10 },
}));

const city = {
  crs: { type: "CompoundCRS", name: "RD", id: { authority: "EPSG", code: 7415 } },
  other: { transform: { scale: [0.001, 0.001, 0.01], translate: [1, 2, 3] } },
};

const table: TableInfo = {
  name: "building",
  files: [file],
  rowCount: 300,
  crs: { kind: "unknown" },
  lods: ["0.0", "2.2"],
  columns,
  reserved: [],
  attributes: columns.filter((c) => c.name === "roof" || c.name === "year"),
  rowGroups: groups,
  extent: null,
  footer: { city: JSON.stringify(city), geo: null },
};

const request = (patch: Partial<ExportRequest> = {}): ExportRequest => ({
  tables: [{ name: "building", lods: ["2.2"], attributes: ["roof"] }],
  format: "cityjsonseq",
  fileName: "delft centre",
  ...patch,
});

describe("exportColumns", () => {
  test("keeps every reserved column, and only the chosen LoD groups and attributes", () => {
    expect(exportColumns(table, { name: "building", lods: ["2.2"], attributes: ["roof"] })).toEqual(
      [
        "id",
        "feature_id",
        "object_type",
        "parents",
        "children",
        "children_roles",
        "address",
        "bbox",
        "geometry_lod2_2",
        "geometry_properties_lod2_2",
        "material_lod2_2",
        "texture_lod2_2",
        "template",
        "other",
        "roof",
      ],
    );
  });
});

describe("checkRequest", () => {
  test("accepts a request the package can answer", () => {
    expect(checkRequest([table], request())).toBeNull();
  });

  test("refuses an OBJ with other than one LoD, a LoD or attribute the table lacks, no table", () => {
    const two = request({
      format: "obj",
      tables: [{ name: "building", lods: ["0.0", "2.2"], attributes: [] }],
    });
    expect(checkRequest([table], two)).toMatch(/one LoD/);
    expect(
      checkRequest(
        [table],
        request({ tables: [{ name: "building", lods: ["1.2"], attributes: [] }] }),
      ),
    ).toMatch(/1\.2/);
    expect(
      checkRequest(
        [table],
        request({ tables: [{ name: "building", lods: ["2.2"], attributes: ["height"] }] }),
      ),
    ).toMatch(/height/);
    expect(checkRequest([table], request({ tables: [] }))).toMatch(/table/);
    expect(checkRequest([table], request({ fileName: " " }))).toMatch(/name/);
  });
});

describe("neighbours", () => {
  const chunks = chunksOf(table);
  const at = (i: number) => chunks[i] as Chunk;

  test("a wanted row on a row group's first or last row brings in the row group beside it", () => {
    const read = new Set<ChunkKey>([at(1).key]);
    // Row 100 is row group 1's first row; row 199 its last.
    expect(neighbours(chunks, read, [{ tbl: "building", file: 0, row: 100 }])).toEqual([at(0)]);
    expect(neighbours(chunks, read, [{ tbl: "building", file: 0, row: 199 }])).toEqual([at(2)]);
    expect(neighbours(chunks, read, [{ tbl: "building", file: 0, row: 150 }])).toEqual([]);
  });

  test("stops at the ends of the file and at row groups already read", () => {
    const read = new Set<ChunkKey>([at(0).key, at(1).key]);
    expect(neighbours(chunks, read, [{ tbl: "building", file: 0, row: 0 }])).toEqual([]);
    expect(neighbours(chunks, read, [{ tbl: "building", file: 0, row: 100 }])).toEqual([]);
  });
});

describe("estimateExport", () => {
  test("reads the chosen columns of every row group in scope, and keeps the selected share", () => {
    const e = estimateExport(
      [{ table, scope: chunksOf(table).slice(0, 2), selected: 50, drawable: 100 }],
      request(),
    );
    // Columns read: id, feature_id, geometry_lod2_2, roof (100 + 100 + 500 + 50) per row group.
    expect(e.readBytes).toBe(2 * 750);
    expect(e.rowGroups).toBe(2);
    expect(e.selected).toBe(50);
    // Half the drawable rows are selected, so half of what is read is kept.
    expect(e.keptBytes).toBe(750);
    expect(e.tooLarge).toBe(false);
    expect(e.parts).toBe(1);
    const big = estimateExport(
      [{ table, scope: chunksOf(table), selected: 100, drawable: 100 }],
      request(),
      1000,
    );
    expect(big.tooLarge).toBe(true);
    expect(EXPORT_SIZE_LIMIT).toBeGreaterThan(0);
  });
});

test("a download in several parts is a zip of numbered files or packages", () => {
  const part = { index: 1, count: 3 };
  expect(outputLayout("cityjson", "delft", 1, part)).toMatchObject({
    target: "/export/1/delft/delft-part-002.city.json",
    download: "delft.zip",
    zip: true,
  });
  expect(outputLayout("cityparquet", "delft", 1, part).target).toBe(
    "/export/1/delft/delft-part-002/",
  );
  expect(outputLayout("obj", "delft", 1, part).target).toBe("/export/1/delft/delft-part-002.obj");
});

describe("transformOptions", () => {
  test("keeps the footer's scale and puts the origin at the data's minimum corner", () => {
    expect(transformOptions(JSON.stringify(city), { x: 84500.5, y: 447200, z: -1 })).toEqual({
      transform_scale: "0.001,0.001,0.01",
      transform_translate: "84500.5,447200,-1",
    });
    expect(transformOptions("{}", { x: 1, y: 2, z: 3 })).toEqual({
      transform_translate: "1,2,3",
    });
    expect(transformOptions("{}", null)).toEqual({});
  });
});

describe("outputLayout", () => {
  test("one file downloads as itself; a package or an OBJ is a zip with one folder", () => {
    expect(outputLayout("cityjsonseq", "delft centre", 3)).toEqual({
      root: "/export/3",
      target: "/export/3/delft centre.city.jsonl",
      download: "delft centre.city.jsonl",
      zip: false,
    });
    expect(outputLayout("cityparquet", "delft", 1)).toMatchObject({
      target: "/export/1/delft/",
      download: "delft.zip",
      zip: true,
    });
    expect(outputLayout("obj", "delft", 1)).toMatchObject({
      target: "/export/1/delft/delft.obj",
      download: "delft-obj.zip",
      zip: true,
    });
  });
});

describe("writeSql", () => {
  const plan = planExport([{ table, scope: chunksOf(table) }], request(), 7);

  test("COPYs the union of the local tables with the CRS from the footer", () => {
    const sql = writeSql(plan, { x: 1, y: 2, z: 3 });
    expect(sql).toContain('COPY (SELECT * FROM "delft_centre"."building")');
    expect(sql).toContain("TO '/export/7/delft centre.city.jsonl'");
    expect(sql).toContain("FORMAT cityjsonseq");
    expect(sql).toContain("crs 'https://www.opengis.net/def/crs/EPSG/0/7415'");
    expect(sql).toContain("transform_scale '0.001,0.001,0.01'");
  });

  test("an OBJ names its one LoD and carries no transform", () => {
    const obj = planExport(
      [{ table, scope: chunksOf(table) }],
      request({ format: "obj", tables: [{ name: "building", lods: ["2.2"], attributes: [] }] }),
      7,
    );
    const sql = writeSql(obj, { x: 1, y: 2, z: 3 });
    expect(sql).toContain("FORMAT obj");
    expect(sql).toContain("lod '2.2'");
    expect(sql).not.toContain("transform");
  });

  test("a package is written by cityparquet_write, with the CRS named", () => {
    const pkg = planExport(
      [{ table, scope: chunksOf(table) }],
      request({ format: "cityparquet" }),
      7,
    );
    expect(writeSql(pkg, null)).toBe(
      "SELECT file FROM cityparquet_write('delft_centre', '/export/7/delft centre/', crs => 'EPSG:7415')",
    );
  });

  test("never names the schema after one DuckDB has", () => {
    expect(planExport([{ table, scope: [] }], request({ fileName: "main" }), 1).schema).toBe(
      "subset",
    );
  });
});

test("exportFraction rises through the steps and the parts, and ends below 1", () => {
  const steps = [
    exportFraction({ step: "expanding", done: 0, total: 4 }),
    exportFraction({ step: "expanding", done: 4, total: 4 }),
    exportFraction({ step: "reading", done: 0, total: 0, part: 0, parts: 2 }),
    exportFraction({ step: "reading", done: 1, total: 2, part: 0, parts: 2 }),
    exportFraction({ step: "writing", part: 0, parts: 2 }),
    exportFraction({ step: "reading", done: 0, total: 2, part: 1, parts: 2 }),
    exportFraction({ step: "writing", part: 1, parts: 2 }),
  ];
  expect(steps[0]).toBe(0);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
  expect(steps.at(-1)).toBeLessThan(1);
});
