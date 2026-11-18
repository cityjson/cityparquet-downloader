// The app's one MapLibre map, for features that draw on it (a selection outline, a
// highlight). Null until its style has loaded. Sources and layers are named in style.ts.
import type { MapLibreMap } from "maplibre-gl";
import { create } from "zustand";

export const useMap = create<{ map: MapLibreMap | null }>(() => ({ map: null }));

export const getMap = (): MapLibreMap | null => useMap.getState().map;

export function setMap(map: MapLibreMap | null): void {
  useMap.setState({ map });
  // For verification: the camera and the layers, read with `control browser eval`.
  if (import.meta.env.DEV) (window as { __map?: MapLibreMap | null }).__map = map;
}
