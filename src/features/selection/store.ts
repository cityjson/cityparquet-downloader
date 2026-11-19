// The applied selection of every table, evaluated. Inputs: the drawn area, each table's
// applied filter, the legend's hidden types and the map's view. For each table the store
// compiles the selection, keeps its scope's footprints loaded, reads the attribute columns
// its filter needs, counts what it holds and writes it to `selection_rows`.
//
// For the download, read `useSelection`:
//
//   extent    the drawn area in WGS 84, or null
//   filters   the applied filter per table (absent: none)
//   tables    per table, a TableSelection: `ready` carries `selection` (the Selection),
//             `scope` (its row groups, as `{ chunk, id }`, each chunk with its `file`,
//             `fileIndex`, `index`, `start` and `rows`) and `count`
//   active    whether an area or a filter narrows anything (the map dims the rest)
//   revision  bumps each time `selection_rows` is rewritten
//
// and `materialiseSelection()`, which waits until every table is evaluated and returns the
// row count per table now in `selection_rows (tbl VARCHAR, file INTEGER, row BIGINT)`:
// `file` is the position in the table's `files`, `row` the `file_row_number` in it.
import { create } from "zustand";
import {
  type ChunkKey,
  compileSelection,
  type Extent,
  estimateBytes,
  type Filter,
  footprintOf,
  materialiseSql,
  type PackageTable,
  type Scope,
  type ScopeChunk,
  type Selection,
  type SelectionPlan,
  scopeRowGroups,
  selectionCountSql,
} from "@/core";
import { withEngine } from "@/engine/session";
import { pinChunks, useMapData } from "@/features/map/footprints";
import { hiddenIn, useLegend } from "@/features/map/legend";
import { usePackage } from "@/features/source/store";
import { ensureColumns } from "./attributes";

export type ReadyPlan = Extract<SelectionPlan, { kind: "ready" }>;

export type TableSelection =
  /** Nothing can be selected now, and why: the table is not on the map, or the view is too wide. */
  | { state: "unavailable"; reason: string }
  /** The scope holds more rows than the limit; `readBytes` is what looking at it would read. */
  | { state: "too-large"; selection: Selection; scope: Scope; limit: number; readBytes: number }
  | {
      state: "loading";
      selection: Selection;
      scope: Scope;
      step: "footprints" | "attributes" | "counting";
    }
  | {
      state: "ready";
      selection: Selection;
      scope: Scope;
      plan: ReadyPlan;
      count: number;
    }
  | { state: "failed"; selection: Selection; scope: Scope; message: string };

export interface SelectionState {
  extent: Extent | null;
  filters: Readonly<Record<string, Filter>>;
  tables: Readonly<Record<string, TableSelection>>;
  active: boolean;
  revision: number;
}

export const useSelection = create<SelectionState>(() => ({
  extent: null,
  filters: {},
  tables: {},
  active: false,
  revision: 0,
}));

const isActive = (s: Pick<SelectionState, "extent" | "filters">) =>
  s.extent !== null || Object.keys(s.filters).length > 0;

export function setExtent(extent: Extent | null): void {
  useSelection.setState((s) => ({ extent, active: isActive({ ...s, extent }) }));
}

/** Applies a table's filter; null removes it. */
export function applyFilter(table: string, filter: Filter | null): void {
  useSelection.setState((s) => {
    const filters = { ...s.filters };
    if (filter) filters[table] = filter;
    else delete filters[table];
    return { filters, active: isActive({ ...s, filters }) };
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Resolves with the keys that failed once every key is ready or failed, or when aborted. */
function chunksLoaded(keys: readonly ChunkKey[], signal: AbortSignal): Promise<ChunkKey[]> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const check = () => {
      const cache = useMapData.getState().cache;
      const states = keys.map((k) => cache.get(k)?.state);
      if (!signal.aborted && !states.every((s) => s === "ready" || s === "failed")) return;
      unsubscribe();
      signal.removeEventListener("abort", check);
      resolve(keys.filter((_, i) => states[i] === "failed"));
    };
    unsubscribe = useMapData.subscribe(check);
    signal.addEventListener("abort", check);
    check();
  });
}

interface Planned {
  table: PackageTable;
  selection: Selection;
  plan: ReadyPlan;
}

/** What the last evaluation was for; an unchanged one is not evaluated again. */
let evaluated = "";
let running: AbortController | null = null;
let settled: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    settled = evaluate();
  }, 100);
}

