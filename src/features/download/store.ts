// The download: what the user chose (format, LoDs, attributes, file name), the request
// and estimate that follow from it and the selection, and one run at a time of the
// export, from the selection to a file the browser saves.
import { Zip, ZipPassThrough } from "fflate";
import { create } from "zustand";
import {
  checkRequest,
  cleanupSql,
  type ExportEstimate,
  type ExportFormat,
  type ExportInput,
  type ExportProgress,
  type ExportRequest,
  estimateExport,
  exportFraction,
  exportSizeLimit,
  formatLabel,
  STREAMED_FORMATS,
  type PackageTable,
  planExport,
  runExport,
  writtenSql,
} from "@/core";
import { hasDisk, withEngine } from "@/engine/session";
import { useMapData } from "@/features/map/footprints";
import { featuresInScope } from "@/features/selection/describe";
import {
  materialiseSelection,
  type TableSelection,
  useSelection,
} from "@/features/selection/store";
import { usePackage } from "@/features/source/store";

export interface DownloadDraft {
  format: ExportFormat;
  /** The LoDs for every format but OBJ; null: all the package has. */
  lods: string[] | null;
  /** OBJ's one LoD; null: the highest. */
  objLod: string | null;
  /** Per table, the attributes; absent or null: all. */
  attributes: Record<string, string[] | null>;
  /** null: named after the package. */
  fileName: string | null;
}

export type DownloadProgress = ExportProgress | { step: "preparing" } | { step: "saving" };

export type DownloadRun =
  | { state: "idle" }
  /** `fraction`: how far it is, 0 to 1, never going back; `started`: `performance.now()` then. */
  | { state: "running"; progress: DownloadProgress; fraction: number; started: number }
  | { state: "done"; name: string; bytes: number; rows: number; seconds: number }
  | { state: "cancelled" }
  | { state: "failed"; message: string };

interface DownloadState {
  draft: DownloadDraft;
  run: DownloadRun;
}

export const useDownload = create<DownloadState>(() => ({
  draft: { format: "cityparquet", lods: null, objLod: null, attributes: {}, fileName: null },
  run: { state: "idle" },
}));

export function setDraft(patch: Partial<DownloadDraft>): void {
  useDownload.setState((s) => ({ draft: { ...s.draft, ...patch } }));
}

export function setAttributes(table: string, attributes: string[] | null): void {
  useDownload.setState((s) => ({
    draft: { ...s.draft, attributes: { ...s.draft.attributes, [table]: attributes } },
  }));
}

