// The feature the user clicked, and its attributes, read for that one row from the
// remote file.
import { create } from "zustand";
import { attributesSql } from "@/core";
import { withEngine } from "@/engine/session";
import { usePackage } from "@/features/source/store";

/** What a footprint carries in its vector tile. */
export interface Picked {
  uid: number;
  table: string;
  /** Position in the table's `files`. */
  file: number;
  /** `file_row_number` in that file. */
  row: number;
  id: string;
  objectType: string;
}

export type Popup =
  | { state: "closed" }
  | { state: "loading"; feature: Picked }
  | { state: "ready"; feature: Picked; values: [string, string | null][] }
  | { state: "failed"; feature: Picked; message: string };

export const usePopup = create<Popup>(() => ({ state: "closed" }));

/** Reads a vector tile feature's properties; null when they are not a footprint's. */
export function pickedFrom(properties: Record<string, unknown> | undefined): Picked | null {
  const p = properties ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const uid = n(p.uid);
  const file = n(p.file);
  const row = n(p.row);
  if (uid === null || file === null || row === null) return null;
  if (typeof p.tbl !== "string" || typeof p.id !== "string") return null;
  return { uid, table: p.tbl, file, row, id: p.id, objectType: String(p.object_type ?? "") };
}

export function closePopup(): void {
  usePopup.setState({ state: "closed" }, true);
}

export async function openPopup(feature: Picked): Promise<void> {
  usePopup.setState({ state: "loading", feature }, true);
  const current = () => {
    const s = usePopup.getState();
    return s.state !== "closed" && s.feature === feature;
  };
  try {
    const pkg = usePackage.getState();
    const table =
      pkg.state === "ready" ? pkg.info.tables.find((t) => t.name === feature.table) : null;
    const file = table?.files[feature.file];
    if (!table || !file) throw new Error(`${feature.table} is not a table of the open package`);
    const [row] = await withEngine((e) => e.query(attributesSql(table, file, feature.row)));
    if (!row) throw new Error(`row ${feature.row} of ${file} is not there`);
    if (row.id !== feature.id) {
      throw new Error(`row ${feature.row} of ${file} is ${String(row.id)}, not ${feature.id}`);
    }
    const values = Object.entries(row).map(([k, v]): [string, string | null] => [
      k,
      v === null || v === undefined ? null : String(v),
    ]);
    if (current()) usePopup.setState({ state: "ready", feature, values }, true);
  } catch (e) {
    if (current()) {
      usePopup.setState(
        { state: "failed", feature, message: e instanceof Error ? e.message : String(e) },
        true,
      );
    }
  }
}
