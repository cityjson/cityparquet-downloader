// A download. The selected rows are completed to whole features, their chosen columns are
// read from the remote files into a local schema shaped as a CityParquet package, the
// footers are restored, and the cityjson extension writes the output. This module only
// decides what to run: the export SQL comes from @cityjson/cjconv-core's builders, and
// every read and write is the extension's.
//
// The steps, in order (`runExport`):
//   1. seed      `export_seed (tbl, file, row)`: a snapshot of `selection_rows`
//   2. expand    `export_keys (tbl, file, row, feature_id)` for the scope's row groups, by
//                `file_row_number`; `export_rows`, every row sharing a `feature_id` with a
//                seed. A feature's rows are contiguous in its table, so one that reaches a
//                row group's first or last row brings in the row group beside it
//   3. stage     the chosen columns of `export_rows`, one row group at a time, each into
//                a Parquet file on the engine's file system: `<root>/stage/<n>.parquet`.
//                Nothing is held as a table, so memory stays at one row group's
//   4. write     one `COPY … (FORMAT …)` over the staged files; or, for a package, the
//                staged files into `<schema>.<table>`, `cityparquet_init`, each table's
//                source `city` footer into `<schema>.__cityparquet`, `cityparquet_write`
import {
  analyzeColumns,
  copySql,
  crsFromProjjson,
  crsToAuthCode,
  crsToUri,
  type Engine,
  FORMATS,
  type FormatId,
  selectColumns,
} from "@cityjson/cjconv-core";
import { type Chunk, type ChunkKey, chunksOf } from "./chunk";
import { SELECTION_TABLE } from "./features";
import type { RowGroup, TableInfo } from "./footer";
import { ident, lit, num, type Sql, sql } from "./sql";

/** The formats a download can be written in, in the order the picker shows them. */
export const EXPORT_FORMATS = [
  "cityparquet",
  "cityjson",
  "cityjsonseq",
  "flatcitybuf",
  "obj",
] as const satisfies readonly FormatId[];
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const formatLabel = (f: ExportFormat): string => FORMATS[f].label;

export interface ExportTable {
  name: string;
  lods: readonly string[];
  attributes: readonly string[];
}

export interface ExportRequest {
  tables: readonly ExportTable[];
  format: ExportFormat;
  /** The download's name without extension. */
  fileName: string;
}

/** A table of the package and the row groups its selection's scope holds. */
export interface ExportInput {
  table: TableInfo;
  scope: readonly Chunk[];
}

/** The columns a download reads from a table: every reserved one, the chosen LoD groups and attributes, in file order. */
export function exportColumns(table: Pick<TableInfo, "columns">, t: ExportTable): string[] {
  return selectColumns(analyzeColumns(table.columns), {
    lods: [...t.lods],
    attributes: [...t.attributes],
  });
}

/** Why the request cannot run, in words; null when it can. */
export function checkRequest(
  tables: readonly Pick<TableInfo, "name" | "lods" | "attributes">[],
  request: ExportRequest,
): string | null {
  if (request.fileName.trim() === "") return "Give the download a file name.";
  if (request.tables.length === 0) return "Choose at least one table.";
  for (const t of request.tables) {
    const info = tables.find((x) => x.name === t.name);
    if (!info) return `The package has no table ${t.name}.`;
    const lod = t.lods.find((l) => !info.lods.includes(l));
    if (lod) return `${t.name} has no LoD ${lod}.`;
    const names = new Set(info.attributes.map((a) => a.name));
    const attribute = t.attributes.find((a) => !names.has(a));
    if (attribute) return `${t.name} has no attribute ${attribute}.`;
  }
  if (request.format === "obj") {
    const lods = new Set(request.tables.flatMap((t) => t.lods));
    if (lods.size !== 1) return "An OBJ holds exactly one LoD.";
  }
  return null;
}

