import { useEffect } from "react";
import { useEngineStatus } from "@/engine/session";
import { PackageSummary } from "@/features/source/PackageSummary";
import { openSourcePackage } from "@/features/source/store";

function EngineStatus() {
  const status = useEngineStatus();
  switch (status.state) {
    case "starting":
      return <p role="status">Starting DuckDB…</p>;
    case "ready":
      return (
        <p role="status">
          DuckDB {status.version} is ready, with {status.extensions.join(", ")}.
        </p>
      );
    case "failed":
      return <p role="alert">DuckDB did not start: {status.message}</p>;
  }
}

export function App() {
  useEffect(() => {
    void openSourcePackage();
  }, []);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg">CityParquet downloader</h1>
        <EngineStatus />
      </header>
      <PackageSummary />
    </main>
  );
}
