import { describe, expect, test } from "vitest";
import type { RowGroup } from "@/core/footer";
import { planBox } from "@/core/plan";
import { parseUrl } from "@/core/url";

const file = parseUrl("https://h/p/building.parquet");
const group = (index: number, bbox: RowGroup["bbox"]): RowGroup => ({
  file,
  index,
  rows: 100,
  bytes: 1000,
  bbox,
  columnBytes: { id: 100, bbox: 300, geometry_lod0_0: 600 },
});
const rowGroups = [
  group(0, { xmin: 0, ymin: 0, xmax: 10, ymax: 10 }),
  group(1, { xmin: 10, ymin: 0, xmax: 20, ymax: 10 }),
  group(2, { xmin: 50, ymin: 50, xmax: 60, ymax: 60 }),
  group(3, null),
];

describe("planBox", () => {
  test("keeps the row groups whose extent overlaps the box, edges included", () => {
    const plan = planBox(rowGroups, { xmin: 2, ymin: 2, xmax: 10, ymax: 3 });
    expect(plan.rowGroups.map((g) => g.index)).toEqual([0, 1, 3]);
    expect(plan.rows).toBe(300);
  });

  test("keeps a row group with no statistics, since it cannot be ruled out", () => {
    const plan = planBox(rowGroups, { xmin: 100, ymin: 100, xmax: 101, ymax: 101 });
    expect(plan.rowGroups.map((g) => g.index)).toEqual([3]);
  });

  test("estimates the bytes of every column, or of the columns asked for", () => {
    const box = { xmin: 51, ymin: 51, xmax: 52, ymax: 52 };
    expect(planBox(rowGroups, box).bytes).toBe(2000);
    expect(planBox(rowGroups, box, ["id", "geometry_lod0_0"]).bytes).toBe(1400);
  });
});
