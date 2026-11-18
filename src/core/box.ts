// Axis-aligned 2D boxes, in whatever CRS the caller says.

export interface Box {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** Whether two boxes share any point, edges included. */
export function overlaps(a: Box, b: Box): boolean {
  return a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;
}

/** The smallest box around all of them; null for none. */
export function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    xmin: Math.min(...boxes.map((b) => b.xmin)),
    ymin: Math.min(...boxes.map((b) => b.ymin)),
    xmax: Math.max(...boxes.map((b) => b.xmax)),
    ymax: Math.max(...boxes.map((b) => b.ymax)),
  };
}

/** Reads `xmin, ymin, xmax, ymax` from a result row; null unless all four are numbers. */
export function boxFrom(row: Record<string, unknown> | undefined): Box | null {
  const { xmin, ymin, xmax, ymax } = row ?? {};
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return finite(xmin) && finite(ymin) && finite(xmax) && finite(ymax)
    ? { xmin, ymin, xmax, ymax }
    : null;
}
