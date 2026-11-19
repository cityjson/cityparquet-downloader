// Drawing the selection's area on the map: a polygon by clicking its corners, a rectangle
// by dragging, or the current view. While a drawing is in progress the map's own clicks
// (the popup) and double-click zoom stay out of the way.
import { GeoJSONSource, type MapLibreMap, type MapMouseEvent } from "maplibre-gl";
import { create } from "zustand";
import { type Extent, type LonLat, parseExtent } from "@/core";
import { SOURCES } from "@/features/map/style";
import { setExtent, useSelection } from "./store";

export type DrawMode = "idle" | "polygon" | "rectangle";

export interface DrawState {
  mode: DrawMode;
  /** The polygon's corners so far, or the rectangle's two opposite corners while dragging. */
  points: readonly LonLat[];
  /** Where the pointer is, for the edge that follows it. */
  cursor: LonLat | null;
}

export const useDraw = create<DrawState>(() => ({ mode: "idle", points: [], cursor: null }));

export const isDrawing = (): boolean => useDraw.getState().mode !== "idle";

export function startDrawing(mode: Exclude<DrawMode, "idle">): void {
  useDraw.setState({ mode, points: [], cursor: null });
}

export function cancelDrawing(): void {
  useDraw.setState({ mode: "idle", points: [], cursor: null });
}

/** Ends a polygon of three or more corners as the area; fewer is not an area yet. */
export function finishPolygon(): void {
  const { mode, points } = useDraw.getState();
  if (mode !== "polygon" || points.length < 3) return;
  setExtent(parseExtent(points));
  cancelDrawing();
}

export function areaFromView(map: MapLibreMap): void {
  const b = map.getBounds();
  setExtent(
    parseExtent([
      [b.getWest(), b.getSouth()],
      [b.getEast(), b.getSouth()],
      [b.getEast(), b.getNorth()],
      [b.getWest(), b.getNorth()],
    ]),
  );
  cancelDrawing();
}

export const clearArea = (): void => setExtent(null);

const lonLat = (e: MapMouseEvent): LonLat => [e.lngLat.lng, e.lngLat.lat];

const rectangle = ([a, b]: readonly LonLat[]): LonLat[] =>
  a && b
    ? [
        [a[0], a[1]],
        [b[0], a[1]],
        [b[0], b[1]],
        [a[0], b[1]],
      ]
    : [];

function ringFeature(ring: readonly LonLat[]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [[...ring, ring[0] as LonLat]] },
  };
}

/** The drawn area, or the drawing in progress, as GeoJSON. */
function draftData({ mode, points, cursor }: DrawState) {
  const corners =
    mode === "rectangle" ? rectangle(points) : [...points, ...(cursor ? [cursor] : [])];
  const features: unknown[] = points.map((p) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: p },
  }));
  if (corners.length >= 3) features.push(ringFeature(corners));
  else if (corners.length === 2) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: corners },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function areaData(extent: Extent | null) {
  return {
    type: "FeatureCollection" as const,
    features: extent ? [ringFeature(extent.ring)] : [],
  };
}

/** Wires the drawing to the map; returns the function that unwires it. */
export function attachDrawing(map: MapLibreMap): () => void {
  const setData = (source: string, data: unknown) => {
    const s = map.getSource(source);
    if (s instanceof GeoJSONSource) void s.setData(data as Parameters<GeoJSONSource["setData"]>[0]);
  };

  const onClick = (e: MapMouseEvent) => {
    const { mode, points } = useDraw.getState();
    // The second click of a double-click is the one that finishes, not a corner.
    if (mode !== "polygon" || e.originalEvent.detail > 1) return;
    useDraw.setState({ points: [...points, lonLat(e)] });
  };
  const onDoubleClick = (e: MapMouseEvent) => {
    if (useDraw.getState().mode !== "polygon") return;
    e.preventDefault();
    finishPolygon();
  };
  const onDown = (e: MapMouseEvent) => {
    if (useDraw.getState().mode !== "rectangle" || e.originalEvent.button !== 0) return;
    e.preventDefault();
    useDraw.setState({ points: [lonLat(e), lonLat(e)] });
  };
  const onMove = (e: MapMouseEvent) => {
    const { mode, points } = useDraw.getState();
    if (mode === "polygon") useDraw.setState({ cursor: lonLat(e) });
    else if (mode === "rectangle" && points.length === 2) {
      useDraw.setState({ points: [points[0] as LonLat, lonLat(e)] });
    }
  };
  const onUp = () => {
    const { mode, points } = useDraw.getState();
    if (mode !== "rectangle" || points.length !== 2) return;
    const [a, b] = points as [LonLat, LonLat];
    if (a[0] !== b[0] && a[1] !== b[1]) setExtent(parseExtent(rectangle(points)));
    cancelDrawing();
  };
  const onKey = (e: KeyboardEvent) => {
    const typing =
      e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (!isDrawing() || typing) return;
    if (e.key === "Escape") cancelDrawing();
    else if (e.key === "Enter") finishPolygon();
    else if (e.key === "Backspace") {
      useDraw.setState(({ points }) => ({ points: points.slice(0, -1) }));
    } else return;
    e.preventDefault();
  };

  map.on("click", onClick);
  map.on("dblclick", onDoubleClick);
  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);
  window.addEventListener("keydown", onKey);

  // The map follows the drawing: no double-click zoom or drag while it is on, a crosshair.
  const follow = (s: DrawState, p?: DrawState) => {
    setData(SOURCES.areaDraft, draftData(s));
    if (p && s.mode === p.mode) return;
    if (s.mode === "idle") {
      map.doubleClickZoom.enable();
      map.dragPan.enable();
    } else {
      map.doubleClickZoom.disable();
      if (s.mode === "rectangle") map.dragPan.disable();
      else map.dragPan.enable();
    }
    map.getCanvas().style.cursor = s.mode === "idle" ? "" : "crosshair";
  };
  follow(useDraw.getState());
  const unsubscribeDraw = useDraw.subscribe(follow);
  setData(SOURCES.area, areaData(useSelection.getState().extent));
  const unsubscribeArea = useSelection.subscribe((s, p) => {
    if (s.extent !== p.extent) setData(SOURCES.area, areaData(s.extent));
  });

  return () => {
    map.off("click", onClick);
    map.off("dblclick", onDoubleClick);
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    unsubscribeDraw();
    unsubscribeArea();
  };
}
