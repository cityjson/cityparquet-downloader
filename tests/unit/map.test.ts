import { describe, expect, test } from "vite-plus/test";
import { type CacheEntry, planCache } from "@/core/cache";
import { type Chunk, chunksOf, regimeFor, touchedChunks } from "@/core/chunk";
import { colourOf, OBJECT_TYPE_COLOURS } from "@/core/colour";
import { footprintOf, popupColumns } from "@/core/features";
import type { RowGroup } from "@/core/footer";
import { parseTileUrl, TILE_URL, tileEnvelope, WEB_MERCATOR_HALF } from "@/core/tile";
import { parseUrl } from "@/core/url";

describe("tileEnvelope", () => {
  test("tile 0/0/0 is the whole Web Mercator square", () => {
    expect(tileEnvelope({ z: 0, x: 0, y: 0 })).toEqual({
      xmin: -WEB_MERCATOR_HALF,
      ymin: -WEB_MERCATOR_HALF,
      xmax: WEB_MERCATOR_HALF,
      ymax: WEB_MERCATOR_HALF,
    });
  });

  test("y counts down from the north edge, as in XYZ tiles", () => {
    expect(tileEnvelope({ z: 1, x: 0, y: 0 })).toEqual({
      xmin: -WEB_MERCATOR_HALF,
      ymin: 0,
      xmax: 0,
      ymax: WEB_MERCATOR_HALF,
    });
    const e = tileEnvelope({ z: 1, x: 1, y: 1 });
    expect([e.xmin, e.ymin, e.xmax, e.ymax]).toEqual([0, -WEB_MERCATOR_HALF, WEB_MERCATOR_HALF, 0]);
  });

  test("the tile URL round-trips its z, x and y", () => {
    const url = TILE_URL.replace("{z}", "16").replace("{x}", "33561").replace("{y}", "21661");
    expect(parseTileUrl(url)).toEqual({ z: 16, x: 33561, y: 21661 });
    expect(() => parseTileUrl("cityparquet://tiles/a/b/c")).toThrow();
  });
});

const file = parseUrl("https://h/p/building.parquet");
const other = parseUrl("https://h/p/part/building.parquet");
const group = (f: typeof file, index: number, rows: number, bbox: RowGroup["bbox"]): RowGroup => ({
  file: f,
  index,
  rows,
  bytes: 0,
  bbox,
  columnBytes: {},
});

describe("chunksOf", () => {
  test("numbers each row group's first row from the row groups before it in the same file", () => {
    const box = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
    const chunks = chunksOf({
      name: "building",
      files: [file, other],
      rowGroups: [group(file, 1, 20, box), group(other, 0, 5, null), group(file, 0, 10, box)],
    });
    expect(chunks.map((c) => [c.fileIndex, c.index, c.start, c.rows])).toEqual([
      [0, 0, 0, 10],
      [0, 1, 10, 20],
      [1, 0, 0, 5],
    ]);
    expect(new Set(chunks.map((c) => c.key)).size).toBe(3);
  });
});

const chunk = (index: number, rows: number, wgs84: Chunk["wgs84"]): Chunk => ({
  key: `building|${index}` as Chunk["key"],
  table: "building",
  file,
  fileIndex: 0,
  index,
  start: 0,
  rows,
  bbox: null,
  wgs84,
});

describe("touchedChunks and regimeFor", () => {
  const view = { xmin: 4, ymin: 52, xmax: 4.1, ymax: 52.1 };
  test("a chunk is touched when its WGS 84 box overlaps the view, or when it has none", () => {
    const touched = touchedChunks(
      [
        chunk(0, 1, { xmin: 4.05, ymin: 52.05, xmax: 5, ymax: 53 }),
        chunk(1, 1, { xmin: 5, ymin: 52, xmax: 6, ymax: 53 }),
        chunk(2, 1, null),
      ],
      view,
    );
    expect(touched.map((c) => c.index)).toEqual([0, 2]);
  });

  test("footprints for at most the limit of row groups, or few rows; else the overview", () => {
    const big = (n: number) => Array.from({ length: n }, () => ({ rows: 65_536 }));
    const small = (n: number) => Array.from({ length: n }, () => ({ rows: 100 }));
    expect(regimeFor([], 4, 1000)).toBe("overview");
    expect(regimeFor(big(4), 4, 1000)).toBe("footprints");
    expect(regimeFor(big(5), 4, 1000)).toBe("overview");
    expect(regimeFor(small(9), 4, 1000)).toBe("footprints");
    expect(regimeFor(small(11), 4, 1000)).toBe("overview");
  });
});

