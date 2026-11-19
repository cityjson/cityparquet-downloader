import { beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type Box,
  fileList,
  openPackage,
  type PackageInfo,
  parseSource,
  planBox,
  resolveSource,
  sql,
} from "@/core";
import { getEngine } from "@/engine/session";

/** The extent scripts/make-fixture.py computed with native DuckDB, from metadata.json. */
async function stacBbox(dir: string): Promise<Box> {
  const item = (await (await fetch(`${dir}metadata.json`)).json()) as { bbox: number[] };
  const [xmin = Number.NaN, ymin = Number.NaN, xmax = Number.NaN, ymax = Number.NaN] = item.bbox;
  return { xmin, ymin, xmax, ymax };
}

function expectClose(actual: Box | null, expected: Box) {
  expect(actual).not.toBeNull();
  for (const k of ["xmin", "ymin", "xmax", "ymax"] as const) {
    expect(actual?.[k]).toBeCloseTo(expected[k], 6);
  }
}

async function open(dir: string): Promise<PackageInfo> {
  const source = await resolveSource(parseSource(dir, location.href), (u, i) => fetch(u, i));
  return openPackage(await getEngine(), source);
}

describe("the Delft fixture", () => {
  const dir = new URL("/fixtures/delft/", location.href).href;
  let info: PackageInfo;
  beforeAll(async () => {
    info = await open(dir);
  });

  test("opens as one building table in RD New + NAP, with its LoDs and row groups", () => {
    expect(info.source.listedBy).toBe("metadata");
    expect(info.tables.map((t) => t.name)).toEqual(["building"]);
    const [building] = info.tables;
    expect(building?.rowCount).toBe(748);
    expect(building?.rowGroups).toHaveLength(9);
    expect(building?.lods).toEqual(["0.0", "1.2", "1.3", "2.2"]);
    expect(building?.attributes.map((c) => c.name)).toContain("b3_h_dak_max");
    expect(building?.attributes.map((c) => c.name)).not.toContain("feature_id");
    expect(building?.crs).toMatchObject({
      kind: "known",
      name: "Amersfoort / RD New + NAP height",
      code: { authority: "EPSG", code: "7415" },
      horizontal: { name: "Amersfoort / RD New", code: null },
    });
  });

  test("transforms its extent to the WGS 84 box that native DuckDB computed", async () => {
    expectClose(info.extentWgs84, await stacBbox(dir));
  });

  test("a small box plans fewer row groups, and every row in the box is in one of them", async () => {
    const [building] = info.tables;
    if (!building) throw new Error("no building table");
    const box = { xmin: 84400, ymin: 447190, xmax: 84420, ymax: 447210 };
    const plan = planBox(building.rowGroups, box);
    expect(plan.rowGroups.length).toBeGreaterThan(0);
    expect(plan.rowGroups.length).toBeLessThan(building.rowGroups.length);

    // The row group of every row the box selects, from its position in the file.
    const starts = building.rowGroups.map((_, i) =>
      building.rowGroups.slice(0, i).reduce((n, g) => n + g.rows, 0),
    );
    const rows = await (
      await getEngine()
    ).query(
      sql`SELECT file_row_number AS n FROM read_parquet(${fileList(building.files)},
          file_row_number := true)
          WHERE bbox.xmin <= 84420 AND bbox.xmax >= 84400 AND bbox.ymin <= 447210
            AND bbox.ymax >= 447190`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const groupOf = (n: number) => starts.findLastIndex((s) => s <= n);
    const planned = new Set(plan.rowGroups.map((g) => g.index));
    for (const { n } of rows) expect(planned).toContain(groupOf(Number(n)));
  });
});

describe("the Chuo-ku fixture", () => {
  const dir = new URL("/fixtures/chuo-ku/", location.href).href;
  let info: PackageInfo;
  beforeAll(async () => {
    info = await open(dir);
  });

  test("opens as two tables, each with its own LoDs, in a geographic CRS", () => {
    expect(info.tables.map((t) => [t.name, t.rowCount])).toEqual([
      ["building", 566],
      ["bridge", 75],
    ]);
    expect(info.tables[1]?.lods).toEqual(["1.0", "2.0", "3.0"]);
    for (const t of info.tables) {
      expect(t.crs).toMatchObject({ kind: "known", code: { authority: "EPSG", code: "6697" } });
    }
  });

  test("keeps longitude as x through the transform, whatever axis order EPSG:6697 defines", async () => {
    expectClose(info.extentWgs84, await stacBbox(dir));
  });
});
