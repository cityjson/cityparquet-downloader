// What the map shows of the open package, and the reads behind it. The package's row
// groups are placed on the map from their footer extents; the view decides the regime;
// in the footprint regime each touched row group is loaded once into the local table,
// from which vector tiles are cut.
import { create } from "zustand";
import {
  type Box,
  type CacheEntry,
  type Chunk,
  type ChunkKey,
  chunksOf,
  chunkTypesSql,
  createFeaturesSql,
  evictChunkSql,
  footprintOf,
  loadChunkSql,
  outlinesSql,
  type PackageInfo,
  type PackageTable,
  planCache,
  regimeFor,
  touchedChunks,
} from "@/core";
import { withEngine } from "@/engine/session";

/** A row group's outline in WGS 84, for the overview; `id` is the chunk's position. */
export interface Outline {
  type: "Feature";
  id: number;
  geometry: unknown;
  /** `share` is the row group's density of rows, 0 for the sparsest to 1 for the densest. */
  properties: { table: string; rowGroup: number; rows: number; share: number };
}

export type Layout =
  | { state: "idle" }
  | { state: "placing" }
  | {
      state: "ready";
      /** Every chunk the map can show; a chunk's id is its position here. */
      chunks: readonly Chunk[];
      outlines: { type: "FeatureCollection"; features: Outline[] };
      /** Tables the map cannot place, and why. */
      unmapped: { table: string; reason: string }[];
    }
  | { state: "failed"; message: string };

export type Regime =
  /** No view yet, or nothing placed. */
  | { kind: "none" }
  | { kind: "overview"; touched: readonly Chunk[] }
  | { kind: "footprints"; touched: readonly Chunk[] };

export interface MapData {
  layout: Layout;
  regime: Regime;
  /** The local table's contents, by chunk. Replaced, never mutated. */
  cache: ReadonlyMap<ChunkKey, CacheEntry>;
  /** Counts changes to what is ready; the map reloads its tiles when it moves. */
  generation: number;
}

export const useMapData = create<MapData>(() => ({
  layout: { state: "idle" },
  regime: { kind: "none" },
  cache: new Map(),
  generation: 0,
}));

interface Placed {
  chunks: readonly Chunk[];
  ids: ReadonlyMap<ChunkKey, number>;
  tables: ReadonlyMap<string, PackageTable>;
}

let placed: Placed | null = null;
let view: Box | null = null;
/** Chunks a selection looks at: loaded and kept whatever the view, until unpinned. */
let pinned: readonly Chunk[] = [];
/** Recent chunk loads, newest last, with the time each took once it ran. */
export const loadLog: { chunk: ChunkKey; ms: number }[] = [];

/** Loads queued and not started, which a later view can still call off. */
const queued = new Map<ChunkKey, AbortController>();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function setCache(change: (cache: Map<ChunkKey, CacheEntry>) => void, ready = false) {
  const cache = new Map(useMapData.getState().cache);
  change(cache);
  useMapData.setState((s) => ({ cache, generation: ready ? s.generation + 1 : s.generation }));
}

/** Places the package's row groups on the map, then shows what the current view needs. */
export async function placePackage(info: PackageInfo): Promise<void> {
  useMapData.setState({ layout: { state: "placing" } });
  const unmapped: { table: string; reason: string }[] = [];
  const chunks: Chunk[] = [];
  const features: Outline[] = [];
  try {
    await withEngine(async (engine) => {
      for (const s of createFeaturesSql) await engine.exec(s);
      for (const table of info.tables) {
        if (table.crs.kind !== "known") {
          unmapped.push({ table: table.name, reason: `its CRS is ${table.crs.kind}` });
          continue;
        }
        const own = chunksOf(table);
        const sql = outlinesSql(own, table.crs.horizontal.definition);
        const rows = sql ? await engine.query(sql) : [];
        // Shaded by rows per square degree, on a log scale: small boxes are dense cities.
        const density = (b: Box, rows: number) =>
          Math.log10(1 + rows / Math.max(1e-9, (b.xmax - b.xmin) * (b.ymax - b.ymin)));
        for (const row of rows) {
          const chunk = own[Number(row.i)];
          if (!chunk) continue;
          chunk.wgs84 = {
            xmin: Number(row.xmin),
            ymin: Number(row.ymin),
            xmax: Number(row.xmax),
            ymax: Number(row.ymax),
          };
          features.push({
            type: "Feature",
            id: chunks.length + Number(row.i),
            geometry: JSON.parse(String(row.outline)),
            properties: {
              table: table.name,
              rowGroup: chunk.index,
              rows: chunk.rows,
              share: density(chunk.wgs84, chunk.rows),
            },
          });
        }
        chunks.push(...own);
      }
    });
  } catch (e) {
    useMapData.setState({ layout: { state: "failed", message: message(e) } });
    return;
  }
  const shares = features.map((f) => f.properties.share);
  const [lo, hi] = [Math.min(...shares), Math.max(...shares)];
  for (const f of features)
    f.properties.share = hi > lo ? (f.properties.share - lo) / (hi - lo) : 1;
  pinned = [];
  placed = {
    chunks,
    ids: new Map(chunks.map((c, i) => [c.key, i])),
    tables: new Map(info.tables.map((t) => [t.name, t])),
  };
  useMapData.setState({
    layout: { state: "ready", chunks, outlines: { type: "FeatureCollection", features }, unmapped },
  });
  update();
}