/**
 * The most compressed bytes a download keeps: the selected share of the chosen columns.
 * CityJSONSeq and CityParquet are written from files staged on disk and were written at
 * 164 MB on 3DBAG (a 640 MB file, a 258 MB package), not at 241 MB. The other writers hold
 * the whole output in the wasm heap, which ends at 4 GiB, and take up to 85 times what is
 * kept (CityJSON: 19.3 MB took the tab to 3.0 GiB). Without a disk the staged files are
 * in that heap too. Measured in docs/findings.md.
 */
export const EXPORT_SIZE_LIMITS = { streamed: 170_000_000, held: 20_000_000 } as const;

/** The formats that are written from disk to disk. */
export const STREAMED_FORMATS: readonly ExportFormat[] = ["cityjsonseq", "cityparquet"];

/** The limit for a format; `disk` says whether the engine stages on disk. */
export const exportSizeLimit = (format: ExportFormat, disk: boolean): number =>
  disk && STREAMED_FORMATS.includes(format) ? EXPORT_SIZE_LIMITS.streamed : EXPORT_SIZE_LIMITS.held;

export interface ExportEstimate {
  /** Selected rows (before features are completed). */
  selected: number;
  rowGroups: number;
  /** Compressed bytes of the chosen columns in the scope's row groups: what is fetched. */
  readBytes: number;
  /** The selected share of `readBytes`: roughly what the output holds, compressed. */
  keptBytes: number;
  limit: number;
  tooLarge: boolean;
}

const bytesOf = (groups: readonly RowGroup[], columns: readonly string[]) =>
  groups.reduce((n, g) => n + columns.reduce((m, c) => m + (g.columnBytes[c] ?? 0), 0), 0);

/**
 * What a download would read and keep. Per table, `selected` rows of the `drawable` ones
 * the scope holds (the rows the map draws); a feature's other rows (parts without a
 * footprint) lie beside its root, so the kept share is `selected / drawable` of every row.
 */
export function estimateExport(
  inputs: readonly (ExportInput & { selected: number; drawable: number })[],
  request: ExportRequest,
  limit = exportSizeLimit(request.format, true),
): ExportEstimate {
  let selected = 0;
  let rowGroups = 0;
  let readBytes = 0;
  let keptBytes = 0;
  for (const t of request.tables) {
    const input = inputs.find((i) => i.table.name === t.name);
    if (!input) continue;
    const groups = input.scope.flatMap((c) =>
      input.table.rowGroups.filter((g) => g.file === c.file && g.index === c.index),
    );
    const read = bytesOf(groups, exportColumns(input.table, t));
    selected += input.selected;
    rowGroups += groups.length;
    readBytes += read;
    keptBytes += input.drawable === 0 ? 0 : Math.round((read * input.selected) / input.drawable);
  }
  return { selected, rowGroups, readBytes, keptBytes, limit, tooLarge: keptBytes > limit };
}

/** A row the expansion found on a row group's edge. */
export interface EdgeRow {
  tbl: string;
  file: number;
  row: number;
}

/**
 * The row groups to read next: beside each edge row, on the side it touches, when not
 * read already. `chunks` are all of the table's row groups, in file order.
 */
export function neighbours(
  chunks: readonly Chunk[],
  read: ReadonlySet<ChunkKey>,
  edges: readonly EdgeRow[],
): Chunk[] {
  const next = new Map<ChunkKey, Chunk>();
  for (const e of edges) {
    const i = chunks.findIndex(
      (c) =>
        c.table === e.tbl && c.fileIndex === e.file && e.row >= c.start && e.row < c.start + c.rows,
    );
    const c = chunks[i];
    if (!c) continue;
    const side =
      e.row === c.start
        ? chunks[i - 1]
        : e.row === c.start + c.rows - 1
          ? chunks[i + 1]
          : undefined;
    if (side && side.fileIndex === c.fileIndex && !read.has(side.key)) next.set(side.key, side);
  }
  return [...next.values()];
}

/** The minimum corner of the data, in the package CRS. */
export interface Corner {
  x: number;
  y: number;
  z: number;
}

/**
 * The vertex transform for the CityJSON family. The scale is the source's (`city.other.
 * transform`), so precision is what the package had; the origin is the data's minimum
 * corner, so quantised vertices stay small (the source's origin may be anywhere).
 */
