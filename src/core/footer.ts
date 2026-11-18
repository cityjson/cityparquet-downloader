// What a table's Parquet footers say: its `city` and `geo` keys, its schema, and per row
// group the row count, the bytes and the `bbox` extent. Three statements read them, all
// from footers only; `parseTable` turns their rows into a TableInfo.
import { analyzeColumns, type Column, type Row } from "@cityjson/cjconv-core";
import { type Box, boxFrom, union } from "./box";
import { type Crs, parseCrs } from "./crs";
import { fileList, type Sql, sql } from "./sql";
import type { Url } from "./url";

export type { Column };

export interface RowGroup {
  file: Url;
  /** The row group's position in its file. */
  index: number;
  rows: number;
  /** Compressed bytes of all its column chunks. */
  bytes: number;
  /** Its extent from the `bbox` column statistics; null when the writer wrote none. */
  bbox: Box | null;
  /** Compressed bytes per top-level column. */
  columnBytes: Record<string, number>;
}

export interface TableInfo {
  name: string;
  files: Url[];
  rowCount: number;
  crs: Crs;
  /** LoDs of the `geometry_lod*` columns, e.g. `["0.0", "2.2"]`, sorted. */
  lods: string[];
  /** Every column, in file order, as DuckDB types it. */
  columns: Column[];
  /** Columns the specification reserves: ids, hierarchy, bbox, geometry, appearance. */
  reserved: Column[];
  attributes: Column[];
  rowGroups: RowGroup[];
  /** The union of the row-group extents, in the table's CRS. */
  extent: Box | null;
  /** The first file's footer keys, as text, for writing a subset back. */
  footer: { city: string; geo: string | null };
}

export class FooterError extends Error {
  override name = "FooterError";
}

/** Rows `file_name, key, value` for the `city` and `geo` footer keys. */
export const kvSql = (files: readonly Url[]): Sql =>
  sql`SELECT file_name, decode(key) AS key, decode(value) AS value
FROM parquet_kv_metadata(${fileList(files)}) WHERE decode(key) IN ('city', 'geo')`;

/** Rows `column_name, column_type`. Reads the first file's footer. */
export const describeSql = (files: readonly Url[]): Sql =>
  sql`DESCRIBE SELECT * FROM read_parquet(${fileList(files)})`;

/**
 * One row per row group: `file_name, row_group_id, rows, bytes`, the `bbox` extent from
 * the statistics of its `xmin … ymax` fields, and `columns`, the bytes per top-level
 * column. `stats_*_value` are text, so they are cast here.
 */
export const rowGroupsSql = (files: readonly Url[]): Sql =>
  sql`WITH chunks AS (
  SELECT file_name, row_group_id, row_group_num_rows, path_in_schema, stats_min_value,
         stats_max_value, total_compressed_size
  FROM parquet_metadata(${fileList(files)})
), per_column AS (
  SELECT file_name, row_group_id, split_part(path_in_schema, ', ', 1) AS column,
         sum(total_compressed_size)::BIGINT AS bytes
  FROM chunks GROUP BY ALL
), per_group AS (
  SELECT file_name, row_group_id,
         any_value(row_group_num_rows) AS rows,
         sum(total_compressed_size)::BIGINT AS bytes,
         max(TRY_CAST(stats_min_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, xmin') AS xmin,
         max(TRY_CAST(stats_min_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, ymin') AS ymin,
         max(TRY_CAST(stats_max_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, xmax') AS xmax,
         max(TRY_CAST(stats_max_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, ymax') AS ymax
  FROM chunks GROUP BY ALL
)
SELECT g.*, list({'column': c.column, 'bytes': c.bytes}) AS columns
FROM per_group g JOIN per_column c USING (file_name, row_group_id)
GROUP BY ALL ORDER BY file_name, row_group_id`;

export function parseTable(
  name: string,
  files: Url[],
  kvRows: Row[],
  describeRows: Row[],
  rowGroupRows: Row[],
): TableInfo {
  const first = files[0];
  const key = (k: string) =>
    kvRows.find((r) => r.key === k && r.file_name === first)?.value as string | undefined;
  const city = key("city");
  if (city === undefined) {
    throw new FooterError(`${first} has no "city" footer key, so it is not a CityParquet file`);
  }
  let cityObject: { crs?: unknown };
  try {
    cityObject = JSON.parse(city) as { crs?: unknown };
  } catch {
    throw new FooterError(`${first}: the "city" footer key is not JSON`);
  }

  const columns = describeRows.map((r) => ({
    name: text(r.column_name, "column_name"),
    type: text(r.column_type, "column_type"),
  }));
  const schema = analyzeColumns(columns);
  const attributes = new Set(schema.attributes.map((c) => c.name));

  const fileOf = new Map(files.map((f) => [String(f), f]));
  const rowGroups = rowGroupRows.map((r): RowGroup => {
    const file = fileOf.get(text(r.file_name, "file_name"));
    if (!file) throw new FooterError(`parquet_metadata named a file not asked for: ${r.file_name}`);
    const columnBytes: Record<string, number> = {};
    for (const c of (r.columns ?? []) as Row[])
      columnBytes[text(c.column, "column")] = count(c.bytes);
    return {
      file,
      index: count(r.row_group_id),
      rows: count(r.rows),
      bytes: count(r.bytes),
      bbox: boxFrom(r),
      columnBytes,
    };
  });

  return {
    name,
    files,
    rowCount: rowGroups.reduce((n, g) => n + g.rows, 0),
    crs: parseCrs(cityObject),
    lods: schema.lods,
    columns,
    reserved: columns.filter((c) => !attributes.has(c.name)),
    attributes: schema.attributes,
    rowGroups,
    extent: union(rowGroups.flatMap((g) => (g.bbox ? [g.bbox] : []))),
    footer: { city, geo: key("geo") ?? null },
  };
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new FooterError(`expected text for ${what}, got ${value}`);
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FooterError(`expected a number, got ${value}`);
  }
  return value;
}
