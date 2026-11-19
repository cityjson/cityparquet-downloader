// The table drawer's state, per object table: the filter being edited (a draft, applied
// only with Apply), the columns shown, the sort and the page. Applying hands the parsed
// filter to the selection store, which owns what is selected.
import { create } from "zustand";
import {
  type DraftCondition,
  type DraftFilter,
  EMPTY_DRAFT,
  kindOf,
  operatorsFor,
  type PackageTable,
  parseFilter,
  popupColumns,
} from "@/core";
import { applyFilter } from "@/features/selection/store";

export const PAGE_SIZES = [20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface Sort {
  column: string;
  direction: "asc" | "desc";
}

export interface TableView {
  draft: DraftFilter;
  /** Why each condition of the last Apply was refused, by condition id. */
  errors: Readonly<Record<string, string>>;
  /** Columns shown; null is the default set. */
  shown: readonly string[] | null;
  sort: Sort | null;
  page: number;
  pageSize: PageSize;
}

const DEFAULT_VIEW: TableView = {
  draft: EMPTY_DRAFT,
  errors: {},
  shown: null,
  sort: null,
  page: 0,
  pageSize: 20,
};

interface TableState {
  /** The tab open in the drawer; null until the package opens. */
  tab: string | null;
  open: boolean;
  views: Readonly<Record<string, TableView>>;
}

export const useTables = create<TableState>(() => ({ tab: null, open: true, views: {} }));

export const viewOf = (s: TableState, table: string): TableView => s.views[table] ?? DEFAULT_VIEW;

function patch(table: string, change: (v: TableView) => Partial<TableView>) {
  useTables.setState((s) => {
    const view = viewOf(s, table);
    return { views: { ...s.views, [table]: { ...view, ...change(view) } } };
  });
}

/** Every column the table can show or filter on, reserved ones first, then attributes. */
export function tableColumns(table: PackageTable): { name: string; type: string }[] {
  const names = new Set(popupColumns(table));
  const reserved = table.reserved.filter((c) => names.has(c.name));
  const attributes = table.attributes.filter((c) => names.has(c.name));
  return [...reserved, ...attributes];
}

/** Columns shown before the user chooses: the ids and type, then the first attributes. */
export function defaultColumns(table: PackageTable): string[] {
  const reserved = ["id", "object_type"].filter((n) => table.columns.some((c) => c.name === n));
  return [...reserved, ...table.attributes.slice(0, 8).map((c) => c.name)];
}

export function shownColumns(table: PackageTable, view: TableView): string[] {
  const all = tableColumns(table).map((c) => c.name);
  const shown = new Set(view.shown ?? defaultColumns(table));
  return all.filter((c) => shown.has(c));
}

export const setTab = (tab: string) => useTables.setState({ tab });
export const setOpen = (open: boolean) => useTables.setState({ open });

export const setDraft = (table: string, draft: DraftFilter) => patch(table, () => ({ draft }));

let nextId = 0;

/** A new condition on the first column, with that column's first operator. */
export function addCondition(table: PackageTable): void {
  const column = tableColumns(table)[0];
  if (!column) return;
  const condition: DraftCondition = {
    id: `c${nextId++}`,
    column: column.name,
    op: operatorsFor(kindOf(column.type))[0]?.op ?? "isNull",
    value: "",
    value2: "",
  };
  patch(table.name, (v) => ({
    draft: { ...v.draft, conditions: [...v.draft.conditions, condition] },
  }));
}

/** Parses the draft; applies it when every condition is valid, else keeps the errors. */
export function applyDraft(table: PackageTable): void {
  const view = viewOf(useTables.getState(), table.name);
  const parsed = parseFilter(view.draft, table.columns);
  if (!parsed.ok) {
    patch(table.name, () => ({
      errors: Object.fromEntries(parsed.errors.map((e) => [e.id, e.message])),
    }));
    return;
  }
  patch(table.name, () => ({ errors: {}, page: 0 }));
  applyFilter(table.name, parsed.filter);
}

export function clearFilter(table: string): void {
  patch(table, () => ({ draft: EMPTY_DRAFT, errors: {}, page: 0 }));
  applyFilter(table, null);
}

/** A header click: the same column flips direction, then clears; a new one sorts ascending. */
export function toggleSort(table: string, column: string): void {
  patch(table, (v) => ({
    page: 0,
    sort:
      v.sort?.column !== column
        ? { column, direction: "asc" }
        : v.sort.direction === "asc"
          ? { column, direction: "desc" }
          : null,
  }));
}

export const setPage = (table: string, page: number) =>
  patch(table, () => ({ page: Math.max(0, page) }));

export const setPageSize = (table: string, pageSize: PageSize) =>
  patch(table, () => ({ pageSize, page: 0 }));

export const setShown = (table: string, shown: readonly string[] | null) =>
  patch(table, () => ({ shown }));
