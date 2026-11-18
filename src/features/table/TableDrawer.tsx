// The drawer below the map: one tab per object table, each with its filter bar, the grid
// of what its selection holds and the page controls. Its height follows the handle on
// its top edge, by pointer or by the arrow keys.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PackageTable } from "@/core";
import { useMapData } from "@/features/map/footprints";
import { describeScope } from "@/features/selection/describe";
import { retrySelection, useSelection } from "@/features/selection/store";
import { usePackage } from "@/features/source/store";
import { cn } from "@/lib/utils";
import { ColumnsPanel } from "./ColumnsPanel";
import { DataGrid } from "./DataGrid";
import { FilterBar } from "./FilterBar";
import { setOpen, setTab, useTables, viewOf } from "./store";

const MIN_HEIGHT = 160;
/** Half the window, so the grid keeps rows below an open filter bar; at least 280 pixels. */
const defaultHeight = () => Math.max(280, Math.round(window.innerHeight * 0.5));

function TablePane({ table }: { table: PackageTable }) {
  const view = useTables((s) => viewOf(s, table.name));
  const selection = useSelection((s) => s.tables[table.name]);
  const cache = useMapData((s) => s.cache);
  const scope = describeScope(selection, cache);
  const chunks = selection && "scope" in selection ? selection.scope.chunks : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
        <p
          role={scope.problem ? "alert" : "status"}
          data-testid="table-scope"
          className={cn("min-w-0 flex-1 truncate", scope.problem && "text-destructive")}
          title={scope.text}
        >
          {scope.text}
        </p>
        {selection?.state === "failed" && (
          <Button size="xs" variant="outline" onClick={retrySelection}>
            Try again
          </Button>
        )}
        <ColumnsPanel table={table} view={view} />
      </div>
      <FilterBar table={table} view={view} scope={chunks} />
      {selection?.state === "ready" ? (
        <DataGrid table={table} selection={selection} view={view} />
      ) : (
        <p className="p-3 text-xs">
          {selection?.state === "loading"
            ? "Rows show once the selection is counted."
            : "No rows to show."}
        </p>
      )}
    </div>
  );
}

export function TableDrawer() {
  const pkg = usePackage();
  const { tab, open } = useTables();
  const [height, setHeight] = useState(defaultHeight);
  const drawer = useRef<HTMLElement | null>(null);
  const tables = pkg.state === "ready" ? pkg.info.tables : [];
  const active = tables.some((t) => t.name === tab) ? tab : (tables[0]?.name ?? null);

  useEffect(() => {
    if (active && active !== tab) setTab(active);
  }, [active, tab]);

  if (tables.length === 0 || !active) return null;

  const maxHeight = () =>
    Math.max(MIN_HEIGHT, (drawer.current?.parentElement?.clientHeight ?? 800) - 160);
  const clamp = (h: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, h)));

  if (!open) {
    return (
      <div className="flex items-center gap-2 border-t bg-background px-2 py-1">
        <Button
          size="xs"
          variant="outline"
          aria-expanded={false}
          aria-controls="feature-table"
          onClick={() => setOpen(true)}
        >
          Show table
        </Button>
      </div>
    );
  }

  return (
    <section
      ref={drawer}
      id="feature-table"
      aria-label="Feature table"
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={{ height }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a resize handle; <hr> cannot take focus. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the table"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maxHeight()}
        tabIndex={0}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize focus-visible:bg-ring/40 hover:bg-ring/20"
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setHeight((h) => clamp(h + 40));
          else if (e.key === "ArrowDown") setHeight((h) => clamp(h - 40));
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          const startY = e.clientY;
          const startHeight = height;
          const target = e.currentTarget;
          target.setPointerCapture(e.pointerId);
          const move = (m: PointerEvent) => setHeight(clamp(startHeight + startY - m.clientY));
          const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", up);
        }}
      />
      <Tabs value={active} onValueChange={setTab} className="min-h-0 flex-1">
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <h2 className="text-xs font-medium">Features</h2>
          <TabsList aria-label="Tables">
            {tables.map((t) => (
              <TabsTrigger key={t.name} value={t.name}>
                {t.name}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            aria-expanded={true}
            aria-controls="feature-table"
            onClick={() => setOpen(false)}
          >
            Hide table
          </Button>
        </div>
        {tables.map((t) => (
          <TabsContent key={t.name} value={t.name}>
            <TablePane table={t} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
