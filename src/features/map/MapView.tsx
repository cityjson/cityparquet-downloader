// The map. MapLibre is driven imperatively from effects against one Map instance; React
// renders only its container and the states around it.
import {
  addProtocol,
  GeoJSONSource,
  type GeoJSONSourceSpecification,
  type MapGeoJSONFeature,
  MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { footprintOf, parseTileUrl, TILE_LAYER, TILE_PROTOCOL, tileSql } from "@/core";
import { withEngine } from "@/engine/session";
import { attachDrawing, isDrawing } from "@/features/selection/draw";
import { useSelection } from "@/features/selection/store";
import { usePackage } from "@/features/source/store";
import { useTheme } from "@/lib/theme";
import { loadLog, placePackage, setView, useMapData } from "./footprints";
import { useLegend } from "./legend";
import { setMap } from "./map";
import { closePopup, openPopup, pickedFrom, usePopup } from "./popup";
import {
  basemapStyle,
  colours,
  fillOpacity,
  keepOverlay,
  LAYERS,
  legendFilter,
  lineColours,
  overlayLayers,
  overlaySources,
  SOURCES,
} from "./style";

// MapLibre finds its worker by a URL no bundler rewrites; `?url` makes Vite serve it.
setWorkerUrl(workerUrl);

/** Recent tile queries, newest last: time queued, time running, size. */
export const tileLog: { tile: string; waitMs: number; ms: number; bytes: number }[] = [];

// Each vector tile is one query on the local footprint table, queued behind what the user
// asked for and ahead of background loads. A tile the map no longer needs is dropped
// before it runs.
addProtocol(TILE_PROTOCOL, async (params, abort) => {
  const tile = parseTileUrl(params.url);
  const asked = performance.now();
  let ran = asked;
  const bytes = await withEngine(
    (e) => {
      ran = performance.now();
      // While a selection is active, each footprint says whether it is selected.
      return e.queryBytes(tileSql(tile, { highlight: useSelection.getState().active }));
    },
    { priority: "tile", signal: abort.signal },
  );
  tileLog.push({
    tile: `${tile.z}/${tile.x}/${tile.y}`,
    waitMs: Math.round(ran - asked),
    ms: Math.round(performance.now() - ran),
    bytes: bytes?.length ?? 0,
  });
  if (tileLog.length > 200) tileLog.shift();
  return { data: bytes ? bytes.slice().buffer : new ArrayBuffer(0) };
});

// For verification: how long tiles and chunk loads took, read with `control browser eval`.
if (import.meta.env.DEV) {
  (window as { __mapLogs?: unknown }).__mapLogs = { tiles: tileLog, loads: loadLog };
}

/** maplibre 6 returns a half-built map, with no painter, when WebGL 2 is unavailable. */
/**
 * The feature a pointer means among those under it: a footprint before a table's bbox
 * rectangle, and the smaller of two, since a large box covers the objects inside it.
 */
function pick(features: MapGeoJSONFeature[], bboxTables: readonly string[]) {
  const rank = (f: MapGeoJSONFeature) => {
    const g = f.geometry;
    const coords: unknown[] = "coordinates" in g ? [g.coordinates].flat(4) : [];
    let [xmin, ymin, xmax, ymax] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const [x, y] = [Number(coords[i]), Number(coords[i + 1])];
      [xmin, xmax, ymin, ymax] = [
        Math.min(xmin, x),
        Math.max(xmax, x),
        Math.min(ymin, y),
        Math.max(ymax, y),
      ];
    }
    const box = bboxTables.includes(String(f.properties.tbl)) ? 1 : 0;
    return [box, (xmax - xmin) * (ymax - ymin)] as const;
  };
  let best: MapGeoJSONFeature | undefined;
  let bestRank: readonly [number, number] = [Infinity, Infinity];
  for (const f of features) {
    const r = rank(f);
    if (r[0] < bestRank[0] || (r[0] === bestRank[0] && r[1] < bestRank[1]))
      [best, bestRank] = [f, r];
  }
  return best;
}