export function transformOptions(
  cityFooter: string,
  corner: Corner | null,
): Record<string, string> {
  const options: Record<string, string> = {};
  const scale = (JSON.parse(cityFooter) as { other?: { transform?: { scale?: unknown } } }).other
    ?.transform?.scale;
  if (Array.isArray(scale) && scale.length === 3 && scale.every((s) => Number.isFinite(s))) {
    options.transform_scale = scale.join(",");
  }
  if (corner) options.transform_translate = [corner.x, corner.y, corner.z].join(",");
  return options;
}

export interface OutputLayout {
  /** The virtual-FS directory every file of this download is written under. */
  root: string;
  /** What the writer is given: a file, or a package directory ending in `/`. */
  target: string;
  /** The browser download's name. */
  download: string;
  /** Whether the files written are zipped (a package; an OBJ with its .mtl). */
  zip: boolean;
}

/** `under` is the directory downloads are written under; each run has its own in it. */
export function outputLayout(
  format: ExportFormat,
  fileName: string,
  run: number,
  under = "/export",
): OutputLayout {
  const root = `${under}/${run}`;
  const base = fileName.trim().replaceAll("/", "_");
  switch (format) {
    case "cityparquet":
      return { root, target: `${root}/${base}/`, download: `${base}.zip`, zip: true };
    case "obj":
      return { root, target: `${root}/${base}.obj`, download: `${base}-obj.zip`, zip: true };
    default: {
      const name = `${base}${FORMATS[format].extension}`;
      return { root, target: `${root}/${name}`, download: name, zip: false };
    }
  }
}

/** Schemas DuckDB has of its own; the local schema is never one of them. */
const TAKEN = new Set(["main", "temp", "memory", "system", "information_schema", "pg_catalog"]);

export interface ExportPlan {
  request: ExportRequest;
  tables: { input: ExportInput; columns: string[]; lods: readonly string[] }[];
  /** The local schema, which `cityparquet_write` also takes as the STAC Item's id. */
  schema: string;
  layout: OutputLayout;
}

/** Plans a download of the tables the request names. Call `checkRequest` first. */
export function planExport(
  inputs: readonly ExportInput[],
  request: ExportRequest,
  run: number,
  under?: string,
): ExportPlan {
  const tables = request.tables.flatMap((t) => {
    const input = inputs.find((i) => i.table.name === t.name);
    return input ? [{ input, columns: exportColumns(input.table, t), lods: t.lods }] : [];
  });
  const name = request.fileName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const schema = name === "" || TAKEN.has(name) || /^\d/.test(name) ? "subset" : name;
  return {
    request,
    tables,
    schema,
    layout: outputLayout(request.format, request.fileName, run, under),
  };
}

const SEED = "export_seed";
const KEYS = "export_keys";
const ROWS = "export_rows";

const local = (plan: ExportPlan, table: string): Sql => sql`${ident(plan.schema)}.${ident(table)}`;

const range = (c: Chunk): Sql =>
  sql`file_row_number >= ${num(c.start)} AND file_row_number < ${num(c.start + c.rows)}`;

export function setupSql(plan: ExportPlan): Sql[] {
  const names = plan.tables.map((t) => lit(t.input.table.name)).join(", ") as Sql;
  return [
    sql`CREATE OR REPLACE TABLE ${ident(SEED)} AS
SELECT DISTINCT tbl, file, "row" FROM ${ident(SELECTION_TABLE)} WHERE tbl IN (${names})`,
    sql`CREATE OR REPLACE TABLE ${ident(KEYS)} (tbl VARCHAR, file INTEGER, "row" BIGINT, feature_id VARCHAR)`,
  ];
}

/** Reads the `feature_id` of every row of one row group, by `file_row_number`. */
export const readKeysSql = (c: Chunk): Sql =>
  sql`INSERT INTO ${ident(KEYS)}
SELECT ${lit(c.table)}, ${num(c.fileIndex)}, file_row_number, feature_id
FROM read_parquet(${lit(c.file)}, file_row_number := true) WHERE ${range(c)}`;

