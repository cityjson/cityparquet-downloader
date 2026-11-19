// Which row groups a selection has to read, and roughly how many bytes that is.
import { type Box, overlaps } from "./box";
import type { RowGroup } from "./footer";

export interface Plan {
  rowGroups: RowGroup[];
  rows: number;
  bytes: number;
}

/**
 * The row groups whose extent overlaps `box` (in the table's CRS). A row group without
 * statistics cannot be ruled out, so it is kept. `columns` limits the byte estimate to
 * those top-level columns; without it every column counts.
 */
export function planBox(
  rowGroups: readonly RowGroup[],
  box: Box,
  columns?: readonly string[],
): Plan {
  const touched = rowGroups.filter((g) => g.bbox === null || overlaps(g.bbox, box));
  const bytesOf = (g: RowGroup) =>
    columns ? columns.reduce((n, c) => n + (g.columnBytes[c] ?? 0), 0) : g.bytes;
  return {
    rowGroups: touched,
    rows: touched.reduce((n, g) => n + g.rows, 0),
    bytes: touched.reduce((n, g) => n + bytesOf(g), 0),
  };
}
