// The package the app has open: resolved from VITE_CITYPARQUET_URL, footers only.
import { create } from "zustand";
import { DEFAULT_SOURCE, openPackage, type PackageInfo, parseSource, resolveSource } from "@/core";
import { withEngine } from "@/engine/session";

export type PackageState =
  | { state: "idle" }
  | { state: "opening"; url: string }
  | { state: "ready"; url: string; info: PackageInfo }
  | { state: "failed"; url: string; message: string };

/** The package URL this build opens; relative URLs resolve against the page. */
export const SOURCE_URL: string = import.meta.env.VITE_CITYPARQUET_URL || DEFAULT_SOURCE;

export const usePackage = create<PackageState>(() => ({ state: "idle" }));

/** Opens the package once; later calls while it is open or opening do nothing. */
export async function openSourcePackage(text: string = SOURCE_URL): Promise<void> {
  if (usePackage.getState().state !== "idle" && usePackage.getState().state !== "failed") return;
  usePackage.setState({ state: "opening", url: text }, true);
  try {
    const spec = parseSource(text, window.location.href);
    const source = await resolveSource(spec, (url, init) => window.fetch(url, init));
    const info = await withEngine((engine) => openPackage(engine, source));
    usePackage.setState({ state: "ready", url: spec.url, info }, true);
  } catch (e) {
    usePackage.setState(
      { state: "failed", url: text, message: e instanceof Error ? e.message : String(e) },
      true,
    );
  }
}