/** `export_rows`: the seeds, and every row of a feature a seed belongs to. */
export const expandSql: Sql = sql`CREATE OR REPLACE TABLE ${ident(ROWS)} AS
WITH features AS (
  SELECT DISTINCT k.tbl, k.feature_id FROM ${ident(KEYS)} k
  JOIN ${ident(SEED)} s ON s.tbl = k.tbl AND s.file = k.file AND s."row" = k."row"
  WHERE k.feature_id IS NOT NULL
)
SELECT k.tbl, k.file, k."row" FROM ${ident(KEYS)} k JOIN features f USING (tbl, feature_id)
UNION
SELECT tbl, file, "row" FROM ${ident(SEED)}`;

/** Rows `tbl, file, row`: the wanted rows on the first or last row of a row group read. */
export function edgesSql(read: readonly Chunk[]): Sql {
  const values = read
    .flatMap((c) =>
      [c.start, c.start + c.rows - 1].map(
        (row) => `(${lit(c.table)}, ${num(c.fileIndex)}, ${num(row)})`,
      ),
    )
    .join(", ");
  return sql`SELECT DISTINCT r.tbl, r.file, r."row" FROM ${ident(ROWS)} r
JOIN (VALUES ${values as Sql}) e(tbl, file, "row") ON e.tbl = r.tbl AND e.file = r.file AND e."row" = r."row"`;
}

/** Rows `i, n`: how many wanted rows each row group read holds, by its position in `read`. */
export function rowsPerChunkSql(read: readonly Chunk[]): Sql {
  const values = read
    .map(
      (c, i) =>
        `(${num(i)}, ${lit(c.table)}, ${num(c.fileIndex)}, ${num(c.start)}, ${num(c.start + c.rows)})`,
    )
    .join(", ");
  return sql`SELECT c.i, count(*)::BIGINT AS n
FROM (VALUES ${values as Sql}) c(i, tbl, file, lo, hi)
JOIN ${ident(ROWS)} r ON r.tbl = c.tbl AND r.file = c.file AND r."row" >= c.lo AND r."row" < c.hi
GROUP BY c.i ORDER BY c.i`;
}

/** Where the wanted rows of the `i`th row group read are staged. */
export const stagePath = (plan: ExportPlan, i: number): string =>
  `${plan.layout.root}/stage/${i}.parquet`;

/**
 * Copies the wanted rows of one row group, with the chosen columns, from the remote file
 * to a staged Parquet file. Small row groups keep the Parquet writer's buffer small.
 */
export function stageSql(t: ExportPlan["tables"][number], c: Chunk, to: string): Sql {
  return sql`COPY (
SELECT ${t.columns.map(ident).join(", ") as Sql}
FROM read_parquet(${lit(c.file)}, file_row_number := true)
WHERE ${range(c)} AND file_row_number IN (
  SELECT "row" FROM ${ident(ROWS)} WHERE tbl = ${lit(c.table)} AND file = ${num(c.fileIndex)})
) TO ${lit(to)} (FORMAT parquet, ROW_GROUP_SIZE 10000)`;
}

/** What was staged for one table. */
export interface Staged {
  table: ExportPlan["tables"][number];
  files: string[];
}

const staged = (s: Staged): Sql =>
  sql`read_parquet([${s.files.map(lit).join(", ") as Sql}], union_by_name := true)`;

/**
 * For a package: the staged files as local tables, registered as a package, each with
 * its source `city` footer back.
 */
export function restoreSql(plan: ExportPlan, stage: readonly Staged[]): Sql[] {
  return [
    sql`DROP SCHEMA IF EXISTS ${ident(plan.schema)} CASCADE`,
    sql`CREATE SCHEMA ${ident(plan.schema)}`,
    ...stage.map(
      (s) =>
        sql`CREATE TABLE ${local(plan, s.table.input.table.name)} AS SELECT * FROM ${staged(s)}`,
    ),
    sql`PRAGMA cityparquet_init(${lit(plan.schema)})`,
    ...stage.map(
      ({ table: { input } }) =>
        sql`UPDATE ${local(plan, "__cityparquet")} SET city = ${lit(input.table.footer.city)}
WHERE table_name = ${lit(input.table.name)}`,
    ),
  ];
}

