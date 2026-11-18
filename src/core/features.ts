// The local table of footprints the map draws, and the SQL that fills it, cuts vector
// tiles from it and fetches one feature's attributes from the remote file.
import { lodColumns } from "@cityjson/cjconv-core";
import type { Chunk } from "./chunk";
import { densifiedRing } from "./crs";
import type { TableInfo } from "./footer";
import { ident, lit, num, type Sql, sql } from "./sql";
import { type TileId, tileEnvelope } from "./tile";
import type { Url } from "./url";

/**
 * One row per footprint of every loaded chunk. Coordinates are EPSG:3857, so tiles are cut
 * without reprojecting:
 *
 * | column | |
 * | --- | --- |
 * | `chunk` INTEGER | the cache entry that loaded it |
 * | `uid` BIGINT | unique across the table; the vector tile feature id |
 * | `tbl` VARCHAR | the object table (`building`, `bridge`, …) |
 * | `file` INTEGER, `row` BIGINT | position in the table's `files`, and `file_row_number` |
 * | `id`, `feature_id`, `object_type` VARCHAR | as in the package |
 * | `xmin`, `ymin`, `xmax`, `ymax` DOUBLE | the footprint's extent |
 * | `geom` GEOMETRY | the LoD0 footprint, 2D, or the `bbox` rectangle |
 */
export const FEATURES_TABLE = "map_features";

/** The vector tile layer that holds the footprints. */
export const TILE_LAYER = "features";

export const createFeaturesSql: readonly Sql[] = [
  sql`CREATE SEQUENCE IF NOT EXISTS map_features_uid`,
  sql`CREATE TABLE IF NOT EXISTS ${ident(FEATURES_TABLE)} (
  chunk INTEGER, uid BIGINT, tbl VARCHAR, file INTEGER, "row" BIGINT,
  id VARCHAR, feature_id VARCHAR, object_type VARCHAR,
  xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE, geom GEOMETRY)`,
];

/** What a table's footprints are drawn from. */
export type Footprint =
  /** The lowest LoD 0 geometry column. */
  | { kind: "lod0"; column: string }
  /** No LoD 0: the rectangle of each object's `bbox`. */
  | { kind: "bbox" };

export function footprintOf(table: Pick<TableInfo, "lods">): Footprint {
  const lod = table.lods.find((l) => l.startsWith("0."));
  const column = lod ? lodColumns(lod)[0] : undefined;
  return column ? { kind: "lod0", column } : { kind: "bbox" };
}

/**
 * Reads one chunk's footprints into the local table, taken from `from` (what
 * `ST_Transform` takes as the source CRS) to EPSG:3857. The `file_row_number` range is
 * what prunes the read to exactly that row group; a `bbox` predicate would also read the
 * neighbours whose extents overlap it.
 */
export function loadChunkSql(chunk: Chunk, footprint: Footprint, from: string, id: number): Sql {
  const g =
    footprint.kind === "lod0"
      ? sql`ST_Force2D(${ident(footprint.column)})`
      : sql`ST_MakeEnvelope(bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax)`;
  const present =
    footprint.kind === "lod0" ? sql`${ident(footprint.column)} IS NOT NULL` : sql`bbox IS NOT NULL`;
  return sql`INSERT INTO ${ident(FEATURES_TABLE)}
SELECT ${num(id)}, nextval('map_features_uid'), ${lit(chunk.table)}, ${num(chunk.fileIndex)},
       file_row_number, id, feature_id, object_type,
       ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g), g
FROM (
  SELECT file_row_number, id, feature_id, object_type,
         ST_Transform(${g}, ${lit(from)}, 'EPSG:3857', always_xy := true) AS g
  FROM read_parquet(${lit(chunk.file)}, file_row_number := true)
  WHERE file_row_number >= ${num(chunk.start)} AND file_row_number < ${num(chunk.start + chunk.rows)}
    AND ${present}
)`;
}

/** Rows `object_type, n`: what a loaded chunk holds, for the legend. */
export const chunkTypesSql = (id: number): Sql =>
  sql`SELECT object_type, count(*)::INTEGER AS n FROM ${ident(FEATURES_TABLE)}
WHERE chunk = ${num(id)} GROUP BY ALL ORDER BY ALL`;

