// What the map shows now, and the reads it is waiting on.
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FOOTPRINT_ROW_GROUP_LIMIT, FOOTPRINT_SMALL_VIEW_ROWS } from "@/core";
import { formatCount } from "@/features/source/format";
import { retryFailed, useMapData } from "./footprints";

export function MapStatus() {
  const { layout, regime, cache } = useMapData();
  if (layout.state === "idle") return null;
  if (layout.state === "placing") return <p role="status">Placing row groups on the map…</p>;
  if (layout.state === "failed") {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>The map cannot show this package</AlertTitle>
        <AlertDescription>{layout.message}</AlertDescription>
      </Alert>
    );
  }

  const touched = regime.kind === "none" ? [] : regime.touched;
  const rows = touched.reduce((n, c) => n + c.rows, 0);
  const entries = touched.map((c) => ({ chunk: c, entry: cache.get(c.key) }));
  const features = entries.reduce(
    (n, { entry }) => n + (entry?.state === "ready" ? entry.features : 0),
    0,
  );
  const loading = entries.filter(({ entry }) => entry?.state === "loading").length;
  const failed = entries.filter(({ entry }) => entry?.state === "failed");

  return (
    <section aria-labelledby="map-status-heading" className="flex flex-col gap-2">
      <h2 id="map-status-heading">View</h2>
      <p role="status" data-testid="map-status">
        {regime.kind === "footprints"
          ? `Footprints: ${formatCount(features)} features${loading ? `, loading ${loading} of ${touched.length} row groups` : ""}`
          : `Overview: ${formatCount(touched.length)} row groups, ${formatCount(rows)} features in view`}
      </p>
      {regime.kind !== "footprints" && (
        <p className="text-xs">
          Zoom in to see footprints. They load when the view touches at most{" "}
          {FOOTPRINT_ROW_GROUP_LIMIT} row groups or {formatCount(FOOTPRINT_SMALL_VIEW_ROWS)} rows.
        </p>
      )}
      {failed.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>
            {failed.length === 1 ? "A row group" : `${failed.length} row groups`} did not load
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {failed.map(({ chunk, entry }) => (
              <span key={chunk.key} className="break-all">
                {chunk.table}, row group {chunk.index}:{" "}
                {entry?.state === "failed" ? entry.message : ""}
              </span>
            ))}
            <Button size="xs" variant="outline" onClick={retryFailed}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {layout.unmapped.map((u) => (
        <p key={u.table} className="text-xs">
          {u.table} is not on the map, because {u.reason}.
        </p>
      ))}
    </section>
  );
}
