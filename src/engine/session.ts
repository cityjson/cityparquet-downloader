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

/**
 * Who is waiting on a job. duckdb-wasm runs one statement at a time, so jobs run one after
 * another, the most urgent first: what the user just asked for, then the map's vector
 * tiles, then background reads such as loading footprints.
 */
export type Priority = "interactive" | "tile" | "background";
const RANK: Record<Priority, number> = { interactive: 0, tile: 1, background: 2 };

export interface JobOptions {
  priority?: Priority;
  /** A job whose signal aborts before it starts is dropped; a running one finishes. */
  signal?: AbortSignal;
}

interface Job {
  rank: number;
  signal: AbortSignal | undefined;
  run: () => Promise<void>;
  drop: (reason: unknown) => void;
}

const queue: Job[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      // The first of the most urgent: FIFO within a priority.
      let next = -1;
      for (let i = 0; i < queue.length; i++) {
        const job = queue[i];
        if (job && (next < 0 || job.rank < (queue[next]?.rank ?? Infinity))) next = i;
      }
      if (next < 0) return;
      const [job] = queue.splice(next, 1);
      if (!job) return;
      if (job.signal?.aborted) job.drop(job.signal.reason);
      else await job.run();
    }
  } finally {
    running = false;
  }
}

/**
 * Runs `work` on the engine once the jobs before it are done, and discards the engine if
 * `work` fails fatally. `work` must not call `withEngine` itself: it would wait on itself.
 */
export function withEngine<T>(
  work: (engine: BrowserEngine) => Promise<T>,
  { priority = "interactive", signal }: JobOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      rank: RANK[priority],
      signal,
      drop: reject,
      run: () => runOnEngine(work).then(resolve, reject),
    });
    void pump();
  });
}

async function runOnEngine<T>(work: (engine: BrowserEngine) => Promise<T>): Promise<T> {
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
