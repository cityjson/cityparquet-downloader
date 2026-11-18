import type { Box, Crs } from "@/core";

const integer = new Intl.NumberFormat("en-GB");

export const formatCount = (n: number) => integer.format(n);

/** `west, south – east, north`, in degrees. */
export function formatExtent(box: Box | null): string {
  if (!box) return "unknown";
  const d = (v: number) => v.toFixed(4);
  return `${d(box.xmin)}, ${d(box.ymin)} – ${d(box.xmax)}, ${d(box.ymax)}`;
}

export function formatCrs(crs: Crs): string {
  switch (crs.kind) {
    case "none":
      return "none";
    case "unknown":
      return "unknown";
    case "known":
      return crs.code ? `${crs.name} (${crs.code.authority}:${crs.code.code})` : crs.name;
  }
}

/** Bytes in the largest unit that keeps the number at least 1: `850 kB`, `1.4 MB`. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
