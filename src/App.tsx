import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEngineStatus } from "@/engine/session";
import { FeaturePopup } from "@/features/map/FeaturePopup";
import { Legend } from "@/features/map/Legend";
import { MapStatus } from "@/features/map/MapStatus";
import { MapView } from "@/features/map/MapView";
import { PackageSummary } from "@/features/source/PackageSummary";
import { openSourcePackage } from "@/features/source/store";
import { toggleTheme, useTheme } from "@/lib/theme";

function EngineStatus() {
  const status = useEngineStatus();
  switch (status.state) {
    case "starting":
      return <p role="status">Starting DuckDB…</p>;
    case "ready":
      return (
        <p role="status" className="text-xs">
          DuckDB {status.version} is ready, with {status.extensions.join(", ")}.
        </p>
      );
    case "failed":
      return <p role="alert">DuckDB did not start: {status.message}</p>;
  }
}

function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  return (
    <Button size="xs" variant="outline" onClick={toggleTheme}>
      {theme === "dark" ? "Light theme" : "Dark theme"}
    </Button>
  );
}

/**
 * One screen: the map fills the window, the side panel holds what the package is and what
 * the map shows. The map column is a flex column so a drawer can sit below the map.
 */
export function App() {
  const [panel, setPanel] = useState(true);
  useEffect(() => {
    void openSourcePackage();
  }, []);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {panel && (
        <aside
          id="side-panel"
          aria-label="Side panel"
          className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-background p-4"
        >
          <header className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-base">CityParquet downloader</h1>
              <ThemeToggle />
            </div>
            <EngineStatus />
          </header>
          <PackageSummary />
          <MapStatus />
          <Legend />
        </aside>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <MapView />
          <FeaturePopup />
          <Button
            size="xs"
            variant="outline"
            className="absolute top-3 left-3 z-10 shadow-card"
            aria-expanded={panel}
            aria-controls="side-panel"
            onClick={() => setPanel(!panel)}
          >
            {panel ? "Hide panel" : "Show panel"}
          </Button>
        </div>
      </main>
    </div>
  );
}
