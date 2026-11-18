// The map reads a table one row group at a time. A chunk is one row group of one file,
// addressed by the file_row_number range it holds, which lets statistics prune the read
// to exactly that row group.
import { type Box, overlaps } from "./box";
import type { TableInfo } from "./footer";
import type { Url } from "./url";

declare const chunkBrand: unique symbol;
/** Identifies a chunk across the package: table, file and row group. */
export type ChunkKey = string & { readonly [chunkBrand]: true };

export interface Chunk {
  key: ChunkKey;
  table: string;
  file: Url;
  /** The file's position in its table's `files`. */
  fileIndex: number;
  /** The row group's position in its file. */
  index: number;
  /** The `file_row_number` of its first row. */
  start: number;
  rows: number;
  /** Its extent in the table's CRS, from the footer; null when the writer wrote none. */
  bbox: Box | null;
  /** Its extent in WGS 84, longitude as x; null until transformed, or with no bbox. */
  wgs84: Box | null;
}

/**
 * The views on which footprints are read and drawn: those touching at most this many row
 * groups, since each is a read of its own. On 3DBAG (row groups of 65,536 rows, about 9 by
 * 12 km) a view of Delft at zoom 14 touches 4. Measured in docs/findings.md.
 */
export const FOOTPRINT_ROW_GROUP_LIMIT = 6;

/**
 * Or those touching at most this many rows, however many row groups hold them: a package
 * cut into small row groups (the fixtures) shows its footprints at once.
 */
export const FOOTPRINT_SMALL_VIEW_ROWS = 20_000;

/** The table's row groups as chunks, in file order; `wgs84` is left null. */
export function chunksOf(table: Pick<TableInfo, "name" | "files" | "rowGroups">): Chunk[] {
  return table.files.flatMap((file, fileIndex) => {
    const groups = table.rowGroups.filter((g) => g.file === file).sort((a, b) => a.index - b.index);
    let start = 0;
    return groups.map((g): Chunk => {
      const chunk: Chunk = {
        key: `${table.name}|${g.index}|${file}` as ChunkKey,
        table: table.name,
        file,
        fileIndex,
        index: g.index,
        start,
        rows: g.rows,
        bbox: g.bbox,
        wgs84: null,
      };
      start += g.rows;
      return chunk;
    });
  });
}

/** The chunks a WGS 84 view overlaps. One with no extent cannot be ruled out, so it counts. */
export function touchedChunks(chunks: readonly Chunk[], view: Box): Chunk[] {
  return chunks.filter((c) => c.wgs84 === null || overlaps(c.wgs84, view));
}

export type RegimeKind = "overview" | "footprints";

/**
 * Footprints when the view touches between one and `limit` row groups, or few rows in
 * all; else the overview.
 */
export function regimeFor(
  touched: readonly Pick<Chunk, "rows">[],
  limit = FOOTPRINT_ROW_GROUP_LIMIT,
  smallRows = FOOTPRINT_SMALL_VIEW_ROWS,
): RegimeKind {
  if (touched.length === 0) return "overview";
  const rows = touched.reduce((n, c) => n + c.rows, 0);
  return touched.length <= limit || rows <= smallRows ? "footprints" : "overview";
}
