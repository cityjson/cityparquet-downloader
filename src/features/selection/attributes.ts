// The attribute columns held locally per row group, for the selection, the table and the
// filter bar's value lists. A column is read once per row group and dropped with the row
// group's footprints when the map evicts them.
import {
  attributeColumns,
  type ChunkKey,
  dropAttrsSql,
  loadAttrsSql,
  type ScopeChunk,
} from "@/core";
import { withEngine } from "@/engine/session";
import { useMapData } from "@/features/map/footprints";

/** Columns each chunk's attribute table holds, by chunk id. */
const held = new Map<number, { key: ChunkKey; columns: string[] }>();

/**
 * Reads whatever of `columns` the chunks do not hold yet, one row group per job, so tiles
 * and clicks run between them. Each job decides what is missing when it runs, so two
 * callers asking for the same column do not read it twice.
 */
export async function ensureColumns(
  chunks: readonly ScopeChunk[],
  columns: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const wanted = attributeColumns(columns);
  if (wanted.length === 0) return;
  for (const c of chunks) {
    if (wanted.every((col) => held.get(c.id)?.columns.includes(col))) continue;
    await withEngine(
      async (engine) => {
        const have = held.get(c.id)?.columns ?? [];
        const missing = wanted.filter((col) => !have.includes(col));
        if (missing.length === 0) return;
        await engine.exec(loadAttrsSql(c, missing, have));
        held.set(c.id, { key: c.chunk.key, columns: [...have, ...missing] });
      },
      { priority: "background", signal },
    );
  }
}

// A chunk the map drops takes its attribute table with it.
useMapData.subscribe(({ cache }, previous) => {
  if (cache === previous.cache) return;
  for (const [id, entry] of held) {
    if (cache.get(entry.key)?.state === "ready") continue;
    if (cache.get(entry.key)?.state === "loading") continue;
    held.delete(id);
    void withEngine((e) => e.exec(dropAttrsSql(id)), { priority: "background" });
  }
});
