// The selection in the side panel: the area, and per table what is selected.
import { useMapData } from "@/features/map/footprints";
import { formatCount } from "@/features/source/format";
import { usePackage } from "@/features/source/store";
import { describeScope, featuresInScope } from "./describe";
import { useSelection } from "./store";

export function SelectionSummary() {
  const pkg = usePackage();
  const { extent, filters, tables } = useSelection();
  const cache = useMapData((s) => s.cache);
  if (pkg.state !== "ready") return null;
  return (
    <section aria-labelledby="selection-heading" className="flex flex-col gap-2">
      <h2 id="selection-heading">Selection</h2>
      <p className="text-xs" data-testid="selection-area">
        {extent
          ? `Area: drawn, ${extent.ring.length} corners.`
          : "Area: none. Draw one on the map, or filter the table below."}
      </p>
      <ul className="flex flex-col gap-1.5">
        {pkg.info.tables.map((t) => {
          const s = tables[t.name];
          const filtered = filters[t.name] !== undefined;
          return (
            <li key={t.name} className="flex flex-col gap-0.5">
              <span className="text-foreground">
                {t.name}
                {filtered && <span className="text-muted-foreground">, filtered</span>}
              </span>
              {s?.state === "ready" ? (
                <p
                  role="status"
                  className="text-xs tabular-nums"
                  data-testid={`selection-${t.name}`}
                >
                  {formatCount(s.count)} of {formatCount(featuresInScope(s, cache))} features
                  selected.
                </p>
              ) : (
                <p
                  role={describeScope(s, cache).problem ? "alert" : "status"}
                  className="text-xs"
                  data-testid={`selection-${t.name}`}
                >
                  {describeScope(s, cache).text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