/** One row `x, y, z`: the minimum corner of every staged row's `bbox`. */
export function cornerSql(stage: readonly Staged[]): Sql {
  const parts = stage.map((s) => `SELECT bbox FROM ${staged(s)}`).join(" UNION ALL ");
  return sql`SELECT min(bbox.xmin) AS x, min(bbox.ymin) AS y, min(bbox.zmin) AS z FROM (${parts as Sql})`;
}

/** The statement that writes the download. `corner` comes from `cornerSql`. */
export function writeSql(plan: ExportPlan, stage: readonly Staged[], corner: Corner | null): Sql {
  const { format } = plan.request;
  const first = stage[0]?.table;
  if (!first) throw new Error("nothing to write");
  // Every table's footer states the package's one CRS; cjconv-core names it by the
  // PROJJSON's id.
  const crs = crsFromProjjson(
    JSON.stringify((JSON.parse(first.input.table.footer.city) as { crs?: unknown }).crs ?? null),
  );
  if (format === "cityparquet") {
    // `crs =>` always, as cjconv-core writes a package: the writer misreads some carried
    // footers' PROJJSON (Chuo-ku's EPSG:6697 comes out as EPSG:2011; docs/findings.md).
    const named = crs ? sql`, crs => ${lit(crsToAuthCode(crs))}` : sql``;
    return sql`SELECT file FROM cityparquet_write(${lit(plan.schema)}, ${lit(plan.layout.target)}${named})`;
  }
  const footers = stage.map(({ table }) => table.input.table.footer.city);
  const extensions = footers.some((f) => (JSON.parse(f) as { extensions?: unknown }).extensions);
  const options: Record<string, string> = {
    ...(crs ? { crs: crsToUri(crs) } : {}),
    ...(extensions
      ? {
          metadata_query: `SELECT max(cityparquet_city_field(city, 'extensions')) AS extensions FROM (VALUES ${footers.map((f) => `(${lit(f)})`).join(", ")}) f(city)`,
        }
      : {}),
    ...(format === "obj"
      ? { lod: first.lods[0] ?? "" }
      : transformOptions(first.input.table.footer.city, corner)),
  };
  // Several tables go into one file as cjconv-core does it: a union by column name.
  const relation = stage.map((s) => `SELECT * FROM ${staged(s)}`).join(" UNION ALL BY NAME ");
  return copySql({ relation, to: plan.layout.target, format, options }) as Sql;
}

/** Rows `file`: everything this download wrote. */
export const writtenSql = (plan: ExportPlan): Sql =>
  sql`SELECT file FROM glob(${lit(`${plan.layout.root}/**`)}) ORDER BY file`;

/** Drops the local schema and the expansion's tables. The written files are the caller's to drop. */
export function cleanupSql(plan: ExportPlan): Sql[] {
  return [
    sql`DROP SCHEMA IF EXISTS ${ident(plan.schema)} CASCADE`,
    ...[SEED, KEYS, ROWS].map((t) => sql`DROP TABLE IF EXISTS ${ident(t)}`),
  ];
}

export type ExportProgress =
  | { step: "expanding"; done: number; total: number }
  | { step: "reading"; done: number; total: number }
  | { step: "writing" };

/**
 * How far a run is, from 0 to 1. Finding the parts of features takes the first third,
 * reading the row groups the next half and writing the rest. A step without a count sits
 * at its start. Finding parts can add row groups, so a caller keeps the largest value.
 */
export function exportFraction(p: ExportProgress): number {
  const share = (done: number, total: number) => (total === 0 ? 0 : Math.min(done / total, 1));
  switch (p.step) {
    case "expanding":
      return 0.33 * share(p.done, p.total);
    case "reading":
      return 0.33 + 0.5 * share(p.done, p.total);
    case "writing":
      return 0.83;
  }
}

/**
 * Runs one unit of work on the engine. The app queues each on its engine and reports the
 * progress; a test runs it directly.
 */
