// One page of a table's selection: the columns shown, sortable, with the page controls.
// Clicking a row marks its footprint on the map and brings it into view; clicking a
// footprint marks its row when it is on the page.
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { fromMercator, kindOf, type PackageTable, type Row, selectionPageSql } from "@/core";
import { withEngine } from "@/engine/session";
import { getMap } from "@/features/map/map";
import { markFeature, usePopup } from "@/features/map/popup";
import { ensureColumns } from "@/features/selection/attributes";
import type { TableSelection } from "@/features/selection/store";
import { formatCount } from "@/features/source/format";
import { cn } from "@/lib/utils";
import { ColumnTypeIcon } from "./ColumnTypeIcon";
import {
  PAGE_SIZES,
  type PageSize,
  setPage,
  setPageSize,
  shownColumns,
  type TableView,
  toggleSort,
} from "./store";

type Ready = Extract<TableSelection, { state: "ready" }>;

type PageRows =
  | { state: "loading"; rows: Row[] }
  | { state: "ready"; rows: Row[] }
  | { state: "failed"; rows: Row[]; message: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reads the page: the shown columns are read for the scope first, if they are not held. */
function usePageRows(selection: Ready, shown: readonly string[], view: TableView): PageRows {
  const [rows, setRows] = useState<PageRows>({ state: "loading", rows: [] });
  const key = shown.join("\u0000");
  // `key` stands for `shown`.
  useEffect(() => {
    const abort = new AbortController();
    setRows((r) => ({ state: "loading", rows: r.rows }));
    const { scope, plan } = selection;
    const page = {
      sort: view.sort,
      limit: view.pageSize,
      offset: view.page * view.pageSize,
    };
    (async () => {
      if (scope.chunks.length === 0) return [];
      await ensureColumns(
        scope.chunks,
        [...shown, ...(view.sort ? [view.sort.column] : [])],
        abort.signal,
      );
      return withEngine((e) => e.query(selectionPageSql(scope.chunks, plan, shown, page)), {
        signal: abort.signal,
      });
    })().then(
      (result) => {
        if (!abort.signal.aborted) setRows({ state: "ready", rows: result });
      },
      (e: unknown) => {
        if (!abort.signal.aborted) setRows({ state: "failed", rows: [], message: message(e) });
      },
    );
    return () => abort.abort();
  }, [selection, key, view.sort, view.page, view.pageSize]);
  return rows;
}

/** Marks the row's footprint, and moves the map to it unless it is in view. */
function goTo(table: string, row: Row, keepZoom: boolean) {
  markFeature({
    uid: Number(row.__uid),
    table,
    file: Number(row.__file),
    row: Number(row.__row),
    id: String(row.__id),
    objectType: String(row.__type ?? ""),
  });
  const map = getMap();
  if (!map) return;
  const [w, s] = fromMercator([Number(row.__xmin), Number(row.__ymin)]);
  const [e, n] = fromMercator([Number(row.__xmax), Number(row.__ymax)]);
  const b = map.getBounds();
  if (w >= b.getWest() && e <= b.getEast() && s >= b.getSouth() && n <= b.getNorth()) return;
  // Zooming would change which row groups a view-wide selection looks at, so it pans.
  if (keepZoom) map.easeTo({ center: [(w + e) / 2, (s + n) / 2], duration: 500 });
  else
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 80, maxZoom: 17, duration: 600 },
    );
}

export function DataGrid({
  table,
  selection,
  view,
}: {
  table: PackageTable;
  selection: Ready;
  view: TableView;
}) {
  const shown = shownColumns(table, view);
  const total = selection.count;
  const pages = Math.max(1, Math.ceil(total / view.pageSize));
  // A new selection can hold fewer pages than the one the view was on.
  const at = Math.min(view.page, pages - 1);
  const page = usePageRows(selection, shown, { ...view, page: at });
  const marked = usePopup((p) => (p.state === "closed" ? null : p.feature));
  const markedRow = useRef<HTMLTableRowElement | null>(null);
  const markedUid = marked?.table === table.name ? marked.uid : null;

  useEffect(() => {
    if (markedUid !== null) markedRow.current?.scrollIntoView({ block: "nearest" });
  }, [markedUid]);

  const types = new Map(table.columns.map((c) => [c.name, c.type]));
  const first = total === 0 ? 0 : at * view.pageSize + 1;
  const last = Math.min(total, (at + 1) * view.pageSize);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto" aria-busy={page.state === "loading"}>
        <table
          aria-label={`${table.name} features`}
          className="w-full table-fixed border-separate border-spacing-0 text-xs"
        >
          <thead className="sticky top-0 z-[1] bg-background">
            <tr>
              {shown.map((name) => {
                const sorted = view.sort?.column === name ? view.sort.direction : null;
                const type = types.get(name) ?? "";
                return (
                  <th
                    key={name}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                    }
                    className="w-40 border-b p-0 text-left font-medium text-foreground"
                  >
                    <button
                      type="button"
                      aria-label={`Sort by ${name}`}
                      title={`${name} (${type}). Click to sort.`}
                      onClick={() => toggleSort(table.name, name)}
                      className="flex w-full items-center gap-1 px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-2"
                    >
                      <ColumnTypeIcon kind={kindOf(type)} type={type} />
                      <span className="truncate">{name}</span>
                      <span aria-hidden="true" className="ml-auto text-muted-foreground">
                        {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => {
              const uid = Number(row.__uid);
              const isMarked = uid === markedUid;
              return (
                <tr
                  key={uid}
                  ref={isMarked ? markedRow : undefined}
                  tabIndex={0}
                  aria-selected={isMarked}
                  onClick={() => goTo(table.name, row, selection.scope.basis === "view")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      goTo(table.name, row, selection.scope.basis === "view");
                    }
                  }}
                  className={cn(
                    "cursor-pointer hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    isMarked && "bg-accent text-accent-foreground",
                  )}
                >
                  {shown.map((name) => {
                    const value = row[name];
                    const text = value === null || value === undefined ? null : String(value);
                    return (
                      <td
                        key={name}
                        title={text ?? "null"}
                        className={cn(
                          "truncate border-b px-2 py-1 tabular-nums",
                          text === null && "text-muted-foreground italic",
                          text !== null && "text-foreground",
                        )}
                      >
                        {text ?? "null"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {page.state === "ready" && page.rows.length === 0 && (
          <p className="p-3 text-xs">No features match this selection.</p>
        )}
        {page.state === "loading" && page.rows.length === 0 && (
          <p role="status" className="p-3 text-xs">
            Loading rows…
          </p>
        )}
        {page.state === "failed" && (
          <Alert variant="destructive" role="alert" className="m-2 w-auto">
            <AlertTitle>The rows could not be read</AlertTitle>
            <AlertDescription className="break-all">{page.message}</AlertDescription>
          </Alert>
        )}
      </div>
      <nav aria-label="Pages" className="flex items-center gap-2 border-t px-2 py-1 text-xs">
        <span className="flex items-center gap-1">
          <span aria-hidden="true">Rows per page</span>
          <NativeSelect
            aria-label="Rows per page"
            value={view.pageSize}
            onChange={(e) => setPageSize(table.name, Number(e.target.value) as PageSize)}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </span>
        <span className="ml-auto tabular-nums" data-testid="page-range">
          {total === 0
            ? "0 rows"
            : `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={at === 0}
          onClick={() => setPage(table.name, at - 1)}
        >
          Previous page
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={at + 1 >= pages}
          onClick={() => setPage(table.name, at + 1)}
        >
          Next page
        </Button>
      </nav>
    </div>
  );
}
