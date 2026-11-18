// Where a package is, and which files make up its tables. The only network access is
// through the injected `Fetch`, so this runs the same in the browser and in unit tests.
import { fileName, parseUrl, type Url } from "./url";

export const DEFAULT_SOURCE = "https://cityparquet.open3d.city/data/3dbag/";

/** Object tables, by the file names the CityParquet specification fixes, in its order. */
export const OBJECT_TABLES = [
  "building",
  "bridge",
  "tunnel",
  "construction",
  "transportation",
  "vegetation",
  "relief",
  "water_body",
  "land_use",
  "city_furniture",
  "generics",
] as const;

/** Appearance and template sidecars: not object tables, but part of the package. */
export const SIDECARS = ["materials", "textures", "implicit_geometries"] as const;

export type SourceSpec =
  /** A package directory; `url` ends in `/`. */
  | { kind: "directory"; url: Url }
  /** One Parquet file: a package of one table. */
  | { kind: "file"; url: Url }
  /** A pattern such as `…/**\/building.parquet`, listed from `base`'s metadata.json. */
  | { kind: "wildcard"; url: Url; base: Url };

/** The files of one table (or sidecar), named after their file name. */
export interface FileGroup {
  name: string;
  files: Url[];
}

export interface ResolvedSource {
  spec: SourceSpec;
  /** How the files were found: the STAC `metadata.json`, probing names, or the URL itself. */
  listedBy: "metadata" | "probe" | "url";
  tables: FileGroup[];
  sidecars: FileGroup[];
}

/** The part of `fetch` this module uses; `window.fetch` is one. */
export type Fetch = (
  url: string,
  init?: { method?: "GET" | "HEAD" },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class SourceError extends Error {
  override name = "SourceError";
}

/** Classifies a package URL. Relative URLs resolve against `base` (the page). */
export function parseSource(text: string, base: string): SourceSpec {
  const url = parseUrl(text.trim(), base);
  const path = new URL(url).pathname;
  // `*` survives URL parsing as itself, so it marks a pattern; `?` would be a query.
  const star = path.indexOf("*");
  if (star >= 0) {
    const origin = new URL(url).origin;
    const base = parseUrl(path.slice(0, path.lastIndexOf("/", star) + 1), origin);
    return { kind: "wildcard", url, base };
  }
  if (path.endsWith(".parquet")) return { kind: "file", url };
  return { kind: "directory", url: path.endsWith("/") ? url : parseUrl(`${url}/`) };
}

/** Finds the files of each table. Throws a SourceError when there is nothing to read. */
export async function resolveSource(spec: SourceSpec, fetch: Fetch): Promise<ResolvedSource> {
  switch (spec.kind) {
    case "file":
      return { spec, listedBy: "url", ...group([spec.url]) };
    case "directory": {
      const listed = await listMetadata(spec.url, fetch);
      if (listed.length > 0) return { spec, listedBy: "metadata", ...group(listed) };
      const probed = await probe(spec.url, fetch);
      if (probed.length === 0) {
        throw new SourceError(
          `no CityParquet files at ${spec.url}: no metadata.json naming them, and none of ` +
            `${OBJECT_TABLES.map((t) => `${t}.parquet`).join(", ")}`,
        );
      }
      return { spec, listedBy: "probe", ...group(probed) };
    }
    case "wildcard": {
      const pattern = globToRegExp(spec.url);
      const listed = (await listMetadata(spec.base, fetch)).filter((f) => pattern.test(f));
      if (listed.length === 0) {
        throw new SourceError(
          `cannot expand ${spec.url}: plain HTTP cannot list files, and no ` +
            `${spec.base}metadata.json names a file that matches`,
        );
      }
      return { spec, listedBy: "metadata", ...group(listed) };
    }
  }
}

/** The Parquet files a STAC Item at `<dir>metadata.json` names, or none. */
async function listMetadata(dir: Url, fetch: Fetch): Promise<Url[]> {
  const metadata = parseUrl("metadata.json", dir);
  let item: unknown;
  try {
    const response = await fetch(metadata);
    if (!response.ok) return [];
    item = await response.json();
  } catch {
    return [];
  }
  const assets = (item as { assets?: unknown } | null)?.assets;
  if (!assets || typeof assets !== "object") return [];
  const files: Url[] = [];
  for (const asset of Object.values(assets)) {
    const href = (asset as { href?: unknown } | null)?.href;
    if (typeof href !== "string") continue;
    const url = parseUrl(href, metadata);
    if (url.endsWith(".parquet") && !files.includes(url)) files.push(url);
  }
  return files;
}

async function probe(dir: Url, fetch: Fetch): Promise<Url[]> {
  const names = [...OBJECT_TABLES, ...SIDECARS].map((n) => parseUrl(`${n}.parquet`, dir));
  const found = await Promise.all(
    names.map((url) =>
      fetch(url, { method: "HEAD" }).then(
        (r) => r.ok,
        () => false,
      ),
    ),
  );
  return names.filter((_, i) => found[i]);
}

/** Groups files by table name (the file name without `.parquet`), objects before sidecars. */
function group(files: Url[]): Pick<ResolvedSource, "tables" | "sidecars"> {
  const groups = new Map<string, Url[]>();
  for (const file of files) {
    const name = fileName(file).replace(/\.parquet$/, "");
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  const all = [...groups].map(([name, files]) => ({ name, files }));
  const isSidecar = (g: FileGroup) => (SIDECARS as readonly string[]).includes(g.name);
  // The specification's order first, then any other table (an extension's) by name.
  const rank = (g: FileGroup) => {
    const i = (OBJECT_TABLES as readonly string[]).indexOf(g.name);
    return i < 0 ? OBJECT_TABLES.length : i;
  };
  return {
    tables: all
      .filter((g) => !isSidecar(g))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
    sidecars: all.filter(isSidecar),
  };
}

/** `**` spans directories, `*` stays within one. */
function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split(/(\*\*\/|\*\*|\*)/);
  const body = parts
    .map((p) => {
      if (p === "**/") return "(?:.*/)?";
      if (p === "**") return ".*";
      if (p === "*") return "[^/]*";
      return p.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`);
}
