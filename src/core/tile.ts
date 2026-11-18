// XYZ vector tiles in Web Mercator (EPSG:3857), as MapLibre requests them.
import type { Box } from "./box";

/** Half the side of the Web Mercator square, in metres. */
export const WEB_MERCATOR_HALF = 20037508.342789244;

export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** The URL template the map's footprint source requests; `addProtocol` answers it. */
export const TILE_PROTOCOL = "cityparquet";
export const TILE_URL = `${TILE_PROTOCOL}://tiles/{z}/{x}/{y}`;

/** The tile's extent in EPSG:3857, the same box as spatial's `ST_TileEnvelope`. */
export function tileEnvelope({ z, x, y }: TileId): Box {
  const size = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  return {
    xmin: -WEB_MERCATOR_HALF + x * size,
    ymin: WEB_MERCATOR_HALF - (y + 1) * size,
    xmax: -WEB_MERCATOR_HALF + (x + 1) * size,
    ymax: WEB_MERCATOR_HALF - y * size,
  };
}

/** Reads z, x and y back from a URL made from `TILE_URL`. */
export function parseTileUrl(url: string): TileId {
  const match = /\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!match) throw new Error(`not a tile URL: ${url}`);
  const [, z, x, y] = match.map(Number);
  return { z: z ?? 0, x: x ?? 0, y: y ?? 0 };
}