function plan(): {
  tables: Record<string, TableSelection>;
  planned: Planned[];
  key: string;
} | null {
  const pkg = usePackage.getState();
  const { layout, regime } = useMapData.getState();
  if (pkg.state !== "ready" || layout.state !== "ready") return null;
  const { extent, filters } = useSelection.getState();
  const legend = useLegend.getState();
  const inView = new Set((regime.kind === "none" ? [] : regime.touched).map((c) => c.key));
  const tables: Record<string, TableSelection> = {};
  const planned: Planned[] = [];
  const keys: unknown[] = [];
  for (const table of pkg.info.tables) {
    const unmapped = layout.unmapped.find((u) => u.table === table.name);
    if (unmapped) {
      tables[table.name] = {
        state: "unavailable",
        reason: `It is not on the map, because ${unmapped.reason}.`,
      };
      continue;
    }
    const chunks: ScopeChunk[] = layout.chunks.flatMap((chunk, id) =>
      chunk.table === table.name ? [{ chunk, id }] : [],
    );
    const view = chunks.filter((c) => inView.has(c.chunk.key));
    const selection: Selection = {
      table: table.name,
      extent,
      filter: filters[table.name] ?? null,
      hiddenTypes: hiddenIn(table.name, legend),
    };
    const compiled = compileSelection(selection, table, chunks, view);
    keys.push([selection, compiled.kind, compiled.scope.chunks.map((c) => c.id)]);
    if (compiled.kind === "too-large") {
      const footprint = footprintOf(table);
      const read = [
        footprint.kind === "lod0" ? footprint.column : "bbox",
        "id",
        "feature_id",
        "object_type",
      ];
      tables[table.name] = {
        state: "too-large",
        selection,
        scope: compiled.scope,
        limit: compiled.limit,
        readBytes: estimateBytes(
          scopeRowGroups(table.rowGroups, compiled.scope.chunks),
          compiled.scope.rows,
          read,
        ),
      };
    } else if (compiled.scope.basis === "view" && regime.kind !== "footprints") {
      // Without an area, a large table's scope is what the map shows; zoomed out, nothing.
      tables[table.name] = {
        state: "unavailable",
        reason: "Zoom in until footprints show, or draw an area.",
      };
    } else {
      tables[table.name] = {
        state: "loading",
        selection,
        scope: compiled.scope,
        step: "footprints",
      };
      planned.push({ table, selection, plan: compiled });
    }
  }
  return { tables, planned, key: JSON.stringify(keys) };
}

async function evaluate(): Promise<void> {
  const next = plan();
  if (!next || next.key === evaluated) return;
  evaluated = next.key;
  running?.abort();
  const abort = new AbortController();
  running = abort;
  const { signal } = abort;
  pinChunks(next.planned.flatMap((p) => p.plan.scope.chunks.map((c) => c.chunk.key)));
  useSelection.setState({ tables: next.tables });

  const set = (name: string, state: TableSelection) => {
    if (!signal.aborted) useSelection.setState((s) => ({ tables: { ...s.tables, [name]: state } }));
  };
  try {
    for (const name of Object.keys(next.tables)) {
      if (next.planned.some((p) => p.table.name === name)) continue;
      await withEngine(
        async (engine) => {
          for (const s of materialiseSql(name, [], null)) await engine.exec(s);
        },
        { signal },
      );
    }
    for (const { table, selection, plan } of next.planned) {
      const { scope } = plan;
      const failed = await chunksLoaded(
        scope.chunks.map((c) => c.chunk.key),
        signal,
      );
      if (signal.aborted) return;
      if (failed.length > 0) {
        // Forget what was evaluated, so the next change tries again.
        evaluated = "";
        set(table.name, {
          state: "failed",
          selection,
          scope,
          message: `${failed.length} of its row groups did not load. Try again from the View section.`,
        });
        continue;
      }
      set(table.name, { state: "loading", selection, scope, step: "attributes" });
      await ensureColumns(scope.chunks, plan.columns, signal);
      set(table.name, { state: "loading", selection, scope, step: "counting" });
      const count = await withEngine(
        async (engine) => {
          for (const s of materialiseSql(table.name, scope.chunks, plan)) await engine.exec(s);
          if (scope.chunks.length === 0) return 0;
          const [row] = await engine.query(selectionCountSql(scope.chunks, plan));
          return Number(row?.n ?? 0);
        },
        { signal },
      );
      set(table.name, {
        state: "ready",
        selection,
        scope,
        plan,
        count,
      });
    }
    if (!signal.aborted) useSelection.setState((s) => ({ revision: s.revision + 1 }));
  } catch (e) {
    if (signal.aborted) return;
    // Forget what was evaluated, so the next change tries again.
    evaluated = "";
    for (const p of next.planned) {
      const s = useSelection.getState().tables[p.table.name];
      if (s?.state === "loading") {
        set(p.table.name, {
          state: "failed",
          selection: p.selection,
          scope: p.plan.scope,
          message: message(e),
        });
      }
    }
    useSelection.setState((s) => ({ revision: s.revision + 1 }));
  }
}

/**
 * Waits until every table's selection is evaluated, then returns the rows each holds in
 * `selection_rows`. A table that is not `ready` holds none.
 */
export async function materialiseSelection(): Promise<Record<string, number>> {
  for (;;) {
    const before = settled;
    await before;
    if (timer === undefined && settled === before) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const counts: Record<string, number> = {};
  for (const [name, t] of Object.entries(useSelection.getState().tables)) {
    counts[name] = t.state === "ready" ? t.count : 0;
  }
  return counts;
}

/** Retries a failed selection: the map's failed loads first, then the evaluation. */
export function retrySelection(): void {
  evaluated = "";
  schedule();
}

// Re-evaluate when an input changes. An unchanged plan (a pan within the same row groups)
// stops at the key check, so it costs no query.
useSelection.subscribe((s, p) => {
  if (s.extent !== p.extent || s.filters !== p.filters) schedule();
});
useLegend.subscribe((s, p) => {
  if (s.hidden !== p.hidden) schedule();
});
useMapData.subscribe((s, p) => {
  if (s.layout !== p.layout || s.regime !== p.regime) schedule();
});
usePackage.subscribe(() => schedule());
