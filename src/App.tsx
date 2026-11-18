import { useEffect, useState } from "react";
import { createEngine } from "./engine/duckdb";

type Status =
  | { state: "starting" }
  | { state: "ready"; duckdb: string; extensions: string[] }
  | { state: "failed"; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ state: "starting" });

  useEffect(() => {
    let cancelled = false;
    const started = createEngine();
    started
      .then(async (engine) => {
        const [version] = await engine.query("SELECT library_version AS v FROM pragma_version()");
        const loaded = await engine.query(
          "SELECT extension_name AS name FROM duckdb_extensions() WHERE loaded ORDER BY name",
        );
        if (!cancelled) {
          setStatus({
            state: "ready",
            duckdb: String(version?.v),
            extensions: loaded.map((row) => String(row.name)),
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus({ state: "failed", message: String(error) });
      });
    return () => {
      cancelled = true;
      void started.then((engine) => engine.terminate()).catch(() => undefined);
    };
  }, []);

  return (
    <main>
      <h1>CityParquet downloader</h1>
      {status.state === "starting" && <p>Starting DuckDB…</p>}
      {status.state === "ready" && (
        <p>
          DuckDB {status.duckdb} is ready, with {status.extensions.join(", ")}.
        </p>
      )}
      {status.state === "failed" && <p role="alert">DuckDB did not start: {status.message}</p>}
    </main>
  );
}