export const evictChunkSql = (id: number): Sql =>
  sql`DELETE FROM ${ident(FEATURES_TABLE)} WHERE chunk = ${num(id)}`;

/**
 * One row, `tile`: the vector tile `z/x/y` of every footprint that reaches into it (with
 * the buffer), as `ST_AsMVT` makes it: a layer with no features when there is none. Each feature carries
 * `uid`, `tbl`, `file`, `row`, `id` and `object_type`.
 */
export function tileSql(tile: TileId, extent = 4096, buffer = 64): Sql {
  const e = tileEnvelope(tile);
  const pad = ((e.xmax - e.xmin) * buffer) / extent;
  const box = sql`ST_Extent(ST_MakeEnvelope(${num(e.xmin)}, ${num(e.ymin)}, ${num(e.xmax)}, ${num(e.ymax)}))`;
  return sql`SELECT ST_AsMVT({'uid': uid, 'tbl': tbl, 'file': file, 'row': "row", 'id': id,
                  'object_type': object_type, 'geom': g}, ${lit(TILE_LAYER)}, ${num(extent)}) AS tile
FROM (
  SELECT *, ST_AsMVTGeom(geom, ${box}, ${num(extent)}, ${num(buffer)}, true) AS g
  FROM ${ident(FEATURES_TABLE)}
  WHERE xmax >= ${num(e.xmin - pad)} AND xmin <= ${num(e.xmax + pad)}
    AND ymax >= ${num(e.ymin - pad)} AND ymin <= ${num(e.ymax + pad)}
)
WHERE g IS NOT NULL`;
}

/**
 * Rows `i, outline, xmin, ymin, xmax, ymax`: chunk `i`'s `bbox` as a GeoJSON polygon in
 * WGS 84, densified so its edges bend as they should, and that polygon's extent. Chunks
 * without a `bbox` are left out.
 */
export function outlinesSql(chunks: readonly Chunk[], from: string, steps = 8): Sql | null {
  const rows = chunks.flatMap((c, i) => {
    if (!c.bbox) return [];
    const ring = densifiedRing(c.bbox, steps)
      .map(([x, y]) => `${num(x)} ${num(y)}`)
      .join(", ");
    return [sql`(${num(i)}, ${lit(`POLYGON((${ring}))`)})`];
  });
  if (rows.length === 0) return null;
  return sql`SELECT i, ST_AsGeoJSON(g) AS outline,
       ST_XMin(g) AS xmin, ST_YMin(g) AS ymin, ST_XMax(g) AS xmax, ST_YMax(g) AS ymax
FROM (
  SELECT i, ST_Transform(ST_GeomFromText(w), ${lit(from)}, 'EPSG:4326', always_xy := true) AS g
  FROM (VALUES ${rows.join(", ") as Sql}) AS t(i, w)
)`;
}

/** Columns not shown as attributes: geometry, appearance, templates and the bbox. */
function isGeometric(name: string, lods: readonly string[]): boolean {
  return (
    ["geometry", "geometry_properties", "material", "texture"].includes(name) ||
    ["bbox", "template", "implicit_geometry"].includes(name) ||
    lods.some((lod) => lodColumns(lod).includes(name))
  );
}

/** The columns a feature's popup shows, in file order: ids, hierarchy and attributes. */
export function popupColumns(table: Pick<TableInfo, "columns" | "lods">): string[] {
  return table.columns.map((c) => c.name).filter((name) => !isGeometric(name, table.lods));
}

/**
 * One row: the popup columns of the row at `row` in `file`, each as DuckDB's text for its
 * value (NULL stays NULL). Only the `file_row_number` predicate goes to the scan: it reads
 * that row's row group alone. Adding `id = …` makes duckdb-wasm read the `id` chunk of
 * every row group (170 requests, 38 MB, 77 s on 3DBAG), so the caller checks the id.
 */
export function attributesSql(
  table: Pick<TableInfo, "columns" | "lods">,
  file: Url,
  row: number,
): Sql {
  const columns = popupColumns(table)
    .map((name) => sql`${ident(name)}::VARCHAR AS ${ident(name)}`)
    .join(", ") as Sql;
  return sql`SELECT ${columns}
FROM read_parquet(${lit(file)}, file_row_number := true)
WHERE file_row_number = ${num(row)}`;
}
