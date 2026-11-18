// A table's selection in words, for the drawer and the side panel.
import type { CacheEntry, ChunkKey } from "@/core";
import { formatBytes, formatCount } from "@/features/source/format";
import type { TableSelection } from "./store";

const groups = (n: number) => `${formatCount(n)} row ${n === 1 ? "group" : "groups"}`;

/** The footprints the scope's row groups hold, from the map's cache. */
export function featuresInScope(
  selection: Extract<TableSelection, { scope: unknown }>,
  cache: ReadonlyMap<ChunkKey, CacheEntry>,
): number {
  return selection.scope.chunks.reduce((n, { chunk }) => {
    const e = cache.get(chunk.key);
    return n + (e?.state === "ready" ? e.features : 0);
  }, 0);
}

const STEPS = {
  footprints: "Loading the footprints of",
  attributes: "Reading the filter's columns in",
  counting: "Counting the selection in",
} as const;

/** What the scope is and what it holds now: one sentence, and whether it is a problem. */
export function describeScope(
  selection: TableSelection | undefined,
  cache: ReadonlyMap<ChunkKey, CacheEntry>,
): { text: string; problem: boolean } {
  if (!selection) return { text: "Waiting for the map.", problem: false };
  switch (selection.state) {
    case "unavailable":
      return { text: selection.reason, problem: false };
    case "too-large":
      return {
        text: `The scope is ${groups(selection.scope.chunks.length)} with ${formatCount(selection.scope.rows)} rows, about ${formatBytes(selection.readBytes)} to read. The limit is ${formatCount(selection.limit)} rows: draw a smaller area${selection.scope.basis === "extent" ? "" : " or zoom in"}.`,
        problem: true,
      };
    case "loading":
      return {
        text: `${STEPS[selection.step]} ${groups(selection.scope.chunks.length)}…`,
        problem: false,
      };
    case "failed":
      return { text: `The selection failed: ${selection.message}`, problem: true };
    case "ready":
      return {
        text: `Filtering ${formatCount(featuresInScope(selection, cache))} features in ${groups(selection.scope.chunks.length)}${selection.scope.basis === "table" ? " (the whole table)" : selection.scope.basis === "view" ? " in view" : " under the area"}.`,
        problem: false,
      };
  }
}
