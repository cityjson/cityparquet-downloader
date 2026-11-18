// The app's one DuckDB engine. It starts on first use; a worker that fails fatally (out
// of memory, a wasm trap) is discarded, and the next use starts a fresh one.
import { create } from "zustand";
import { type BrowserEngine, createEngine } from "./duckdb";

export type EngineStatus =
  | { state: "starting" }
  | { state: "ready"; version: string; extensions: string[] }
  | { state: "failed"; message: string };

export const useEngineStatus = create<EngineStatus>(() => ({ state: "starting" }));

let current: Promise<BrowserEngine> | undefined;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Errors after which the worker cannot be trusted with another statement. */
export const isFatal = (e: unknown) =>
  /out of memory|memory access out of bounds|unreachable|RuntimeError|worker/i.test(message(e));

async function start(): Promise<BrowserEngine> {
  useEngineStatus.setState({ state: "starting" }, true);
  try {
    const engine = await createEngine();
    const [version] = await engine.query("SELECT library_version AS v FROM pragma_version()");
    const loaded = await engine.query(
      "SELECT extension_name AS name FROM duckdb_extensions() WHERE loaded ORDER BY name",
    );
    useEngineStatus.setState(
      {
        state: "ready",
        version: String(version?.v),
        extensions: loaded.map((row) => String(row.name)),
      },
      true,
    );
    return engine;
  } catch (e) {
    useEngineStatus.setState({ state: "failed", message: message(e) }, true);
    throw e;
  }
}

/** The running engine, started if there is none. */
export function getEngine(): Promise<BrowserEngine> {
  current ??= start().catch((e: unknown) => {
    current = undefined;
    throw e;
  });
  return current;
}

/** Terminates the engine; the next `getEngine` starts a new one. */
export async function discardEngine(): Promise<void> {
  const engine = await current?.catch(() => undefined);
  current = undefined;
  await engine?.terminate().catch(() => undefined);
}

/** Runs `work` on the engine, discarding the engine if it fails fatally. */
export async function withEngine<T>(work: (engine: BrowserEngine) => Promise<T>): Promise<T> {
  const engine = await getEngine();
  try {
    return await work(engine);
  } catch (e) {
    if (isFatal(e)) {
      await discardEngine();
      useEngineStatus.setState(
        { state: "failed", message: `${message(e)} (DuckDB restarts on the next action)` },
        true,
      );
    }
    throw e;
  }
}
