// A table's selection in words, for the drawer and the side panel.
import type { CacheEntry, ChunkKey } from "@/core";
import { formatCount } from "@/features/source/format";
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

/** The scope's row groups whose footprints the map holds. */
const loaded = (
  selection: Extract<TableSelection, { scope: unknown }>,
  cache: ReadonlyMap<ChunkKey, CacheEntry>,
): number =>
  selection.scope.chunks.filter(({ chunk }) => cache.get(chunk.key)?.state === "ready").length;

const STEPS = {
  footprints: "Loading the footprints of",
  attributes: "Reading the filter's columns in",
  counting: "Counting the selection in",
} as const;

const SCOPE = {
  table: () => "the whole table",
  view: (g: string) => `the ${g} in view`,
  extent: (g: string) => `the ${g} under the area`,
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
    case "loading":
      return {
        text: `${STEPS[selection.step]} ${groups(selection.scope.chunks.length)}${selection.step === "footprints" ? `, ${formatCount(loaded(selection, cache))} loaded` : ""}…`,
        problem: false,
      };
    case "failed":
      return { text: `Could not count the selection: ${selection.message}`, problem: true };
    case "ready":
      return {
        text: `Selecting from ${formatCount(featuresInScope(selection, cache))} features in ${SCOPE[selection.scope.basis](groups(selection.scope.chunks.length))}.`,
        problem: false,
      };
  }
}