/** The map moved: `box` is the view in WGS 84. */
export function setView(box: Box): void {
  view = box;
  update();
}

/**
 * Keeps these chunks' footprints loaded, in view or not, as a selection needs them. Each
 * call replaces the last; an empty list releases them to the cache's usual eviction.
 */
export function pinChunks(keys: readonly ChunkKey[]): void {
  const at = placed;
  if (!at) return;
  const wanted = new Set(keys);
  pinned = at.chunks.filter((c) => wanted.has(c.key));
  update();
}

/** Forgets failed loads, so the next view tries them again. */
export function retryFailed(): void {
  setCache((cache) => {
    for (const [key, e] of cache) if (e.state === "failed") cache.delete(key);
  });
  update();
}

function update() {
  if (!placed || !view) return;
  const touched = touchedChunks(placed.chunks, view);
  const kind = regimeFor(touched);
  useMapData.setState({ regime: { kind, touched } });
  const wanted = [...new Set([...(kind === "footprints" ? touched : []), ...pinned])];

  // Loads still queued for a view the map has left are called off, and their chunks are
  // absent again.
  const keep = new Set(wanted.map((c) => c.key));
  const dropped = [...queued].filter(([key]) => !keep.has(key));
  for (const [key, abort] of dropped) {
    abort.abort();
    queued.delete(key);
  }
  if (dropped.length > 0)
    setCache((next) => {
      for (const [key] of dropped) next.delete(key);
    });
  if (wanted.length === 0) return;

  const now = Date.now();
  const cache = useMapData.getState().cache;
  const plan = planCache(cache, byCoverage(wanted, view));
  setCache((next) => {
    for (const c of wanted) {
      const e = next.get(c.key);
      if (e?.state === "ready") next.set(c.key, { ...e, usedAt: now });
    }
    for (const key of plan.evict) next.delete(key);
    for (const c of plan.load) next.set(c.key, { state: "loading", rows: c.rows });
  }, plan.evict.length > 0);
  for (const key of plan.evict) {
    const id = placed.ids.get(key);
    if (id !== undefined)
      void withEngine((e) => e.exec(evictChunkSql(id)), { priority: "background" });
  }
  for (const chunk of plan.load) load(chunk);
}

/** The chunks most inside the view first: they show the most for one read. */
function byCoverage(chunks: readonly Chunk[], v: Box): Chunk[] {
  const share = (c: Chunk) => {
    const b = c.wgs84;
    if (!b) return 0;
    const w = Math.min(b.xmax, v.xmax) - Math.max(b.xmin, v.xmin);
    const h = Math.min(b.ymax, v.ymax) - Math.max(b.ymin, v.ymin);
    const area = (b.xmax - b.xmin) * (b.ymax - b.ymin);
    return area > 0 ? (Math.max(0, w) * Math.max(0, h)) / area : 1;
  };
  return [...chunks].sort((a, b) => share(b) - share(a));
}

function load(chunk: Chunk) {
  const at = placed;
  const table = at?.tables.get(chunk.table);
  const id = at?.ids.get(chunk.key);
  if (!at || !table || id === undefined || table.crs.kind !== "known") return;
  const from = table.crs.horizontal.definition;
  const abort = new AbortController();
  queued.set(chunk.key, abort);
  withEngine(
    async (engine) => {
      queued.delete(chunk.key);
      const started = performance.now();
      await engine.exec(loadChunkSql(chunk, footprintOf(table), from, id));
      const rows = await engine.query(chunkTypesSql(id));
      loadLog.push({ chunk: chunk.key, ms: Math.round(performance.now() - started) });
      return rows;
    },
    { priority: "background", signal: abort.signal },
  ).then(
    (rows) => {
      if (placed !== at) return;
      const types: Record<string, number> = {};
      for (const r of rows) types[String(r.object_type)] = Number(r.n);
      const features = Object.values(types).reduce((n, c) => n + c, 0);
      const before = useMapData.getState().cache;
      const view = useMapData.getState().regime;
      const touched = view.kind === "none" ? [] : view.touched;
      // Every refresh re-cuts every tile in view, which costs as much as a load. So the
      // tiles are refreshed for the first footprints in view, and once all have loaded.
      const first = !touched.some((c) => before.get(c.key)?.state === "ready");
      const last = ![...before].some(([k, e]) => k !== chunk.key && e.state === "loading");
      setCache((cache) => {
        cache.set(chunk.key, {
          state: "ready",
          rows: chunk.rows,
          features,
          types,
          usedAt: Date.now(),
        });
      }, first || last);
    },
    (e: unknown) => {
      // Called off: update() has already made it absent.
      if (abort.signal.aborted || placed !== at) return;
      queued.delete(chunk.key);
      setCache((cache) => {
        cache.set(chunk.key, { state: "failed", rows: chunk.rows, message: message(e) });
      });
    },
  );
}
