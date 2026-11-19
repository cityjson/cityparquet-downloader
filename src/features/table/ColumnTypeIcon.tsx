// A column's kind as a small glyph, named for screen readers.
import type { ColumnKind } from "@/core";

const GLYPHS: Readonly<Record<ColumnKind, { label: string; path: string }>> = {
  text: { label: "Text", path: "M2 13 6 3l4 10M3.5 9h5M11 7h4m-2-2v8" },
  number: { label: "Number", path: "M6 2 4 14M12 2l-2 12M2 6h12M1 10h12" },
  date: { label: "Date", path: "M3 4h10v10H3zM5 2v4m6-4v4M3 7h10" },
  boolean: { label: "True or false", path: "m3 8 3 3 7-7" },
  other: { label: "Nested", path: "M5 2H3v12h2m6-12h2v12h-2" },
};

export function ColumnTypeIcon({ kind, type }: { kind: ColumnKind; type: string }) {
  const { label, path } = GLYPHS[kind];
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={`${label} column`}
      className="size-3.5 shrink-0 fill-none stroke-current stroke-[1.5] text-muted-foreground"
    >
      <title>{`${label}: ${type}`}</title>
      <path d={path} />
    </svg>
  );
}
