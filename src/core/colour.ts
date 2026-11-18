// The colour the map and the legend give each city object type. Families share a hue:
// buildings purple, bridges amber, tunnels orange, transport grey, vegetation green.

export const OBJECT_TYPE_COLOURS: Readonly<Record<string, string>> = {
  Building: "#6449d6",
  BuildingPart: "#9b87f0",
  BuildingInstallation: "#8a73e6",
  BuildingConstructiveElement: "#7a62df",
  BuildingFurniture: "#b4a5f5",
  BuildingRoom: "#c2b6f7",
  BuildingStorey: "#ab9af3",
  BuildingUnit: "#cfc6f9",
  Bridge: "#f5aa00",
  BridgePart: "#f7c04d",
  BridgeInstallation: "#d48f00",
  BridgeConstructiveElement: "#e8a100",
  BridgeRoom: "#f9d27f",
  BridgeFurniture: "#fbdf9f",
  Tunnel: "#c2410c",
  TunnelPart: "#ea580c",
  TunnelInstallation: "#f97316",
  TunnelConstructiveElement: "#fb923c",
  TunnelHollowSpace: "#fdba74",
  TunnelFurniture: "#fed7aa",
  Road: "#78716c",
  Railway: "#57534e",
  TransportSquare: "#a8a29e",
  Waterway: "#0ea5e9",
  WaterBody: "#2563eb",
  PlantCover: "#7ca12b",
  SolitaryVegetationObject: "#4d7c0f",
  TINRelief: "#a16207",
  LandUse: "#94a3b8",
  CityFurniture: "#db2777",
  GenericCityObject: "#0d9488",
  OtherConstruction: "#e11d48",
  CityObjectGroup: "#64748b",
};

/** For types the registry does not name, such as `+Extension` types. */
const FALLBACK = ["#0891b2", "#9333ea", "#65a30d", "#dc2626", "#0369a1", "#a21caf", "#15803d"];

/** The registered colour, else one of the fallbacks picked by a hash of the name. */
export function colourOf(type: string): string {
  const registered = OBJECT_TYPE_COLOURS[type];
  if (registered) return registered;
  // FNV-1a, so a type keeps its colour across sessions.
  let hash = 0x811c9dc5;
  for (let i = 0; i < type.length; i++) hash = Math.imul(hash ^ type.charCodeAt(i), 0x01000193);
  return FALLBACK[(hash >>> 0) % FALLBACK.length] ?? "#888888";
}
