// The coordinate reference system a table states in its `city` footer, and the SQL that
// takes its coordinates to WGS 84.
import { type Crs as AuthorityCode, crsFromReferenceSystem } from "@cityjson/cjconv-core";
import type { Box } from "./box";
import { lit, num, type Sql, sql } from "./sql";

export type { AuthorityCode };

/** The 2D part of a CRS: what a footprint or a bounding box is in. */
export interface HorizontalCrs {
  name: string;
  /** Its own authority code, when the PROJJSON gives one. */
  code: AuthorityCode | null;
  /** What `ST_Transform` takes as the source: `AUTH:CODE`, else the PROJJSON text. */
  definition: string;
}

export type Crs =
  /** The footer has no `crs` key: the table holds no CRS-bearing coordinates. */
  | { kind: "none" }
  /** `crs` is null (or has no horizontal part): coordinates in a CRS nobody stated. */
  | { kind: "unknown" }
  | { kind: "known"; name: string; code: AuthorityCode | null; horizontal: HorizontalCrs };

interface Projjson {
  type?: unknown;
  name?: unknown;
  id?: { authority?: unknown; code?: unknown } | null;
  components?: unknown;
}

const HORIZONTAL_TYPES = ["ProjectedCRS", "GeographicCRS", "GeodeticCRS", "DerivedProjectedCRS"];

/** Reads `crs` from a parsed `city` footer object. GeoParquet's tri-state, kept apart. */
export function parseCrs(city: { crs?: unknown }): Crs {
  if (!("crs" in city)) return { kind: "none" };
  const crs = city.crs as Projjson | null;
  if (!crs || typeof crs !== "object") return { kind: "unknown" };
  const parts =
    crs.type === "CompoundCRS" && Array.isArray(crs.components) ? crs.components : [crs];
  const part = (parts as Projjson[]).find((p) => HORIZONTAL_TYPES.includes(String(p?.type)));
  if (!part) return { kind: "unknown" };
  const code = codeOf(part);
  return {
    kind: "known",
    name: String(crs.name ?? part.name ?? ""),
    code: codeOf(crs),
    horizontal: {
      name: String(part.name ?? ""),
      code,
      definition: code ? `${code.authority}:${code.code}` : JSON.stringify(part),
    },
  };
}

function codeOf(p: Projjson): AuthorityCode | null {
  const id = p.id;
  if (!id || (typeof id.code !== "string" && typeof id.code !== "number")) return null;
  return crsFromReferenceSystem({ authority: String(id.authority ?? ""), code: id.code }) ?? null;
}

/**
 * The box's outline with `steps` points per edge, closed. A projected box's edges are not
 * straight in WGS 84, so transforming only the corners would cut its extent short.
 */
export function densifiedRing(box: Box, steps: number): [number, number][] {
  const { xmin, ymin, xmax, ymax } = box;
  const along = (from: [number, number], to: [number, number]) =>
    Array.from({ length: steps }, (_, i): [number, number] => [
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    ]);
  return [
    ...along([xmin, ymin], [xmax, ymin]),
    ...along([xmax, ymin], [xmax, ymax]),
    ...along([xmax, ymax], [xmin, ymax]),
    ...along([xmin, ymax], [xmin, ymin]),
    [xmin, ymin],
  ];
}

/**
 * One row `xmin, ymin, xmax, ymax`: the box's extent in WGS 84, longitude as x.
 *
 * `always_xy := true` reads and writes coordinates easting (longitude) first whatever axis
 * order the CRS defines. CityJSON stores x as easting, also for a CRS such as EPSG:6697
 * whose definition puts latitude first, and DuckDB 2.0 refuses the call without it.
 */
export function wgs84ExtentSql(box: Box, from: string, steps = 16): Sql {
  const ring = densifiedRing(box, steps)
    .map(([x, y]) => `${num(x)} ${num(y)}`)
    .join(", ");
  const polygon = lit(`POLYGON((${ring}))`);
  return sql`SELECT ST_XMin(g) AS xmin, ST_YMin(g) AS ymin, ST_XMax(g) AS xmax, ST_YMax(g) AS ymax
FROM (SELECT ST_Transform(ST_GeomFromText(${polygon}), ${lit(from)}, 'EPSG:4326', always_xy := true) AS g)`;
}
