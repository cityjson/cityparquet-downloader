// What the user has selected in one table: an area drawn on the map, an attribute filter
// and the object types the legend shows, joined by AND. `compileSelection` turns it into
// a scope (the row groups it has to look at) and one predicate; the table, the count, the
// map highlight and the download all run that predicate over the same local rows.
//
// The rows are the footprints the map has loaded into `map_features` (EPSG:3857, chosen by
// `file_row_number`), joined to the attribute columns the predicate and the table read,
// cached per row group in `scope_attrs_<chunk id>`. So the exact area test runs on
// footprints already in memory, in the projection the area was drawn in, and an
// attribute is read once per row group however often it is filtered, sorted or shown.
import { type Box, overlaps } from "./box";
import type { Chunk } from "./chunk";
import { FEATURES_TABLE, SELECTION_TABLE } from "./features";
import { compileFilter, type Filter, filterColumns } from "./filter";
import type { RowGroup } from "./footer";
import { ident, lit, num, type Sql, sql } from "./sql";
import { WEB_MERCATOR_HALF } from "./tile";

/** Longitude, latitude in WGS 84. */
export type LonLat = readonly [number, number];

/** A drawn area in WGS 84: a ring of at least three vertices, not closed. Edges are straight on the map, in Web Mercator. */
export interface Extent {
  ring: readonly LonLat[];
}

/** What the legend hides in a table: all of it, or these object types. */
export interface HiddenTypes {
  all: boolean;
  types: readonly string[];
}

export interface Selection {
  table: string;
  extent: Extent | null;
  filter: Filter | null;
  hiddenTypes: HiddenTypes;
}

/** A row group the map has placed, and its id in `map_features`. */
export interface ScopeChunk {
  chunk: Chunk;
  id: number;
}

export interface Scope {
  /** What chose the row groups: the drawn area, the whole table, or the map's view. */
  basis: "extent" | "table" | "view";
  chunks: readonly ScopeChunk[];
  rows: number;
}

export type SelectionPlan =
  | {
      kind: "ready";
      scope: Scope;
      /** Over the scope's rows: `__geom` (EPSG:3857), `object_type` and attribute columns by name. */
      where: Sql;
      /** The attribute columns `where` reads, which the scope must hold. */
      columns: readonly string[];
    }
  | { kind: "too-large"; scope: Scope; limit: number };

/**
 * The most rows a selection looks at: about six 3DBAG row groups. Each costs a footprint
 * read (1.4 to 4.5 s in wasm) and an attribute read (1.4 to 2.5 s); measured in
 * docs/findings.md.
 */
export const SELECTION_ROW_LIMIT = 400_000;

/** Columns `map_features` holds for every footprint, so they are never read again. */
const MAP_COLUMNS = new Set(["id", "feature_id", "object_type"]);

/** The columns among these that have to come from the files. */
export const attributeColumns = (columns: readonly string[]): string[] =>
  [...new Set(columns)].filter((c) => !MAP_COLUMNS.has(c));

export function parseExtent(points: readonly (readonly number[])[]): Extent {
  const ring = points.map((p): LonLat => {
    const [lon, lat] = p;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error("a vertex is not a number");
    if (Math.abs(lat as number) > 90) throw new Error(`latitude ${lat} is out of range`);
    return [lon as number, lat as number];
  });
  const [first, last] = [ring[0], ring.at(-1)];
  if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) ring.pop();
  if (ring.length < 3) throw new Error("an area needs at least three vertices");
  return { ring };
}

/** A WGS 84 point in EPSG:3857 metres. */
export function toMercator([lon, lat]: LonLat): [number, number] {
  const x = (lon / 180) * WEB_MERCATOR_HALF;
  const y = (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) * WEB_MERCATOR_HALF;
  return [x, y];
}

/** An EPSG:3857 point in WGS 84. */
export function fromMercator([x, y]: readonly [number, number]): [number, number] {
  const lon = (x / WEB_MERCATOR_HALF) * 180;
  const lat = (Math.atan(Math.exp((y / WEB_MERCATOR_HALF) * Math.PI)) * 360) / Math.PI - 90;
  return [lon, lat];
}

/**
 * The area's extent in WGS 84. Its edges are straight in Web Mercator, where longitude and
 * latitude both change monotonically along an edge, so the vertices bound it.
 */
export function extentBox({ ring }: Extent): Box {
  return {
    xmin: Math.min(...ring.map((p) => p[0])),
    ymin: Math.min(...ring.map((p) => p[1])),
    xmax: Math.max(...ring.map((p) => p[0])),
    ymax: Math.max(...ring.map((p) => p[1])),
  };
}

