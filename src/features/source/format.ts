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