/** Every LoD of the package, sorted as the tables list them. */
export function packageLods(tables: readonly PackageTable[]): string[] {
  return [...new Set(tables.flatMap((t) => t.lods))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/** `3dbag-subset` for `…/data/3dbag/`, `building-subset` for `…/building.parquet`. */
export function defaultFileName(url: string): string {
  const parts = new URL(url).pathname.split("/").filter((p) => p !== "" && !p.includes("*"));
  const last = (parts.at(-1) ?? "cityparquet").replace(/\.parquet$/, "");
  return `${last}-subset`;
}

type Ready = Extract<TableSelection, { state: "ready" }>;

export interface Prepared {
  request: ExportRequest;
  inputs: (ExportInput & { selected: number; drawable: number })[];
  estimate: ExportEstimate;
  /** Why the download cannot start; null when it can. */
  problem: string | null;
  /** Tables left out because they lack OBJ's LoD. */
  skipped: string[];
}

/** The request the draft and the selection make now, and what it would cost. */
export function prepare(
  tables: readonly PackageTable[],
  selections: Readonly<Record<string, TableSelection>>,
  draft: DownloadDraft,
  url: string,
  cache: Parameters<typeof featuresInScope>[1],
): Prepared {
  const lods = packageLods(tables);
  const objLod = draft.objLod ?? lods.at(-1) ?? "";
  const ready = tables.flatMap((table) => {
    const s = selections[table.name];
    return s?.state === "ready" && s.count > 0 ? [{ table, s: s as Ready }] : [];
  });
  const skipped =
    draft.format === "obj"
      ? ready.filter(({ table }) => !table.lods.includes(objLod)).map(({ table }) => table.name)
      : [];
  const chosen = ready.filter(({ table }) => !skipped.includes(table.name));
  const request: ExportRequest = {
    format: draft.format,
    fileName: draft.fileName ?? defaultFileName(url),
    tables: chosen.map(({ table }) => ({
      name: table.name,
      lods:
        draft.format === "obj"
          ? [objLod]
          : table.lods.filter((l) => (draft.lods ?? lods).includes(l)),
      attributes:
        draft.attributes[table.name]?.filter((a) => table.attributes.some((c) => c.name === a)) ??
        table.attributes.map((a) => a.name),
    })),
  };
  const inputs = chosen.map(({ table, s }) => ({
    table,
    scope: s.scope.chunks.map((c) => c.chunk),
    selected: s.count,
    drawable: featuresInScope(s, cache),
  }));
  const disk = hasDisk();
  const estimate = estimateExport(inputs, request, exportSizeLimit(request.format, disk));
  const problem =
    ready.length === 0
      ? "Nothing is selected. Draw an area, filter a table, or zoom in until footprints show."
      : chosen.length === 0
        ? `No selected table has LoD ${objLod}. Choose another level of detail for the OBJ.`
        : estimate.tooLarge
          ? `Too large to write as ${formatLabel(request.format)} in the browser. The ${estimate.selected.toLocaleString("en-GB")} selected features hold about ${mb(estimate.keptBytes)}, and the limit is ${mb(estimate.limit)}. ${
              disk && !STREAMED_FORMATS.includes(request.format)
                ? `CityJSONSeq and CityParquet can be written up to ${mb(exportSizeLimit("cityjsonseq", true))}; or select`
                : "Select"
            } fewer features, LoDs or attributes.`
          : checkRequest(tables, request);
  return { request, inputs, estimate, problem, skipped };
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

let running: AbortController | null = null;
let runs = 0;

/** Cancels the running download; the step that is running finishes first. */
export function cancelDownload(): void {
  running?.abort();
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the download the draft and the selection make, and saves it. */
export async function startDownload(): Promise<void> {
  if (running) return;
  const abort = new AbortController();
  running = abort;
  const { signal } = abort;
  const set = (run: DownloadRun) => useDownload.setState({ run });
  const started = performance.now();
  let fraction = 0;
  const step = (progress: DownloadProgress, at: number) => {
    fraction = Math.max(fraction, at);
    set({ state: "running", progress, fraction, started });
  };
  step({ step: "preparing" }, 0);
  try {
    await materialiseSelection();
    const pkg = usePackage.getState();
    if (pkg.state !== "ready") throw new Error("The package is not open.");
    const prepared = prepare(
      pkg.info.tables,
      useSelection.getState().tables,
      useDownload.getState().draft,
      pkg.url,
      useMapData.getState().cache,
    );
    if (prepared.problem) throw new Error(prepared.problem);
    // Earlier downloads' files on disk go first; this one's are written beside them.
    const base = await withEngine(async (engine) => {
      await engine.clearScratch();
      return `${engine.scratch}/export`;
    });
    const plan = planExport(prepared.inputs, prepared.request, ++runs, base);
    const exec = <T>(progress: ExportProgress, work: Parameters<typeof withEngine<T>>[0]) => {
      if (!signal.aborted) step(progress, exportFraction(progress));
      return withEngine(work, { priority: "background", signal });
    };
    let kept: string[] = [];
    try {
      const result = await runExport(plan, exec, signal);
      const { files } = result;
      step({ step: "saving" }, 0.97);
      const blob = await withEngine(
        async (engine) => {
          await engine.dropFiles(result.staged);
          // On disk a file is handed over as it lies; in memory it is copied out and freed.
          const take = async (f: string) => {
            const blob = await engine.openFile(f);
            if (!f.startsWith("opfs://")) await engine.dropFiles([f]);
            // A writer that bypassed DuckDB's file system leaves the target empty.
            if (blob.size <= 1) throw new Error(`The writer left ${f} empty.`);
            return blob;
          };
          if (!plan.layout.zip) {
            const [only] = files;
            if (!only || files.length !== 1)
              throw new Error(`Expected one file, got ${files.length}.`);
            return take(only);
          }
          const pieces: Blob[] = [];
          const zip = new Zip((error, chunk) => {
            if (error) throw error;
            pieces.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
          });
          const folder = plan.layout.download.replace(/(-obj)?\.zip$/, "");
          for (const f of files) {
            // Parquet is compressed already; the entries are only stored, a chunk at a time.
            const entry = new ZipPassThrough(`${folder}/${f.split("/").at(-1)}`);
            zip.add(entry);
            const reader = (await take(f)).stream().getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              entry.push(value);
            }
            entry.push(new Uint8Array(0), true);
          }
          zip.end();
          return new Blob(pieces, { type: "application/zip" });
        },
        { signal },
      );
      // On disk the browser saves the file itself, so it stays until the next download.
      kept = files.filter((f) => f.startsWith("opfs://"));
      save(blob, plan.layout.download);
      set({
        state: "done",
        name: plan.layout.download,
        bytes: blob.size,
        rows: Object.values(result.rows).reduce((n, r) => n + r, 0),
        seconds: (performance.now() - started) / 1000,
      });
    } finally {
      // Free the local tables and the virtual files, whatever happened.
      await withEngine(async (engine) => {
        for (const s of cleanupSql(plan)) await engine.exec(s);
        const written = await engine.query(writtenSql(plan));
        await engine.dropFiles(written.map((r) => String(r.file)).filter((f) => !kept.includes(f)));
      }).catch(() => undefined);
    }
  } catch (e) {
    set(signal.aborted ? { state: "cancelled" } : { state: "failed", message: message(e) });
  } finally {
    running = null;
  }
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
