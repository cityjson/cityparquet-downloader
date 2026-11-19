// What the map stands on, run on real duckdb-wasm: chunks of footprints read into the local
// table in Web Mercator, vector tiles cut from it, and one feature's attributes fetched back.
import { beforeAll, describe, expect, test } from "vite-plus/test";
import {
  attributesSql,
  type Chunk,
  chunksOf,
  chunkTypesSql,
  createFeaturesSql,
  evictChunkSql,
  FEATURES_TABLE,
  footprintOf,
  loadChunkSql,
  openPackage,
  outlinesSql,
  type PackageTable,
  parseSource,
  resolveSource,
  TILE_LAYER,
  tileSql,
} from "@/core";
import { getEngine, withEngine } from "@/engine/session";

async function table(dir: string, name: string): Promise<PackageTable> {
  const url = new URL(dir, location.href).href;
  const source = await resolveSource(parseSource(url, location.href), (u, i) => fetch(u, i));
  const info = await openPackage(await getEngine(), source);
  const found = info.tables.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} table in ${dir}`);
  return found;
}

const from = (t: PackageTable) => {
  if (t.crs.kind !== "known") throw new Error(`${t.name} has no CRS`);
  return t.crs.horizontal.definition;
};

/** Loads every chunk of `t` with ids from `base`; returns the features per chunk. */
async function loadAll(t: PackageTable, base: number): Promise<number[]> {
  const engine = await getEngine();
  for (const s of createFeaturesSql) await engine.exec(s);
  const counts: number[] = [];
  for (const [i, c] of chunksOf(t).entries()) {
    await engine.exec(loadChunkSql(c, footprintOf(t), from(t), base + i));
    const types = await engine.query(chunkTypesSql(base + i));
    counts.push(types.reduce((n, r) => n + Number(r.n), 0));
  }
  return counts;
}

/** The z/x/y tile that holds a WGS 84 point. */
function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}

describe("the Delft fixture's footprints", () => {
  let building: PackageTable;
  let counts: number[];
  beforeAll(async () => {
    building = await table("/fixtures/delft/", "building");
    counts = await loadAll(building, 100);
  });

  test("fill the local table from LoD 0, one chunk per row group, Building rows only", async () => {
    expect(footprintOf(building)).toEqual({ kind: "lod0", column: "geometry_lod0_0" });
    expect(counts).toHaveLength(9);
    // fixtures/README.md: 373 Building rows, which carry LoD 0, and 375 BuildingPart, which do not.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(373);
    const [row] = await (
      await getEngine()
    ).query(
      `SELECT count(DISTINCT uid) AS uids, min(xmin) AS x, max(ymax) AS y,
              count(*) FILTER (object_type <> 'Building') AS others
       FROM ${FEATURES_TABLE} WHERE chunk >= 100 AND chunk < 109`,
    );
    expect(row?.uids).toBe(373);
    expect(row?.others).toBe(0);
    // Web Mercator metres around Delft (4.36 E, 52.01 N), not RD New.
    expect(row?.x).toBeGreaterThan(484_000);
    expect(row?.x).toBeLessThan(487_000);
    expect(row?.y).toBeGreaterThan(6_800_000);
  });

  test("a chunk's read is its own row group: its rows are numbered within that range", async () => {
    const chunks = chunksOf(building);
    const rows = await (
      await getEngine()
    ).query(
      `SELECT chunk, min("row") AS lo, max("row") AS hi FROM ${FEATURES_TABLE}
       WHERE chunk >= 100 AND chunk < 109 GROUP BY ALL ORDER BY chunk`,
    );
    for (const r of rows) {
      const c = chunks[Number(r.chunk) - 100] as Chunk;
      expect(Number(r.lo)).toBeGreaterThanOrEqual(c.start);
      expect(Number(r.hi)).toBeLessThan(c.start + c.rows);
    }
  });

  test("a tile query returns a non-empty vector tile with the features layer", async () => {
    const engine = await getEngine();
    const tile = tileOf(4.3621, 52.0099, 16);
    const bytes = await engine.queryBytes(tileSql(tile));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes?.length).toBeGreaterThan(1000);
    // Field 3 of a Tile, a length-delimited Layer: tag byte 0x1a. The name is in it.
    expect(bytes?.[0]).toBe(0x1a);
    expect(new TextDecoder().decode(bytes ?? undefined)).toContain(TILE_LAYER);
    // A tile far from Delft holds the layer and no features.
    const empty = await engine.queryBytes(tileSql(tileOf(-70, -30, 16)));
    expect(empty?.length ?? 0).toBeLessThan(64);
  });

  test("an evicted chunk leaves the local table", async () => {
    const engine = await getEngine();
    await engine.exec(evictChunkSql(100));
    expect(await engine.query(chunkTypesSql(100))).toEqual([]);
  });

  test("row-group outlines transform to WGS 84 polygons inside the package extent", async () => {
    const sql = outlinesSql(chunksOf(building), from(building));
    if (!sql) throw new Error("no outlines");
    const rows = await (await getEngine()).query(sql);
    expect(rows).toHaveLength(9);
    const e = building.extentWgs84;
    for (const r of rows) {
      expect(JSON.parse(String(r.outline)).type).toBe("Polygon");
      expect(Number(r.xmin)).toBeGreaterThanOrEqual((e?.xmin ?? 0) - 1e-9);
      expect(Number(r.ymax)).toBeLessThanOrEqual((e?.ymax ?? 0) + 1e-9);
    }
  });

  test("a feature's attributes are fetched by its row and id, without geometry", async () => {
    const engine = await getEngine();
    const [hit] = await engine.query(
      `SELECT file, "row", id FROM ${FEATURES_TABLE} WHERE chunk = 104 ORDER BY uid LIMIT 1`,
    );
    const file = building.files[Number(hit?.file)];
    if (!hit || !file) throw new Error("no loaded feature");
    const [row, more] = await engine.query(attributesSql(building, file, Number(hit.row)));
    expect(more).toBeUndefined();
    expect(row?.id).toBe(hit.id);
    expect(row?.object_type).toBe("Building");
    expect(typeof row?.b3_h_dak_max).toBe("string");
    expect(row).not.toHaveProperty("geometry_lod0_0");
    expect(row).not.toHaveProperty("bbox");
  });
});

describe("the Chuo-ku bridge table, which has no LoD 0", () => {
  test("draws each object's bbox rectangle instead, through the same tiles", async () => {
    const bridge = await table("/fixtures/chuo-ku/", "bridge");
    expect(footprintOf(bridge)).toEqual({ kind: "bbox" });
    expect(await loadAll(bridge, 200)).toEqual([75]);
    const engine = await getEngine();
    const [c] = await engine.query(
      `SELECT ST_X(ST_Centroid(ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', always_xy := true))) AS lon,
              ST_Y(ST_Centroid(ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', always_xy := true))) AS lat,
              ST_NPoints(geom) AS points
       FROM ${FEATURES_TABLE} WHERE chunk = 200 AND object_type = 'Bridge'`,
    );
    expect(c?.points).toBe(5);
    const bytes = await engine.queryBytes(tileSql(tileOf(Number(c?.lon), Number(c?.lat), 17)));
    expect(bytes?.length).toBeGreaterThan(100);
  });
});

describe("withEngine", () => {
  test("runs the more urgent of two waiting jobs first, and drops one aborted before it starts", async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
    };
    const aborted = new AbortController();
    const busy = withEngine(async (e) => e.query("SELECT 1"));
    const background = withEngine(job("background"), { priority: "background" });
    const dropped = withEngine(job("dropped"), { priority: "tile", signal: aborted.signal });
    const tile = withEngine(job("tile"), { priority: "tile" });
    aborted.abort();
    await Promise.all([busy, background, tile, dropped.catch(() => undefined)]);
    await expect(dropped).rejects.toBeDefined();
    expect(order).toEqual(["tile", "background"]);
  });
});
