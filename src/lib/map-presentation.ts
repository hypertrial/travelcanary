import { catalogV2Paths, catalogV3Paths } from "./catalog-paths";
import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "./domain/catalog-public";
import type { Map as MapLibreMap, PaddingOptions, GeoJSONSource } from "maplibre-gl";
import type { LocationState} from "./domain/schemas";

export const MAP_POINT_HIT_RADIUS = 22;
export const CORE_EUROPE_BOUNDS: [[number, number], [number, number]] = [[-12, 34], [35, 72]];
export const MAP_CLUSTER_MAX_ZOOM = 6;
export const MAP_CLUSTER_RADIUS = 46;
export type MapFilter = "all" | "high" | "unavailable";
export type MapFilterCounts = Record<MapFilter | "elevated", number>;
export const COMPACT_DETAILS_SHEET_RATIO = 0.44;
export const CATALOG_OVERVIEW_MAX_ZOOM = 5.8;
export const UNCOVERED_LAND_COLOR = "#C6C2B8";
export const COVERED_LAND_COLOR = "#F1EEE5";
export const COVERED_COUNTRIES_SOURCE = "covered-countries";
export const COVERED_COUNTRIES_LAYER = "covered-countries-fill";
export const COVERED_COUNTRIES_URL = catalogV2Paths.geography;
export const COVERAGE_LAYER_BEFORE_CANDIDATES = ["park", "landuse_residential", "landcover_wood", "water"] as const;

export function locationAppearsOnMap(level: LocationState["level"], selected: boolean, filter: MapFilter = "all"): boolean {
  if (selected) return true;
  if (filter === "unavailable") return level === "UNKNOWN";
  return level === "HIGH" || level === "SEVERE" || (filter === "all" && level === "ELEVATED");
}

export function mapFilterCounts(locations: Pick<PublicLocation, "id">[], snapshot: Snapshot | null): MapFilterCounts | null {
  if (!snapshot || locations.length === 0) return null;
  const counts: MapFilterCounts = { all: 0, high: 0, unavailable: 0, elevated: 0 };
  for (const location of locations) {
    const level = snapshot.locations[location.id]?.level || "UNKNOWN";
    if (level === "ELEVATED") counts.elevated++;
    if (level === "HIGH" || level === "SEVERE") counts.high++;
    if (level === "UNKNOWN") counts.unavailable++;
  }
  counts.all = counts.high + counts.elevated;
  return counts;
}

type PaintProperty = Parameters<MapLibreMap["setPaintProperty"]>[1];
type PaintValue = Parameters<MapLibreMap["setPaintProperty"]>[2];
type PaintOverride = [layerId: string, property: PaintProperty, value: PaintValue];

export function catalogMapBounds(locations: Pick<PublicLocation, "centroid">[]): [[number, number], [number, number]] | null {
  if (locations.length === 0) return null;
  let [west, south] = locations[0].centroid;
  let [east, north] = locations[0].centroid;
  for (const { centroid: [lng, lat] } of locations.slice(1)) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [[west, south], [east, north]];
}

export function locationInCoreOverview(location: Pick<PublicLocation, "centroid">): boolean {
  const [[west, south], [east, north]] = CORE_EUROPE_BOUNDS;
  return location.centroid[0] >= west && location.centroid[0] <= east && location.centroid[1] >= south && location.centroid[1] <= north;
}

export function coreOverviewBounds(locations: Pick<PublicLocation, "centroid">[]): [[number, number], [number, number]] | null {
  const core = locations.filter(locationInCoreOverview);
  return catalogMapBounds(core.length ? core : locations);
}

const fieldGuidePaint: PaintOverride[] = [
  ["background", "background-color", UNCOVERED_LAND_COLOR],
  ["water", "fill-color", "#C8D5D2"],
  ["park", "fill-color", "#E2E8DB"],
  ["landuse_residential", "fill-color", "#EEEAE1"],
  ["landcover_wood", "fill-color", "#D9E3D5"],
  ["building", "fill-color", "#E7E2D8"],
  ["building", "fill-outline-color", "#D7D1C6"],
  ["highway_minor", "line-color", "#DDD9D0"],
  ["highway_major_inner", "line-color", "#FBF8F1"],
  ["boundary_2", "line-color", "#9BAAA4"],
  ["boundary_3", "line-color", "#B8C2BC"],
  ["waterway_line_label", "text-color", "#476B70"],
  ["water_name_point_label", "text-color", "#476B70"],
  ["water_name_line_label", "text-color", "#476B70"],
  ["label_village", "text-color", "#315054"],
  ["label_town", "text-color", "#28484C"],
  ["label_state", "text-color", "#36575A"],
  ["label_city", "text-color", "#173A3F"],
  ["label_city_capital", "text-color", "#173A3F"],
  ["label_country_3", "text-color", "#173A3F"],
  ["label_country_2", "text-color", "#173A3F"],
  ["label_country_1", "text-color", "#173A3F"],
];