/** How long a click waits for a second one, which would make it a zoom. */
const DOUBLE_CLICK_MS = 250;

const hasPainter = (map: MapLibreMap) => (map as unknown as { painter?: unknown }).painter != null;

export function MapView() {
  const container = useRef<HTMLDivElement | null>(null);
  const [map, setLoaded] = useState<MapLibreMap | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // One map for the component's lifetime.
  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: basemapStyle(useTheme.getState().theme, window.devicePixelRatio),
      center: [5, 52],
      zoom: 3,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      attributionControl: { compact: false },
    });
    if (!hasPainter(m)) {
      setFailed("WebGL 2 is not available in this browser.");
      return;
    }
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    m.once("load", () => {
      for (const [id, source] of Object.entries(overlaySources)) m.addSource(id, source);
      for (const layer of overlayLayers(useTheme.getState().theme)) m.addLayer(layer);
      setMap(m);
      setLoaded(m);
    });
    m.on("error", (e) => console.warn("map:", e.error?.message ?? e));
    return () => {
      setMap(null);
      setLoaded(null);
      m.remove();
    };
  }, []);

  // The view decides the regime: tell the footprint controller after every move.
  useEffect(() => {
    if (!map) return;
    const report = () => {
      const b = map.getBounds();
      setView({ xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth() });
    };
    map.on("moveend", report);
    return () => {
      map.off("moveend", report);
    };
  }, [map]);

  // A package that opens: fit the camera to it, then place its row groups.
  const pkg = usePackage();
  const info = pkg.state === "ready" ? pkg.info : null;
  useEffect(() => {
    if (!map || !info) return;
    const e = info.extentWgs84;
    if (e) {
      map.fitBounds(
        [
          [e.xmin, e.ymin],
          [e.xmax, e.ymax],
        ],
        { padding: 40, duration: 0 },
      );
    }
    void placePackage(info).then(() => map.fire("moveend"));
  }, [map, info]);

  // What the controller knows, drawn: outlines, chunk states, the regime, ready tiles.
  useEffect(() => {
    if (!map) return;
    const draw = (now = useMapData.getState(), before?: typeof now) => {
      if (now.layout !== before?.layout && now.layout.state === "ready") {
        const source = map.getSource(SOURCES.rowGroups);
        if (source instanceof GeoJSONSource) {
          void source.setData(now.layout.outlines as GeoJSONSourceSpecification["data"]);
        }
      }
      if (now.cache !== before?.cache && now.layout.state === "ready") {
        now.layout.chunks.forEach((c, id) => {
          const state = now.cache.get(c.key)?.state ?? "absent";
          map.setFeatureState({ source: SOURCES.rowGroups, id }, { state });
        });
      }
      if (now.regime !== before?.regime) {
        const footprints = now.regime.kind === "footprints";
        map.setLayoutProperty(LAYERS.footprintsFill, "visibility", footprints ? "visible" : "none");
        map.setLayoutProperty(LAYERS.footprintsLine, "visibility", footprints ? "visible" : "none");
        map.setLayoutProperty(LAYERS.rowGroupsFill, "visibility", footprints ? "none" : "visible");
      }
      if (before && now.generation !== before.generation) map.refreshTiles(SOURCES.footprints);
    };
    draw();
    return useMapData.subscribe(draw);
  }, [map]);

  // The legend: colours for the types seen, and the filter that hides what it hides.
  const theme = useTheme((s) => s.theme);
  const bboxTables = useRef<readonly string[]>([]);
  useEffect(() => {
    if (!map) return;
    bboxTables.current = (info?.tables ?? [])
      .filter((t) => footprintOf(t).kind === "bbox")
      .map((t) => t.name);
    map.setPaintProperty(LAYERS.footprintsFill, "fill-opacity", fillOpacity(bboxTables.current));
    const apply = ({ seen, hidden } = useLegend.getState()) => {
      const types = Object.values(seen).flat();
      map.setPaintProperty(LAYERS.footprintsFill, "fill-color", colours(types));
      map.setPaintProperty(LAYERS.footprintsLine, "line-color", lineColours(theme, types));
      map.setFilter(LAYERS.footprintsFill, legendFilter(hidden));
      map.setFilter(LAYERS.footprintsLine, legendFilter(hidden));
    };
    apply();
    return useLegend.subscribe((s) => apply(s));
  }, [map, theme, info]);

  // Hover and click on footprints; the clicked one stays marked while its popup is open.
  useEffect(() => {
    if (!map) return;
    const at = (p: { x: number; y: number }) =>
      pick(
        map.queryRenderedFeatures([p.x, p.y], { layers: [LAYERS.footprintsFill] }),
        bboxTables.current,
      );
    let hovered: string | number | undefined;
    const setHover = (id: string | number | undefined) => {
      if (id === hovered) return;
      if (hovered !== undefined) {
        map.setFeatureState(
          { source: SOURCES.footprints, sourceLayer: TILE_LAYER, id: hovered },
          { hover: false },
        );
      }
      hovered = id;
      if (id !== undefined) {
        map.setFeatureState(
          { source: SOURCES.footprints, sourceLayer: TILE_LAYER, id },
          { hover: true },
        );
      }
      map.getCanvas().style.cursor = isDrawing() ? "crosshair" : id === undefined ? "" : "pointer";
    };
    const onMove = (e: { point: { x: number; y: number } }) =>
      setHover(isDrawing() ? undefined : at(e.point)?.id);
    const onLeave = () => setHover(undefined);
    // A click waits out a double-click's interval: a double-click zooms, and must not read
    // a feature's attributes on the way.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onClick = (e: { point: { x: number; y: number }; originalEvent: MouseEvent }) => {
      clearTimeout(pending);
      if (e.originalEvent.detail > 1 || isDrawing()) return;
      const point = e.point;
      pending = setTimeout(() => {
        const picked = pickedFrom(at(point)?.properties);
        if (picked) void openPopup(picked);
        else closePopup();
      }, DOUBLE_CLICK_MS);
    };
    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);
    map.on("click", onClick);

    let selected: number | undefined;
    const unsubscribe = usePopup.subscribe((popup) => {
      const id = popup.state === "closed" ? undefined : popup.feature.uid;
      if (id === selected) return;
      const target = (uid: number) => ({
        source: SOURCES.footprints,
        sourceLayer: TILE_LAYER,
        id: uid,
      });
      if (selected !== undefined) map.setFeatureState(target(selected), { selected: false });
      selected = id;
      if (id !== undefined) map.setFeatureState(target(id), { selected: true });
    });
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseout", onLeave);
      map.off("click", onClick);
      clearTimeout(pending);
      unsubscribe();
    };
  }, [map]);

  // The drawn area, and the drawing tools' pointer and key handlers.
  useEffect(() => (map ? attachDrawing(map) : undefined), [map]);

  // A new selection re-cuts the tiles, which carry whether each footprint is selected.
  useEffect(() => {
    if (!map) return;
    return useSelection.subscribe((s, p) => {
      if (s.revision !== p.revision || s.active !== p.active) map.refreshTiles(SOURCES.footprints);
    });
  }, [map]);

  // The basemap follows the theme; the package's sources and layers stay as they are.
  const shown = useRef(theme);
  useEffect(() => {
    if (!map || shown.current === theme) return;
    shown.current = theme;
    map.setStyle(basemapStyle(theme, window.devicePixelRatio), {
      diff: true,
      transformStyle: keepOverlay,
    });
  }, [map, theme]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <Alert variant="destructive" role="alert" className="max-w-md">
            <AlertTitle>The map could not start</AlertTitle>
            <AlertDescription>{failed}</AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
}
