// The object types on the map, per table, each with its colour and a toggle.
import { Checkbox } from "@/components/ui/checkbox";
import { colourOf } from "@/core";
import { formatCount } from "@/features/source/format";
import { usePackage } from "@/features/source/store";
import { useMapData } from "./footprints";
import { isShown, legendKey, toggleLegend, useLegend } from "./legend";

export function Legend() {
  const pkg = usePackage();
  const { seen, hidden } = useLegend();
  const { cache, layout } = useMapData();
  if (pkg.state !== "ready") return null;

  // Loaded features per table and type, from the chunks in the local table now.
  const loaded = new Map<string, number>();
  if (layout.state === "ready") {
    for (const c of layout.chunks) {
      const e = cache.get(c.key);
      if (e?.state !== "ready") continue;
      for (const [type, n] of Object.entries(e.types)) {
        const k = legendKey(c.table, type);
        loaded.set(k, (loaded.get(k) ?? 0) + n);
      }
    }
  }

  return (
    <section aria-labelledby="legend-heading" className="flex flex-col gap-2">
      <h2 id="legend-heading">Legend</h2>
      <ul className="flex flex-col gap-2">
        {pkg.info.tables.map((t) => {
          const types = seen[t.name] ?? [];
          const tableShown = isShown(hidden, t.name);
          return (
            <li key={t.name} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-foreground">
                <Checkbox
                  aria-label={`${t.name} table`}
                  checked={tableShown}
                  onCheckedChange={() => toggleLegend(legendKey(t.name))}
                />
                {t.name}
              </span>
              {types.length === 0 ? (
                <p className="pl-6 text-xs">Its object types show once footprints load.</p>
              ) : (
                <ul className="flex flex-col gap-1 pl-6">
                  {types.map((type) => (
                    <li key={type} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        aria-label={`${type} in ${t.name}`}
                        checked={isShown(hidden, t.name, type)}
                        disabled={!tableShown}
                        onCheckedChange={() => toggleLegend(legendKey(t.name, type))}
                      />
                      <span
                        aria-hidden="true"
                        className="size-3 shrink-0 rounded-sm border border-black/10"
                        style={{ backgroundColor: colourOf(type) }}
                      />
                      <span className="flex-1 truncate" title={type}>
                        {type}
                      </span>
                      <span className="tabular-nums">
                        {formatCount(loaded.get(legendKey(t.name, type)) ?? 0)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