const warmHaloLayers = [
  "waterway_line_label",
  "water_name_point_label",
  "water_name_line_label",
  "label_village",
  "label_town",
  "label_state",
  "label_city",
  "label_city_capital",
  "label_country_3",
  "label_country_2",
  "label_country_1",
];

export function mapErrorSourceId(event: object): string | undefined {
  if (!("sourceId" in event) || typeof event.sourceId !== "string") return undefined;
  return event.sourceId;
}

export function coverageLayerBeforeId(map: Pick<MapLibreMap, "getLayer">): string | undefined {
  return COVERAGE_LAYER_BEFORE_CANDIDATES.find((layerId) => map.getLayer(layerId));
}

export function applyCoveredCountriesLayer(
  map: Pick<MapLibreMap, "getLayer" | "getSource" | "addSource" | "addLayer">,
  data: GeoJSON.GeoJSON,
): void {
  try {
    const source = map.getSource(COVERED_COUNTRIES_SOURCE);
    if (source?.type === "geojson") (source as GeoJSONSource).setData(data);
    if (map.getLayer(COVERED_COUNTRIES_LAYER)) return;
    const beforeId = coverageLayerBeforeId(map);
    if (!beforeId) return;
    if (!map.getSource(COVERED_COUNTRIES_SOURCE)) map.addSource(COVERED_COUNTRIES_SOURCE, { type: "geojson", data });
    map.addLayer({
      id: COVERED_COUNTRIES_LAYER,
      type: "fill",
      source: COVERED_COUNTRIES_SOURCE,
      paint: { "fill-color": COVERED_LAND_COLOR },
    }, beforeId);
  } catch {
    // Cosmetic coverage tint must never make the safety map unavailable.
  }
}

export async function loadCoveredCountriesLayer(
  map: Pick<MapLibreMap, "getLayer" | "getSource" | "addSource" | "addLayer">,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  catalogVersion: 2 | 3 = 2,
): Promise<void> {
  try {
    const response = await fetchImpl((catalogVersion === 3 ? catalogV3Paths : catalogV2Paths).geography, { signal });
    if (!response.ok) return;
    const data = await response.json() as GeoJSON.GeoJSON;
    if (signal?.aborted) return;
    applyCoveredCountriesLayer(map, data);
  } catch {
    // Same failure boundary as field-guide paint: the map stays usable.
  }
}

export function applyFieldGuideBasemap(map: Pick<MapLibreMap, "getLayer" | "setPaintProperty">): void {
  for (const [layerId, property, value] of fieldGuidePaint) {
    if (!map.getLayer(layerId)) continue;
    try {
      map.setPaintProperty(layerId, property, value);
    } catch {
      // Cosmetic style drift must never make the safety map unavailable.
    }
  }
  for (const layerId of warmHaloLayers) {
    if (!map.getLayer(layerId)) continue;
    try {
      map.setPaintProperty(layerId, "text-halo-color", "#FFFDF6");
    } catch {
      // See above: OpenFreeMap may rename or retype a layer independently.
    }
  }
}

export function initialMapPadding(width: number, healthBannerVisible: boolean, height = 900): PaddingOptions {
  if (width >= 1024) {
    return { top: 32, right: 32, bottom: 48, left: 32 };
  }
  const right = width > 640 ? 28 : 18;
  const bottom = width > 640 ? 82 : 84;
  const requestedTop = width > 640 ? (healthBannerVisible ? 214 : 166) : (healthBannerVisible ? 178 : 122);
  const availableVertical = Math.max(32, height - 32);
  const scale = Math.min(1, availableVertical / (requestedTop + bottom));
  return { top: Math.round(requestedTop * scale), right, bottom: Math.round(bottom * scale), left: right };
}

export function selectedDetailsPadding(compact: boolean, viewportHeight: number, overlayDetails = true): PaddingOptions {
  if (compact) {
    return { top: 16, right: 16, bottom: Math.round(viewportHeight * COMPACT_DETAILS_SHEET_RATIO), left: 16 };
  }
  return { top: 24, right: overlayDetails ? 424 : 24, bottom: 24, left: 24 };
}

export function mapViewportTier(width: number): "mobile" | "tablet" | "desktop" {
  if (width >= 1024) return "desktop";
  if (width > 640) return "tablet";
  return "mobile";
}
