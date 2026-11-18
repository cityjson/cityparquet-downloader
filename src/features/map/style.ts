// The map's style: a basemap for the theme, with the layers that draw the package on top.
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { colourOf, TILE_LAYER, TILE_URL } from "@/core";
import type { Theme } from "@/lib/theme";

/** Source and layer ids, for other features that draw on the map. */
export const SOURCES = { rowGroups: "row-groups", footprints: "footprints" } as const;
export const LAYERS = {
  rowGroupsFill: "row-groups-fill",
  rowGroupsLine: "row-groups-line",
  footprintsFill: "footprints-fill",
  footprintsLine: "footprints-line",
} as const;

/**
 * Positron when light and Dark Matter when dark, on OpenStreetMap data. CARTO serves them
 * as raster tiles, and only with an API key (`VITE_CARTO_KEY`); without one its tiles
 * carry an "API key required" watermark. OpenFreeMap serves the same two designs as
 * vector styles with no key, so that is the basemap when there is no CARTO key.
 */
export function basemapStyle(theme: Theme, ratio = 1): string | StyleSpecification {
  const key = import.meta.env.VITE_CARTO_KEY;
  if (!key) return `https://tiles.openfreemap.org/styles/${theme === "dark" ? "dark" : "positron"}`;
  const sheet = theme === "dark" ? "dark_all" : "light_all";
  const scale = ratio > 1 ? "@2x" : "";
  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: [
          `https://basemaps.cartocdn.com/rastertiles/${sheet}/{z}/{x}/{y}${scale}.png?key=${encodeURIComponent(key)}`,
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
  };
}

export const overlaySources: Record<string, SourceSpecification> = {
  [SOURCES.rowGroups]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
  [SOURCES.footprints]: {
    type: "vector",
    tiles: [TILE_URL],
    // Deeper zooms reuse z16 tiles; footprints need no more precision than that.
    maxzoom: 16,
    promoteId: "uid",
  },
};

const ROW_GROUP = "#6449d6";

export function overlayLayers(theme: Theme): LayerSpecification[] {
  return [
    {
      id: LAYERS.rowGroupsFill,
      type: "fill",
      source: SOURCES.rowGroups,
      paint: {
        "fill-color": ROW_GROUP,
        "fill-opacity": ["interpolate", ["linear"], ["get", "share"], 0, 0.05, 1, 0.3],
      },
    },
    {
      id: LAYERS.rowGroupsLine,
      type: "line",
      source: SOURCES.rowGroups,
      paint: {
        "line-color": [
          "match",
          ["feature-state", "state"],
          "loading",
          "#f5aa00",
          "failed",
          "#dd2e2e",
          ROW_GROUP,
        ],
        "line-width": ["match", ["feature-state", "state"], ["loading", "failed"], 2.5, 1],
        "line-opacity": ["match", ["feature-state", "state"], ["loading", "failed"], 1, 0.45],
      },
    },
    {
      id: LAYERS.footprintsFill,
      type: "fill",
      source: SOURCES.footprints,
      "source-layer": TILE_LAYER,
      layout: { visibility: "none" },
      paint: {
        "fill-color": colours([]),
        "fill-opacity": fillOpacity([]),
      },
    },
    {
      id: LAYERS.footprintsLine,
      type: "line",
      source: SOURCES.footprints,
      "source-layer": TILE_LAYER,
      layout: { visibility: "none" },
      paint: {
        "line-color": lineColours(theme, []),
        "line-width": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          2.5,
          ["boolean", ["feature-state", "hover"], false],
          2,
          0.6,
        ],
      },
    },
  ];
}

const OURS = new Set<string>([...Object.values(SOURCES), ...Object.values(LAYERS)]);

/**
 * For `setStyle`'s `transformStyle` when the basemap changes: the new basemap, with this
 * app's sources (and their data) and layers carried over as they are, on top.
 */
export function keepOverlay(
  previous: StyleSpecification | undefined,
  next: StyleSpecification,
): StyleSpecification {
  if (!previous) return next;
  const sources = Object.fromEntries(
    Object.entries(previous.sources).filter(([id]) => OURS.has(id)),
  );
  return {
    ...next,
    sources: { ...next.sources, ...sources },
    layers: [...next.layers, ...previous.layers.filter((l) => OURS.has(l.id))],
  };
}

/** Fill colour by `object_type`, for the types seen so far; others get their fallback. */
export function colours(types: readonly string[]): ExpressionSpecification | string {
  const unique = [...new Set(types)];
  if (unique.length === 0) return colourOf("");
  return [
    "match",
    ["get", "object_type"],
    ...unique.flatMap((t) => [t, colourOf(t)]),
    colourOf(""),
  ] as unknown as ExpressionSpecification;
}

/**
 * Fill opacity: stronger for the hovered and the selected feature. A table drawn as bbox
 * rectangles is filled faintly, since one object's box can cover a whole district.
 */
export function fillOpacity(bboxTables: readonly string[]): ExpressionSpecification {
  return [
    "*",
    ["case", ["in", ["get", "tbl"], ["literal", [...bboxTables]]], 0.25, 1],
    [
      "case",
      ["boolean", ["feature-state", "selected"], false],
      0.95,
      ["boolean", ["feature-state", "hover"], false],
      0.85,
      0.55,
    ],
  ];
}

/** Outline colour: the type's, or a strong one for the selected feature. */
export function lineColours(theme: Theme, types: readonly string[]): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    theme === "dark" ? "#ffffff" : "#1d1c20",
    colours(types),
  ];
}

/** Leaves out what the legend hides: keys `table` and `table/type`, as `legendKey` makes them. */
export function legendFilter(hidden: ReadonlySet<string>): FilterSpecification {
  const tables = [...hidden].filter((k) => !k.includes("/"));
  const pairs = [...hidden].filter((k) => k.includes("/"));
  return [
    "all",
    ["!", ["in", ["get", "tbl"], ["literal", tables]]],
    ["!", ["in", ["concat", ["get", "tbl"], "/", ["get", "object_type"]], ["literal", pairs]]],
  ];
}
