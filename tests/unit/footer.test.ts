import { describe, expect, test } from "vite-plus/test";
import { FooterError, parseTable } from "@/core/footer";
import { parseUrl } from "@/core/url";

const A = parseUrl("https://h/p/building.parquet");
const city = (crs: unknown) => JSON.stringify({ version: "0.1.0", crs, columns: [] });
const CRS = { type: "ProjectedCRS", name: "RD", id: { authority: "EPSG", code: 28992 } };

const describeRows = [
  ["id", "VARCHAR"],
  ["feature_id", "VARCHAR"],
  ["object_type", "VARCHAR"],
  ["parents", "VARCHAR[]"],
  ["bbox", "STRUCT(xmin DOUBLE, ymin DOUBLE, zmin DOUBLE, xmax DOUBLE, ymax DOUBLE, zmax DOUBLE)"],
  ["geometry_lod0_0", "GEOMETRY('{}')"],
  ["geometry_properties_lod0_0", 'STRUCT("type" VARCHAR)'],
  ["geometry_lod2_2", "BLOB"],
  ["geometry_lod1_2", "BLOB"],
  ["other", "JSON"],
  ["b3_h_dak_max", "DOUBLE"],
  ["status", "VARCHAR"],
].map(([column_name, column_type]) => ({ column_name, column_type, null: "YES" }));

const group = (index: number, rows: number, box: number[] | null) => ({
  file_name: A,
  row_group_id: index,
  rows,
  bytes: 1000 + index,
  xmin: box?.[0] ?? null,
  ymin: box?.[1] ?? null,
  xmax: box?.[2] ?? null,
  ymax: box?.[3] ?? null,
  columns: [
    { column: "geometry_lod0_0", bytes: 600 },
    { column: "bbox", bytes: 400 + index },
  ],
});

const kv = [
  { file_name: A, key: "city", value: city(CRS) },
  { file_name: A, key: "geo", value: "{}" },
];

describe("parseTable", () => {
  const table = parseTable("building", [A], kv, describeRows, [
    group(0, 100, [10, 20, 30, 40]),
    group(1, 50, [25, 15, 60, 35]),
  ]);

  test("counts rows over the row groups and unions their extents", () => {
    expect(table.rowCount).toBe(150);
    expect(table.extent).toEqual({ xmin: 10, ymin: 15, xmax: 60, ymax: 40 });
    expect(table.rowGroups[1]).toEqual({
      file: A,
      index: 1,
      rows: 50,
      bytes: 1001,
      bbox: { xmin: 25, ymin: 15, xmax: 60, ymax: 35 },
      columnBytes: { geometry_lod0_0: 600, bbox: 401 },
    });
  });

  test("reads the LoDs from the geometry column names, sorted", () => {
    expect(table.lods).toEqual(["0.0", "1.2", "2.2"]);
  });

  test("separates attribute columns from the reserved ones", () => {
    expect(table.attributes).toEqual([
      { name: "b3_h_dak_max", type: "DOUBLE" },
      { name: "status", type: "VARCHAR" },
    ]);
    expect(table.reserved.map((c) => c.name)).toContain("geometry_properties_lod0_0");
    expect(table.reserved.map((c) => c.name)).toContain("other");
    expect(table.columns).toHaveLength(describeRows.length);
  });

  test("keeps the footer and reads the CRS from it", () => {
    expect(table.footer).toEqual({ city: city(CRS), geo: "{}" });
    expect(table.crs.kind === "known" && table.crs.horizontal.definition).toBe("EPSG:28992");
  });

  test("a row group without bbox statistics has no extent, and does not shrink the table's", () => {
    const t = parseTable("building", [A], kv, describeRows, [
      group(0, 10, [0, 0, 1, 1]),
      group(1, 10, null),
    ]);
    expect(t.rowGroups[1]?.bbox).toBeNull();
    expect(t.extent).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
  });

  test("a file without the city footer key is not CityParquet", () => {
    expect(() => parseTable("building", [A], [], describeRows, [])).toThrow(FooterError);
  });
});
