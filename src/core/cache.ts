// Which chunks the local footprint table holds. A chunk is absent (no entry), loading,
// ready or failed; this decides what to load and what to drop, and does neither.
import type { Chunk, ChunkKey } from "./chunk";

export type CacheEntry =
  | { state: "loading"; rows: number }
  | {
      state: "ready";
      /** The row group's rows: what the entry counts against the budget. */
      rows: number;
      /** Rows that had a footprint and are in the local table. */
      features: number;
      /** Features per `object_type`. */
      types: Record<string, number>;
      /** When a view last wanted it, for least-recently-used eviction. */
      usedAt: number;
    }
  /** Not retried until the entry is removed. Holds nothing, so it costs no budget. */
  | { state: "failed"; rows: number; message: string };

/** Rows the local table may hold: about nine 3DBAG row groups. */
export const CACHE_ROW_BUDGET = 600_000;

export interface CachePlan {
  load: Chunk[];
  evict: ChunkKey[];
}

/**
 * Loads every wanted chunk that is absent. Then, while the rows held or loading exceed
 * `budget`, evicts the ready chunks the view does not want, least recently used first.
 * What the view wants is never evicted, even when it alone is over budget.
 */
export function planCache(
  entries: ReadonlyMap<ChunkKey, CacheEntry>,
  wanted: readonly Chunk[],
  budget = CACHE_ROW_BUDGET,
): CachePlan {
  const load = wanted.filter((c) => !entries.has(c.key));
  const keep = new Set(wanted.map((c) => c.key));
  let held = load.reduce((n, c) => n + c.rows, 0);
  for (const e of entries.values()) if (e.state !== "failed") held += e.rows;

  const evictable = [...entries]
    .flatMap(([key, e]) => (e.state === "ready" && !keep.has(key) ? [{ key, e }] : []))
    .sort((a, b) => a.e.usedAt - b.e.usedAt);
  const evict: ChunkKey[] = [];
  for (const { key, e } of evictable) {
    if (held <= budget) break;
    evict.push(key);
    held -= e.rows;
  }
  return { load, evict };
}