/** The area as a closed polygon in EPSG:3857, made valid if the user drew it crossing itself. */
function extentSql(extent: Extent): Sql {
  const ring = [...extent.ring, extent.ring[0] as LonLat]
    .map((p) => toMercator(p).map(num).join(" "))
    .join(", ");
  return sql`ST_MakeValid(ST_GeomFromText(${lit(`POLYGON((${ring}))`)}))`;
}

function scopeOf(
  extent: Extent | null,
  chunks: readonly ScopeChunk[],
  view: readonly ScopeChunk[],
  limit: number,
): Scope {
  const of = (basis: Scope["basis"], picked: readonly ScopeChunk[]): Scope => ({
    basis,
    chunks: picked,
    rows: picked.reduce((n, c) => n + c.chunk.rows, 0),
  });
  if (extent) {
    const box = extentBox(extent);
    return of(
      "extent",
      chunks.filter((c) => c.chunk.wgs84 === null || overlaps(c.chunk.wgs84, box)),
    );
  }
  const whole = of("table", chunks);
  return whole.rows <= limit ? whole : of("view", view);
}

/**
 * The scope and the predicate of a table's selection. `chunks` are the table's row groups
 * as the map placed them, `view` those of them the map's view touches. With an area, the
 * scope is the row groups its box overlaps; without one, the whole table when it fits
 * the limit, else the row groups in view.
 */
export function compileSelection(
  selection: Selection,
  table: { columns: readonly { name: string }[] },
  chunks: readonly ScopeChunk[],
  view: readonly ScopeChunk[],
  limit = SELECTION_ROW_LIMIT,
): SelectionPlan {
  const scope = scopeOf(selection.extent, chunks, view, limit);
  if (scope.rows > limit) return { kind: "too-large", scope, limit };
  const { extent, filter, hiddenTypes } = selection;
  if (hiddenTypes.all) return { kind: "ready", scope, where: "FALSE" as Sql, columns: [] };
  const parts: Sql[] = [];
  if (extent) parts.push(sql`ST_Intersects(__geom, ${extentSql(extent)})`);
  if (hiddenTypes.types.length > 0) {
    parts.push(
      sql`${ident("object_type")} NOT IN (${hiddenTypes.types.map(lit).join(", ") as Sql})`,
    );
  }
  if (filter) parts.push(compileFilter(filter));
  const known = new Set(table.columns.map((c) => c.name));
  return {
    kind: "ready",
    scope,
    where: (parts.length === 0 ? "TRUE" : parts.map((p) => `(${p})`).join(" AND ")) as Sql,
    columns: attributeColumns(filter ? filterColumns(filter) : []).filter((c) => known.has(c)),
  };
}

/** The local table that holds a chunk's attribute columns, keyed by `__row`. */
export const attrsTable = (id: number): string => `scope_attrs_${id}`;

/**
 * Reads `columns` of one row group into its attribute table, joined to the `held` columns
 * already there. The `file_row_number` range prunes the read to that row group alone.
 */
export function loadAttrsSql(
  { chunk, id }: ScopeChunk,
  columns: readonly string[],
  held: readonly string[],
): Sql {
  if (columns.length === 0) throw new Error("no columns to read");
  const read = sql`SELECT file_row_number AS __row, ${columns.map(ident).join(", ") as Sql}
  FROM read_parquet(${lit(chunk.file)}, file_row_number := true)
  WHERE file_row_number >= ${num(chunk.start)} AND file_row_number < ${num(chunk.start + chunk.rows)}`;
  const t = ident(attrsTable(id));
  return held.length === 0
    ? sql`CREATE OR REPLACE TABLE ${t} AS ${read}`
    : sql`CREATE OR REPLACE TABLE ${t} AS
SELECT a.*, b.* EXCLUDE (__row) FROM ${t} a JOIN (${read}) b USING (__row)`;
}

export const dropAttrsSql = (id: number): Sql => sql`DROP TABLE IF EXISTS ${ident(attrsTable(id))}`;

/**
 * The scope's rows: from `map_features`, `__uid, __tbl, __file, __row, __geom` and the
 * footprint's EPSG:3857 extent `__xmin … __ymax`, then `id, feature_id, object_type`, then
 * `columns` from the attribute tables, which must hold them.
 */