export type ExportExec = <T>(
  progress: ExportProgress,
  work: (engine: Engine) => Promise<T>,
) => Promise<T>;

export interface ExportResult {
  /** Virtual-FS paths of the files written, under `plan.layout.root`. */
  files: string[];
  /** The staged files, which the caller drops. */
  staged: string[];
  /** Rows written per table: the selection's features, whole. */
  rows: Record<string, number>;
}

const abortError = () => new DOMException("The download was cancelled.", "AbortError");

/**
 * Runs the plan up to the written files. Between units of work it stops when `signal`
 * aborts. The local schema and tables stay until `cleanupSql`, which the caller runs
 * either way.
 */
export async function runExport(
  plan: ExportPlan,
  exec: ExportExec,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  const scope = plan.tables.flatMap((t) => t.input.scope);
  const all = new Map(plan.tables.map((t) => [t.input.table.name, chunksIn(t.input)]));

  await exec({ step: "expanding", done: 0, total: scope.length }, async (e) => {
    for (const s of setupSql(plan)) await e.exec(s);
  });
  const read = new Map<ChunkKey, Chunk>();
  let pending: Chunk[] = [...scope];
  while (pending.length > 0) {
    for (const c of pending) {
      check();
      await exec({ step: "expanding", done: read.size, total: read.size + pending.length }, (e) =>
        e.exec(readKeysSql(c)),
      );
      read.set(c.key, c);
    }
    check();
    const edges = await exec(
      { step: "expanding", done: read.size, total: read.size },
      async (e) => {
        await e.exec(expandSql);
        return (await e.query(edgesSql([...read.values()]))).map((r): EdgeRow => ({
          tbl: String(r.tbl),
          file: Number(r.file),
          row: Number(r.row),
        }));
      },
    );
    pending = [...all.values()].flatMap((chunks) =>
      neighbours(chunks, new Set(read.keys()), edges),
    );
  }

  const chunks = [...read.values()];
  const counts = await exec({ step: "reading", done: 0, total: chunks.length }, (e) =>
    e.query(rowsPerChunkSql(chunks)),
  );
  const wanted = counts.flatMap((r) => {
    const c = chunks[Number(r.i)];
    return c && Number(r.n) > 0 ? [c] : [];
  });
  const rows: Record<string, number> = {};
  for (const t of plan.tables) rows[t.input.table.name] = 0;
  for (const r of counts) {
    const c = chunks[Number(r.i)];
    if (c) rows[c.table] = (rows[c.table] ?? 0) + Number(r.n);
  }
  const stage: Staged[] = [];
  for (const [i, c] of wanted.entries()) {
    check();
    const table = plan.tables.find((x) => x.input.table.name === c.table);
    if (!table) continue;
    const to = stagePath(plan, i);
    await exec({ step: "reading", done: i, total: wanted.length }, (e) =>
      e.exec(stageSql(table, c, to)),
    );
    const held = stage.find((s) => s.table === table);
    if (held) held.files.push(to);
    else stage.push({ table, files: [to] });
  }
  const stagedFiles = stage.flatMap((s) => s.files);

  check();
  const files = await exec({ step: "writing" }, async (e) => {
    let corner: Corner | null = null;
    if (plan.request.format === "cityparquet") {
      for (const s of restoreSql(plan, stage)) await e.exec(s);
    } else if (plan.request.format !== "obj") {
      const [c] = await e.query(cornerSql(stage));
      if (c && [c.x, c.y, c.z].every((v) => typeof v === "number")) {
        corner = { x: Number(c.x), y: Number(c.y), z: Number(c.z) };
      }
    }
    await e.exec(writeSql(plan, stage, corner));
    return (await e.query(writtenSql(plan)))
      .map((r) => String(r.file))
      .filter((f) => !stagedFiles.includes(f));
  });
  return { files, staged: stagedFiles, rows };
}

/** All of an input's table's row groups, in file order, for finding neighbours. */
function chunksIn(input: ExportInput): Chunk[] {
  const files = new Set(input.scope.map((c) => c.file));
  return chunksOf(input.table).filter((c) => files.has(c.file));
}
