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
//   3. part      `export_parts`: the rows in file order, cut into parts of about
//                `EXPORT_PART_BYTES`, a feature never split. Then, per part:
//   4. fetch     the chosen columns of the part's rows, one row group at a time, into
//                `<schema>.<table>`
//   5. restore   `cityparquet_init`, then each table's source `city` footer into
//                `<schema>.__cityparquet`, so the writer keeps the CRS and source metadata
//   6. write     `cityparquet_write`, or one `COPY … (FORMAT …)` over the union of the tables
//   7. take      the caller moves the part's files out of the engine, and the local schema
//                is dropped, so memory holds one part at a time
import {
  analyzeColumns,
  copySql,
  crsFromProjjson,
  crsToAuthCode,
  crsToUri,
  type Engine,
  FORMATS,
  type FormatId,
  quoteIdent,
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
 * The compressed bytes of the chosen columns one part of a download holds. DuckDB's wasm
 * heap cannot grow past 4 GiB, and writing takes about 45 to 85 times this in memory on
 * top of the map's: on 3DBAG, 19.3 MB written at once took the tab from 1.4 to 3.0 GiB as
 * CityJSON. A larger download is written as several parts. Measured in docs/findings.md.
 */
export const EXPORT_PART_BYTES = 8_000_000;

/**
 * The most compressed bytes a download keeps. The files come out 2 (CityParquet) to 5
 * (CityJSON) times this, and the browser holds them as the zip being built, which cannot
 * pass 4 GiB: this keeps a download to about 1 GB. On 3DBAG, 164 MB (131,009 buildings)
 * became a 622 MB zip of CityJSONSeq with the tab at 1.9 GiB throughout.
 */
export const EXPORT_SIZE_LIMIT = 250_000_000;

export interface ExportEstimate {
  /** Selected rows (before features are completed). */
  selected: number;
  rowGroups: number;
  /** Compressed bytes of the chosen columns in the scope's row groups: what is fetched. */
  readBytes: number;
  /** The selected share of `readBytes`: roughly what the output holds, compressed. */
  keptBytes: number;
  /** About how many parts it is written as. */
  parts: number;
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
  limit = EXPORT_SIZE_LIMIT,
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
  return {
    selected,
    rowGroups,
    readBytes,
    keptBytes,
    parts: Math.max(1, Math.ceil(keptBytes / EXPORT_PART_BYTES)),
    limit,
    tooLarge: keptBytes > limit,
  };
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
  /**
   * Whether the files written are zipped (a package; an OBJ with its .mtl; several
   * parts). A zip entry is the file's path under `root`.
   */
  zip: boolean;
}

/** Which part of how many a layout is for. */
export interface Part {
  index: number;
  count: number;
}

/**
 * Where a download, or one part of it, is written. A download in several parts is a zip
 * of complete files or packages named `<name>-part-001`, `-002`, ….
 */
export function outputLayout(
  format: ExportFormat,
  fileName: string,
  run: number,
  part: Part = { index: 0, count: 1 },
): OutputLayout {
  const root = `/export/${run}`;
  const base = fileName.trim().replaceAll("/", "_");
  const split = part.count > 1;
  const name = split ? `${base}-part-${String(part.index + 1).padStart(3, "0")}` : base;
  switch (format) {
    case "cityparquet":
      return {
        root,
        target: split ? `${root}/${base}/${name}/` : `${root}/${base}/`,
        download: `${base}.zip`,
        zip: true,
      };
    case "obj":
      return {
        root,
        target: `${root}/${base}/${name}.obj`,
        download: `${base}-obj.zip`,
        zip: true,
      };
    default: {
      const file = `${name}${FORMATS[format].extension}`;
      return split
        ? { root, target: `${root}/${base}/${file}`, download: `${base}.zip`, zip: true }
        : { root, target: `${root}/${file}`, download: file, zip: false };
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
  /** Numbers the virtual-FS directory, so runs do not share one. */
  run: number;
  /** The layout when the download is one part. */
  layout: OutputLayout;
}

/** Plans a download of the tables the request names. Call `checkRequest` first. */
export function planExport(
  inputs: readonly ExportInput[],
  request: ExportRequest,
  run: number,
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
    run,
    layout: outputLayout(request.format, request.fileName, run),
  };
}

const SEED = "export_seed";
const KEYS = "export_keys";
const ROWS = "export_rows";
const PARTS = "export_parts";

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

const chunkValues = (read: readonly Chunk[], extra: (c: Chunk, i: number) => string): Sql =>
  read
    .map(
      (c, i) =>
        `(${num(i)}, ${lit(c.table)}, ${num(c.fileIndex)}, ${num(c.start)}, ${num(c.start + c.rows)}, ${extra(c, i)})`,
    )
    .join(", ") as Sql;

/**
 * `export_parts (tbl, file, row, part)`: the wanted rows in file order, cut wherever the
 * running sum of `weight` (a row's bytes in its row group) passes a multiple of
 * `partBytes`. A feature goes whole to the part its first row falls in. Parts count from 0.
 */
export function partsSql(
  read: readonly Chunk[],
  weight: (c: Chunk) => number,
  partBytes = EXPORT_PART_BYTES,
): Sql {
  return sql`CREATE OR REPLACE TABLE ${ident(PARTS)} AS
WITH weighed AS (
  SELECT r.tbl, r.file, r."row", k.feature_id, c.w
  FROM ${ident(ROWS)} r
  JOIN (VALUES ${chunkValues(read, (c) => num(weight(c)))}) c(i, tbl, file, lo, hi, w)
    ON c.tbl = r.tbl AND c.file = r.file AND r."row" >= c.lo AND r."row" < c.hi
  LEFT JOIN ${ident(KEYS)} k ON k.tbl = r.tbl AND k.file = r.file AND k."row" = r."row"
), placed AS (
  SELECT *, sum(w) OVER (ORDER BY tbl, file, "row") AS pos FROM weighed
), started AS (
  SELECT *, min(pos) OVER (
    PARTITION BY tbl, coalesce(feature_id, file::VARCHAR || ':' || "row"::VARCHAR)) AS first_pos
  FROM placed
)
SELECT tbl, file, "row",
  (dense_rank() OVER (ORDER BY floor(first_pos / ${num(partBytes)})) - 1)::INTEGER AS part
FROM started`;
}

/** Rows `part, i, n`: how many rows of each part each row group read holds, by its position in `read`. */
export function rowsPerPartSql(read: readonly Chunk[]): Sql {
  return sql`SELECT p.part, c.i, count(*)::BIGINT AS n
FROM (VALUES ${chunkValues(read, () => "0")}) c(i, tbl, file, lo, hi, w)
JOIN ${ident(PARTS)} p ON p.tbl = c.tbl AND p.file = c.file AND p."row" >= c.lo AND p."row" < c.hi
GROUP BY p.part, c.i ORDER BY p.part, c.i`;
}

/** A part's local schema, empty. */
export const schemaSql = (plan: ExportPlan): Sql[] => [
  sql`DROP SCHEMA IF EXISTS ${ident(plan.schema)} CASCADE`,
  sql`CREATE SCHEMA ${ident(plan.schema)}`,
];

/** An empty local table with the columns a download reads, typed as in the file. */
export const createTableSql = (plan: ExportPlan, t: ExportPlan["tables"][number]): Sql => {
  const first = t.input.table.files[0];
  if (!first) throw new Error(`${t.input.table.name} has no files`);
  return sql`CREATE TABLE ${local(plan, t.input.table.name)} AS
SELECT ${t.columns.map(ident).join(", ") as Sql} FROM read_parquet(${lit(first)}) LIMIT 0`;
};

/** A part's rows of one row group, with the chosen columns, into the local table. */
export function fetchSql(
  plan: ExportPlan,
  t: ExportPlan["tables"][number],
  c: Chunk,
  part: number,
): Sql {
  return sql`INSERT INTO ${local(plan, t.input.table.name)} BY NAME
SELECT ${t.columns.map(ident).join(", ") as Sql}
FROM read_parquet(${lit(c.file)}, file_row_number := true)
WHERE ${range(c)} AND file_row_number IN (
  SELECT "row" FROM ${ident(PARTS)}
  WHERE tbl = ${lit(c.table)} AND file = ${num(c.fileIndex)} AND part = ${num(part)})`;
}

/** Registers the local tables as a package and gives each its source `city` footer back. */
export function restoreSql(plan: ExportPlan): Sql[] {
  return [
    sql`PRAGMA cityparquet_init(${lit(plan.schema)})`,
    ...plan.tables.map(
      ({ input }) =>
        sql`UPDATE ${local(plan, "__cityparquet")} SET city = ${lit(input.table.footer.city)}
WHERE table_name = ${lit(input.table.name)}`,
    ),
  ];
}

/** One row `x, y, z`: the minimum corner of every local table's `bbox`. */
export function cornerSql(plan: ExportPlan): Sql {
  const parts = plan.tables
    .map(({ input }) => `SELECT bbox FROM ${local(plan, input.table.name)}`)
    .join(" UNION ALL ");
  return sql`SELECT min(bbox.xmin) AS x, min(bbox.ymin) AS y, min(bbox.zmin) AS z FROM (${parts as Sql})`;
}

/** The statement that writes the download. `corner` comes from `cornerSql`. */
export function writeSql(plan: ExportPlan, corner: Corner | null): Sql {
  const { format } = plan.request;
  const first = plan.tables[0];
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
  const extensions = plan.tables.some(
    ({ input }) => (JSON.parse(input.table.footer.city) as { extensions?: unknown }).extensions,
  );
  const options: Record<string, string> = {
    ...(crs ? { crs: crsToUri(crs) } : {}),
    ...(extensions
      ? {
          metadata_query: `SELECT max(cityparquet_city_field(city, 'extensions')) AS extensions FROM ${quoteIdent(plan.schema)}.${quoteIdent("__cityparquet")} WHERE role = 'object'`,
        }
      : {}),
    ...(format === "obj"
      ? { lod: first.lods[0] ?? "" }
      : transformOptions(first.input.table.footer.city, corner)),
  };
  // Several tables go into one file as cjconv-core does it: a union by column name.
  const relation = plan.tables
    .map(({ input }) => `SELECT * FROM ${local(plan, input.table.name)}`)
    .join(" UNION ALL BY NAME ");
  return copySql({ relation, to: plan.layout.target, format, options }) as Sql;
}

/** Rows `file`: everything this download wrote. */
export const writtenSql = (plan: ExportPlan): Sql =>
  sql`SELECT file FROM glob(${lit(`${plan.layout.root}/**`)}) ORDER BY file`;

/** Drops the local schema and the expansion's tables. The written files are the caller's to drop. */
export function cleanupSql(plan: ExportPlan): Sql[] {
  return [
    sql`DROP SCHEMA IF EXISTS ${ident(plan.schema)} CASCADE`,
    ...[SEED, KEYS, ROWS, PARTS].map((t) => sql`DROP TABLE IF EXISTS ${ident(t)}`),
  ];
}

export type ExportProgress =
  | { step: "expanding"; done: number; total: number }
  /** `done` of `total` row groups of part `part` (from 0) of `parts`. */
  | { step: "reading"; done: number; total: number; part: number; parts: number }
  | { step: "writing"; part: number; parts: number };

/**
 * How far a run is, from 0 to 1. Finding the parts of features takes the first quarter;
 * the parts share the rest, each reading its row groups and then writing. Finding parts
 * of features can add row groups, so a caller keeps the largest value.
 */
export function exportFraction(p: ExportProgress): number {
  const share = (done: number, total: number) => (total === 0 ? 0 : Math.min(done / total, 1));
  const within = (part: number, parts: number, at: number) =>
    0.25 + (0.75 * (part + at)) / Math.max(parts, 1);
  switch (p.step) {
    case "expanding":
      return 0.25 * share(p.done, p.total);
    case "reading":
      return within(p.part, p.parts, 0.6 * share(p.done, p.total));
    case "writing":
      return within(p.part, p.parts, 0.6);
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

/**
 * Takes the files one part wrote, laid out as `layout`. The app moves them out of the
 * engine and drops them, so the next part has the memory.
 */
export type ExportTake = (files: string[], layout: OutputLayout) => Promise<void>;

export interface ExportResult {
  /** Virtual-FS paths of every file written, under `layout.root`. */
  files: string[];
  /** Rows written per table: the selection's features, whole. */
  rows: Record<string, number>;
  parts: number;
  /** The first part's layout: its `download` and `zip` hold for the whole download. */
  layout: OutputLayout;
}

const abortError = () => new DOMException("The download was cancelled.", "AbortError");

/**
 * Runs the plan, a part at a time, handing each part's files to `take`. Between units of
 * work it stops when `signal` aborts. The local tables stay until `cleanupSql`, which the
 * caller runs either way.
 */
export async function runExport(
  plan: ExportPlan,
  exec: ExportExec,
  take: ExportTake = async () => {},
  signal?: AbortSignal,
  partBytes = EXPORT_PART_BYTES,
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
  // A row's share of the chosen columns' compressed bytes in its row group.
  const weight = (c: Chunk): number => {
    const t = plan.tables.find((x) => x.input.table.name === c.table);
    const group = t?.input.table.rowGroups.find((g) => g.file === c.file && g.index === c.index);
    return t && group && c.rows > 0 ? bytesOf([group], t.columns) / c.rows : 0;
  };
  const counts = await exec({ step: "expanding", done: read.size, total: read.size }, async (e) => {
    await e.exec(partsSql(chunks, weight, partBytes));
    return e.query(rowsPerPartSql(chunks));
  });
  const parts: Chunk[][] = [];
  const rows: Record<string, number> = {};
  for (const t of plan.tables) rows[t.input.table.name] = 0;
  for (const r of counts) {
    const c = chunks[Number(r.i)];
    if (!c) continue;
    (parts[Number(r.part)] ??= []).push(c);
    rows[c.table] = (rows[c.table] ?? 0) + Number(r.n);
  }

  const count = parts.length;
  const layoutOf = (index: number) =>
    outputLayout(plan.request.format, plan.request.fileName, plan.run, { index, count });
  const files: string[] = [];
  for (const [part, wanted] of parts.entries()) {
    check();
    // The tables with rows in this part; the writers are given no empty table.
    const tables = plan.tables.filter((t) => wanted.some((c) => c.table === t.input.table.name));
    const partPlan: ExportPlan = { ...plan, tables, layout: layoutOf(part) };
    await exec(
      { step: "reading", done: 0, total: wanted.length, part, parts: count },
      async (e) => {
        for (const s of schemaSql(partPlan)) await e.exec(s);
        for (const t of tables) await e.exec(createTableSql(partPlan, t));
      },
    );
    for (const [i, c] of wanted.entries()) {
      check();
      const t = tables.find((x) => x.input.table.name === c.table);
      if (!t) continue;
      await exec({ step: "reading", done: i, total: wanted.length, part, parts: count }, (e) =>
        e.exec(fetchSql(partPlan, t, c, part)),
      );
    }
    check();
    const written = await exec({ step: "writing", part, parts: count }, async (e) => {
      for (const s of restoreSql(partPlan)) await e.exec(s);
      let corner: Corner | null = null;
      if (plan.request.format !== "cityparquet" && plan.request.format !== "obj") {
        const [c] = await e.query(cornerSql(partPlan));
        if (c && [c.x, c.y, c.z].every((v) => typeof v === "number")) {
          corner = { x: Number(c.x), y: Number(c.y), z: Number(c.z) };
        }
      }
      await e.exec(writeSql(partPlan, corner));
      const all = (await e.query(writtenSql(partPlan))).map((r) => String(r.file));
      // Free the part's rows before its files are taken out.
      await e.exec(schemaSql(partPlan)[0] as Sql);
      return all.filter((f) => !files.includes(f));
    });
    files.push(...written);
    await take(written, partPlan.layout);
  }
  return { files, rows, parts: count, layout: layoutOf(0) };
}

/** All of an input's table's row groups, in file order, for finding neighbours. */
function chunksIn(input: ExportInput): Chunk[] {
  const files = new Set(input.scope.map((c) => c.file));
  return chunksOf(input.table).filter((c) => files.has(c.file));
}
