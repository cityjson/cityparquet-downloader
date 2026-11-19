// The download, in the side panel: format, LoDs, attributes per table, file name, what it
// would read, and the button; while it runs, its step and Cancel.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { EXPORT_FORMATS, type ExportFormat, formatLabel, type PackageTable } from "@/core";
import { useMapData } from "@/features/map/footprints";
import { useSelection } from "@/features/selection/store";
import { formatBytes, formatCount } from "@/features/source/format";
import { usePackage } from "@/features/source/store";
import {
  cancelDownload,
  type DownloadProgress,
  type DownloadRun,
  defaultFileName,
  packageLods,
  prepare,
  setAttributes,
  setDraft,
  startDownload,
  useDownload,
} from "./store";

const SHAPE: Record<ExportFormat, string> = {
  cityparquet: "package, .zip",
  cityjson: ".city.json",
  cityjsonseq: ".city.jsonl",
  flatcitybuf: ".fcb",
  obj: ".obj and .mtl, .zip",
};

function progressText(p: DownloadProgress, format: ExportFormat): string {
  switch (p.step) {
    case "preparing":
      return "Preparing the selection…";
    case "expanding":
      return `Finding the parts of features, row group ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
    case "reading":
      return p.total === 0
        ? "Reading…"
        : `Reading row group ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
    case "writing":
      return `Writing ${formatLabel(format)}…`;
    case "saving":
      return "Saving the file…";
  }
}

/** Seconds since `started` (a `performance.now()`), ticking once a second. */
function useElapsed(started: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - started) / 1000));
}

function Running({
  run,
  format,
}: {
  run: Extract<DownloadRun, { state: "running" }>;
  format: ExportFormat;
}) {
  const seconds = useElapsed(run.started);
  const percent = Math.round(run.fraction * 100);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between gap-2">
        <p role="status" data-testid="download-progress">
          {progressText(run.progress, format)}
        </p>
        <span className="shrink-0 tabular-nums" data-testid="download-percent">
          {percent} %, {seconds} s
        </span>
      </div>
    </div>
  );
}

function RunState({ run, format }: { run: DownloadRun; format: ExportFormat }) {
  switch (run.state) {
    case "idle":
      return null;
    case "running":
      return <Running run={run} format={format} />;
    case "done":
      return (
        <p role="status" className="text-xs" data-testid="download-result">
          Saved {run.name}: {formatBytes(run.bytes)}, {formatCount(run.rows)} city objects, in{" "}
          {run.seconds.toFixed(1)} s.
        </p>
      );
    case "cancelled":
      return (
        <p role="status" className="text-xs" data-testid="download-result">
          Download cancelled.
        </p>
      );
    case "failed":
      return (
        <p role="alert" className="text-xs" data-testid="download-result">
          The download failed: {run.message}
        </p>
      );
  }
}