describe("planCache", () => {
  const ready = (rows: number, usedAt: number): CacheEntry => ({
    state: "ready",
    rows,
    features: rows,
    types: {},
    usedAt,
  });
  const c = (i: number, rows = 10) => chunk(i, rows, null);
  const key = (i: number) => c(i).key;

  test("loads the wanted chunks that are absent, and nothing that is loading, ready or failed", () => {
    const entries = new Map<Chunk["key"], CacheEntry>([
      [key(1), { state: "loading", rows: 10 }],
      [key(2), ready(10, 1)],
      [key(3), { state: "failed", rows: 10, message: "x" }],
    ]);
    const plan = planCache(entries, [c(0), c(1), c(2), c(3)], 1000);
    expect(plan.load.map((x) => x.index)).toEqual([0]);
    expect(plan.evict).toEqual([]);
  });

  test("over budget, evicts the least recently used ready chunks that are not wanted", () => {
    const entries = new Map<Chunk["key"], CacheEntry>([
      [key(1), ready(10, 30)],
      [key(2), ready(10, 10)],
      [key(3), ready(10, 20)],
      [key(4), ready(10, 5)],
    ]);
    // Wanted: 4 (ready, oldest but in view) and 5 (absent). 50 rows against a budget of 30.
    const plan = planCache(entries, [c(4), c(5)], 30);
    expect(plan.load.map((x) => x.index)).toEqual([5]);
    expect(plan.evict).toEqual([key(2), key(3)]);
  });

  test("never evicts what the view wants, even when that alone is over budget", () => {
    const entries = new Map<Chunk["key"], CacheEntry>([[key(1), ready(50, 1)]]);
    const plan = planCache(entries, [c(1, 50), c(2, 50)], 30);
    expect(plan.evict).toEqual([]);
    expect(plan.load.map((x) => x.index)).toEqual([2]);
  });
});

describe("colourOf", () => {
  test("a CityJSON type has its registered colour", () => {
    expect(colourOf("Building")).toBe(OBJECT_TYPE_COLOURS.Building);
    expect(colourOf("Bridge")).toBe(OBJECT_TYPE_COLOURS.Bridge);
  });

  test("an unknown or extension type gets a fallback that is the same every time", () => {
    const a = colourOf("+NoiseBarrier");
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
    expect(colourOf("+NoiseBarrier")).toBe(a);
    expect(Object.values(OBJECT_TYPE_COLOURS)).not.toContain(colourOf("+Other"));
  });
});

describe("footprintOf and popupColumns", () => {
  test("footprints come from the lowest LoD 0 column, else from bbox rectangles", () => {
    expect(footprintOf({ lods: ["0.0", "0.2", "2.2"] })).toEqual({
      kind: "lod0",
      column: "geometry_lod0_0",
    });
    expect(footprintOf({ lods: ["1.0", "2.0"] })).toEqual({ kind: "bbox" });
  });

  test("the popup shows ids, hierarchy and attributes, and no geometry or appearance", () => {
    const names = [
      "id",
      "feature_id",
      "object_type",
      "parents",
      "bbox",
      "geometry_lod0_0",
      "geometry_properties_lod0_0",
      "material_lod0_0",
      "texture_lod0_0",
      "implicit_geometry",
      "other",
      "b3_h_dak_max",
    ];
    const columns = names.map((name) => ({ name, type: "VARCHAR" }));
    expect(popupColumns({ columns, lods: ["0.0"] })).toEqual([
      "id",
      "feature_id",
      "object_type",
      "parents",
      "other",
      "b3_h_dak_max",
    ]);
  });
});
