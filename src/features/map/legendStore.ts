// The legend: the city object types seen in loaded footprints, per table, and which of
// them the user has hidden. Hidden types are off the map, and the selection leaves them
// out too (`hiddenIn`).
import { create } from "zustand";
import { useMapData } from "./footprints";

export interface LegendData {
  /** Object types seen in loaded footprints, per table, in the order first seen. */
  seen: Readonly<Record<string, readonly string[]>>;
  /** Keys from `legendKey`: a whole table, or one type of one table. */
  hidden: ReadonlySet<string>;
}

export const useLegend = create<LegendData>(() => ({ seen: {}, hidden: new Set() }));

/** `table` for the whole table, `table/type` for one object type in it. */
export const legendKey = (table: string, type?: string) =>
  type === undefined ? table : `${table}/${type}`;

export function isShown(hidden: ReadonlySet<string>, table: string, type?: string): boolean {
  return !hidden.has(table) && (type === undefined || !hidden.has(legendKey(table, type)));
}

/** What a table's selection leaves out: all of it, or these object types. */
export function hiddenIn(
  table: string,
  { hidden, seen }: LegendData = useLegend.getState(),
): { all: boolean; types: string[] } {
  return {
    all: hidden.has(table),
    types: (seen[table] ?? []).filter((t) => hidden.has(legendKey(table, t))),
  };
}

export function toggleLegend(key: string): void {
  useLegend.setState(({ hidden }) => {
    const next = new Set(hidden);
    if (!next.delete(key)) next.add(key);
    return { hidden: next };
  });
}

// Types stay listed once seen, so the legend does not jump when a chunk is evicted.
useMapData.subscribe(({ cache }, previous) => {
  if (cache === previous.cache) return;
  const seen: Record<string, string[]> = { ...useLegend.getState().seen } as Record<
    string,
    string[]
  >;
  let changed = false;
  const { layout } = useMapData.getState();
  if (layout.state !== "ready") return;
  const tableOf = new Map(layout.chunks.map((c) => [c.key, c.table]));
  for (const [key, e] of cache) {
    const table = tableOf.get(key);
    if (e.state !== "ready" || !table) continue;
    for (const type of Object.keys(e.types)) {
      if (seen[table]?.includes(type)) continue;
      seen[table] = [...(seen[table] ?? []), type];
      changed = true;
    }
  }
  if (changed) useLegend.setState({ seen });
});