function AttributePicker({ table, chosen }: { table: PackageTable; chosen: readonly string[] }) {
  const [query, setQuery] = useState("");
  const all = table.attributes.map((a) => a.name);
  const set = new Set(chosen);
  const matches = all.filter((a) => a.toLowerCase().includes(query.toLowerCase()));
  const toggle = (name: string) => {
    const next = new Set(set);
    if (!next.delete(name)) next.add(name);
    setAttributes(
      table.name,
      all.filter((a) => next.has(a)),
    );
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" aria-label={`Attributes of ${table.name}`}>
          Attributes {set.size} of {all.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-2">
        <Input
          aria-label="Search attributes"
          placeholder="Search attributes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-1.5">
          <Button size="xs" variant="outline" onClick={() => setAttributes(table.name, null)}>
            Select all
          </Button>
          <Button size="xs" variant="outline" onClick={() => setAttributes(table.name, [])}>
            Select none
          </Button>
        </div>
        <ul
          aria-label="Attributes to download"
          className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
        >
          {matches.map((a) => (
            <li key={a}>
              <div className="flex items-center gap-1.5 rounded px-1 py-0.5 text-foreground hover:bg-muted">
                <Checkbox
                  aria-label={`Download ${a}`}
                  checked={set.has(a)}
                  onCheckedChange={() => toggle(a)}
                />
                <button type="button" className="truncate text-left" onClick={() => toggle(a)}>
                  {a}
                </button>
              </div>
            </li>
          ))}
          {matches.length === 0 && <li className="p-1">No attribute matches.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function DownloadPanel() {
  const pkg = usePackage();
  const selections = useSelection((s) => s.tables);
  const cache = useMapData((s) => s.cache);
  const { draft, run } = useDownload();
  if (pkg.state !== "ready") return null;

  const tables = pkg.info.tables;
  const lods = packageLods(tables);
  const objLod = draft.objLod ?? lods.at(-1) ?? "";
  const prepared = prepare(tables, selections, draft, pkg.url, cache);
  const { estimate, request } = prepared;
  const busy = run.state === "running";

  return (
    <section aria-labelledby="download-heading" className="flex flex-col gap-2.5">
      <h2 id="download-heading">Download</h2>

      <div className="flex items-center justify-between gap-2 text-xs">
        <label htmlFor="download-format">Format</label>
        <NativeSelect
          id="download-format"
          value={draft.format}
          disabled={busy}
          onChange={(e) => setDraft({ format: e.target.value as ExportFormat })}
        >
          {EXPORT_FORMATS.map((f) => (
            <option key={f} value={f}>
              {formatLabel(f)} ({SHAPE[f]})
            </option>
          ))}
        </NativeSelect>
      </div>

      <fieldset className="flex flex-col gap-1.5" disabled={busy}>
        <legend className="mb-1 text-xs">
          {draft.format === "obj" ? "Level of detail, one per OBJ" : "Levels of detail"}
        </legend>
        {draft.format === "obj" ? (
          <RadioGroup
            aria-label="Level of detail"
            value={objLod}
            onValueChange={(v) => setDraft({ objLod: v })}
            className="flex flex-wrap gap-3"
          >
            {lods.map((l) => (
              <div key={l} className="flex items-center gap-1.5 text-xs text-foreground">
                <RadioGroupItem id={`download-lod-${l}`} value={l} aria-label={`LoD ${l}`} />
                <label htmlFor={`download-lod-${l}`}>LoD {l}</label>
              </div>
            ))}
          </RadioGroup>
        ) : (
          <div className="flex flex-wrap gap-3">
            {lods.map((l) => {
              const on = (draft.lods ?? lods).includes(l);
              return (
                <div key={l} className="flex items-center gap-1.5 text-xs text-foreground">
                  <Checkbox
                    id={`download-lod-${l}`}
                    aria-label={`LoD ${l}`}
                    checked={on}
                    onCheckedChange={(v) => {
                      const now = draft.lods ?? lods;
                      setDraft({
                        lods: lods.filter((x) => (x === l ? v === true : now.includes(x))),
                      });
                    }}
                  />
                  <label htmlFor={`download-lod-${l}`}>LoD {l}</label>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      <ul className="flex flex-col gap-1.5" aria-label="Tables to download">
        {tables.map((t) => {
          const s = selections[t.name];
          const r = request.tables.find((x) => x.name === t.name);
          return (
            <li key={t.name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground">{t.name}</span>
                <AttributePicker
                  table={t}
                  chosen={draft.attributes[t.name] ?? t.attributes.map((a) => a.name)}
                />
              </div>
              <p className="text-xs tabular-nums" data-testid={`download-${t.name}`}>
                {r
                  ? `${formatCount(s?.state === "ready" ? s.count : 0)} selected features with all their parts; ${r.lods.length === 0 ? "no geometry" : `LoD ${r.lods.join(", ")}`}; ${r.attributes.length} attributes.`
                  : prepared.skipped.includes(t.name)
                    ? `Left out: it has no LoD ${objLod}.`
                    : "Nothing selected."}
              </p>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1 text-xs">
        <label htmlFor="download-name">File name</label>
        <Input
          id="download-name"
          value={draft.fileName ?? defaultFileName(pkg.url)}
          disabled={busy}
          onChange={(e) => setDraft({ fileName: e.target.value })}
        />
      </div>

      {request.tables.length > 0 && (
        <p className="text-xs tabular-nums" data-testid="download-estimate">
          Reads up to {formatBytes(estimate.readBytes)} from {formatCount(estimate.rowGroups)} row{" "}
          {estimate.rowGroups === 1 ? "group" : "groups"}. The selection is about{" "}
          {formatBytes(estimate.keptBytes)} of that.
        </p>
      )}
      {prepared.problem && !busy && (
        <p role="alert" className="text-xs" data-testid="download-problem">
          {prepared.problem}
        </p>
      )}

      <div className="flex gap-2">
        {busy ? (
          <Button size="xs" variant="outline" onClick={cancelDownload}>
            Cancel download
          </Button>
        ) : (
          <Button
            size="xs"
            disabled={prepared.problem !== null}
            onClick={() => void startDownload()}
          >
            Download
          </Button>
        )}
      </div>
      <RunState run={run} format={draft.format} />
    </section>
  );
}