export function scopeSql(chunks: readonly ScopeChunk[], columns: readonly string[]): Sql {
  if (chunks.length === 0) throw new Error("the scope holds no row groups");
  const attrs = attributeColumns(columns);
  return chunks
    .map(({ id }) => {
      const cols = attrs.map((c) => `, a.${ident(c)}`).join("");
      const join = attrs.length > 0 ? ` JOIN ${ident(attrsTable(id))} a ON a.__row = f."row"` : "";
      return `SELECT f.uid AS __uid, f.tbl AS __tbl, f.file AS __file, f."row" AS __row, f.geom AS __geom,
  f.xmin AS __xmin, f.ymin AS __ymin, f.xmax AS __xmax, f.ymax AS __ymax,
  f.id, f.feature_id, f.object_type${cols}
FROM ${ident(FEATURES_TABLE)} f${join} WHERE f.chunk = ${num(id)}`;
    })
    .join("\nUNION ALL\n") as Sql;
}

type ReadyPlan = Pick<Extract<SelectionPlan, { kind: "ready" }>, "where" | "columns">;

/** One row, `n`: how many of the scope's rows the selection holds. */
export const selectionCountSql = (chunks: readonly ScopeChunk[], plan: ReadyPlan): Sql =>
  sql`SELECT count(*)::BIGINT AS n FROM (${scopeSql(chunks, plan.columns)}) s WHERE ${plan.where}`;

export interface Page {
  sort: { column: string; direction: "asc" | "desc" } | null;
  limit: number;
  offset: number;
}

/**
 * One page of the selection: `__uid, __file, __row, __id, __type`, the footprint's EPSG:3857
 * extent `__xmin … __ymax`, then each `shown`
 * column as DuckDB's text for it. Sorted by the column's own type, nulls last, then by
 * `__uid` so pages do not overlap.
 */
export function selectionPageSql(
  chunks: readonly ScopeChunk[],
  plan: ReadyPlan,
  shown: readonly string[],
  page: Page,
): Sql {
  const columns = [...plan.columns, ...shown, ...(page.sort ? [page.sort.column] : [])];
  const cells = shown.map((c) => `, CAST(s.${ident(c)} AS VARCHAR) AS ${ident(c)}`).join("");
  const order = page.sort
    ? `s.${ident(page.sort.column)} ${page.sort.direction === "asc" ? "ASC" : "DESC"} NULLS LAST, s.__uid`
    : "s.__uid";
  return sql`SELECT s.__uid, s.__file, s.__row, s.id AS __id, s.object_type AS __type,
  s.__xmin, s.__ymin, s.__xmax, s.__ymax${cells as Sql}
FROM (${scopeSql(chunks, columns)}) s
WHERE ${plan.where}
ORDER BY ${order as Sql} LIMIT ${num(page.limit)} OFFSET ${num(page.offset)}`;
}

/** Rows `v, n`: the column's most common values in the scope, as text, at most `limit`. */
export function distinctValuesSql(
  chunks: readonly ScopeChunk[],
  column: string,
  limit: number,
): Sql {
  return sql`SELECT CAST(s.${ident(column)} AS VARCHAR) AS v, count(*)::BIGINT AS n
FROM (${scopeSql(chunks, [column])}) s WHERE s.${ident(column)} IS NOT NULL
GROUP BY ALL ORDER BY n DESC, v LIMIT ${num(limit)}`;
}

/**
 * Replaces `table`'s rows in `selection_rows` (made with `createFeaturesSql`) with what its
 * selection holds now.
 */
export function materialiseSql(
  table: string,
  chunks: readonly ScopeChunk[],
  plan: ReadyPlan | null,
): Sql[] {
  const target = ident(SELECTION_TABLE);
  const statements = [sql`DELETE FROM ${target} WHERE tbl = ${lit(table)}`];
  if (plan && chunks.length > 0) {
    statements.push(sql`INSERT INTO ${target}
SELECT __tbl, __file, __row FROM (${scopeSql(chunks, plan.columns)}) s WHERE ${plan.where}`);
  }
  return statements;
}

/** The row groups behind the scope's chunks, from the table's footer. */
export function scopeRowGroups(
  rowGroups: readonly RowGroup[],
  chunks: readonly ScopeChunk[],
): RowGroup[] {
  return chunks.flatMap(({ chunk }) =>
    rowGroups.filter((g) => g.file === chunk.file && g.index === chunk.index),
  );
}

/**
 * The bytes a download of `selected` rows would read: the row groups' compressed bytes
 * (only `columns`, when given) times the selected share of their rows.
 */
export function estimateBytes(
  rowGroups: readonly RowGroup[],
  selected: number,
  columns?: readonly string[],
): number {
  const rows = rowGroups.reduce((n, g) => n + g.rows, 0);
  if (rows === 0) return 0;
  const bytes = rowGroups.reduce(
    (n, g) => n + (columns ? columns.reduce((m, c) => m + (g.columnBytes[c] ?? 0), 0) : g.bytes),
    0,
  );
  return Math.round((bytes * selected) / rows);
}
