import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { countryCodes } from "@/lib/domain/schemas";
import { mapSnapshot } from "../fixtures/map-snapshots";
import { CompleteSnapshotSchema } from "@/lib/snapshot-validation";
import {
  applyCoveredCountriesLayer,
  applyFieldGuideBasemap,
  catalogMapBounds,
  coreOverviewBounds,
  CORE_EUROPE_BOUNDS,
  COMPACT_DETAILS_SHEET_RATIO,
  COVERED_LAND_COLOR,
  COVERED_COUNTRIES_LAYER,
  COVERED_COUNTRIES_SOURCE,
  COVERED_COUNTRIES_URL,
  coverageLayerBeforeId,
  mapFilterCounts,
  mapErrorSourceId,
  initialMapPadding,
  loadCoveredCountriesLayer,
  locationAppearsOnMap,
  locationInCoreOverview,
  MAP_CLUSTER_MAX_ZOOM,
  MAP_CLUSTER_RADIUS,
  MAP_POINT_HIT_RADIUS,
  mapViewportTier,
  selectedDetailsPadding,
  UNCOVERED_LAND_COLOR,
} from "@/lib/map-presentation";

describe("map presentation", () => {
  it("applies only overrides whose allowlisted layers exist", () => {
    const setPaintProperty = vi.fn();
    const layers = new Set(["background", "water", "label_city"]);
    applyFieldGuideBasemap({ getLayer: (id: string) => layers.has(id) ? ({ id } as never) : undefined, setPaintProperty });
    expect(setPaintProperty.mock.calls).toContainEqual(["background", "background-color", UNCOVERED_LAND_COLOR]);
    expect(setPaintProperty.mock.calls).toContainEqual(["water", "fill-color", "#C8D5D2"]);
    expect(setPaintProperty.mock.calls).toContainEqual(["label_city", "text-halo-color", "#FFFDF6"]);
    expect(setPaintProperty.mock.calls.some(([id]) => id === "park")).toBe(false);
  });

  it("swallows cosmetic paint failures", () => {
    expect(() => applyFieldGuideBasemap({
      getLayer: () => ({ id: "background" }) as never,
      setPaintProperty: () => { throw new Error("style drift"); },
    })).not.toThrow();
  });

  it("reserves chrome space by viewport tier and banner state", () => {
    expect(mapViewportTier(320)).toBe("mobile");
    expect(mapViewportTier(768)).toBe("tablet");
    expect(mapViewportTier(1440)).toBe("desktop");
    expect(initialMapPadding(390, false)).toEqual({ top: 122, right: 18, bottom: 84, left: 18 });
    expect(initialMapPadding(320, true)).toEqual({ top: 178, right: 18, bottom: 84, left: 18 });
    expect(initialMapPadding(768, true)).toEqual({ top: 214, right: 28, bottom: 82, left: 28 });
    expect(initialMapPadding(1440, false)).toEqual({ top: 32, right: 32, bottom: 48, left: 32 });
    for (const width of [320, 844]) {
      const padding = initialMapPadding(width, true, 390);
      expect(padding.top! + padding.bottom!).toBeLessThan(390);
    }
  });

  it("keeps point-selection targets at the 44px touch minimum", () => {
    expect(MAP_POINT_HIT_RADIUS * 2).toBeGreaterThanOrEqual(44);
  });

  it("shows all alert levels by default, without quiet or unavailable markers", () => {
    for (const level of ["ELEVATED", "HIGH", "SEVERE"] as const) expect(locationAppearsOnMap(level, false)).toBe(true);
    for (const level of ["UNKNOWN", "NORMAL"] as const) expect(locationAppearsOnMap(level, false)).toBe(false);
  });

  it("keeps filters exclusive and searched destinations visible under every filter", () => {
    for (const level of ["NORMAL", "UNKNOWN", "ELEVATED", "HIGH", "SEVERE"] as const) {
      expect(locationAppearsOnMap(level, false, "high")).toBe(level === "HIGH" || level === "SEVERE");
      expect(locationAppearsOnMap(level, false, "unavailable")).toBe(level === "UNKNOWN");
      for (const filter of ["all", "high", "unavailable"] as const) expect(locationAppearsOnMap(level, true, filter)).toBe(true);
    }
  });

  it("counts destinations once, not hazards or evidence links, with production-like elevated-only data", () => {
    const snapshot = CompleteSnapshotSchema.parse(mapSnapshot());
    const state = Object.values(snapshot.locations).find((state) => state.level === "ELEVATED")!;
    if (state.level === "ELEVATED") state.hazards.push({ ...state.hazards[0], id: "extra-incident" });
    expect(mapFilterCounts(locations, snapshot)).toEqual({ all: 108, high: 0, elevated: 108, unavailable: 33 });
    expect(mapFilterCounts(locations, CompleteSnapshotSchema.parse(mapSnapshot(0, 0)))).toEqual({ all: 0, high: 0, elevated: 0, unavailable: 0 });
    expect(mapFilterCounts(locations, null)).toBeNull();
    expect(mapFilterCounts([], snapshot)).toBeNull();
    const alertStates = Object.values(snapshot.locations).filter((state) => state.level === "ELEVATED");
    for (const [index, level] of (["HIGH", "SEVERE"] as const).entries()) {
      const state = alertStates[index];
      state.level = level;
      state.hazards[0].level = level;
    }
    expect(mapFilterCounts(locations, snapshot)).toEqual({ all: 108, high: 2, elevated: 106, unavailable: 33 });
  });

  it("derives full-catalog bounds and the reviewed 496-destination core overview", () => {
    expect(catalogMapBounds([])).toBeNull();
    expect(catalogMapBounds(locations)).toEqual([
      [-31.127, 28.10178],
      [34, 68.05],
    ]);
    expect(locations.reduce((western, location) => location.centroid[0] < western.centroid[0] ? location : western).id).toBe("pt-santa-cruz-das-flores");
    expect(locations.reduce((eastern, location) => location.centroid[0] > eastern.centroid[0] ? location : eastern).id).toBe("cy-ayia-napa-coast");
    expect(locations.reduce((southern, location) => location.centroid[1] < southern.centroid[1] ? location : southern).id).toBe("es-las-palmas-de-gran-canaria");
    expect(locations.reduce((northern, location) => location.centroid[1] > northern.centroid[1] ? location : northern).id).toBe("fi-finnish-lapland");
    const bounds = catalogMapBounds(locations)!;
    for (const { centroid: [lng, lat] } of locations) {
      expect(lng).toBeGreaterThanOrEqual(bounds[0][0]);
      expect(lng).toBeLessThanOrEqual(bounds[1][0]);
      expect(lat).toBeGreaterThanOrEqual(bounds[0][1]);
      expect(lat).toBeLessThanOrEqual(bounds[1][1]);
    }
    const core = locations.filter(locationInCoreOverview);
    expect(CORE_EUROPE_BOUNDS).toEqual([[-12, 34], [35, 72]]);
    expect(core).toHaveLength(496);
    expect(locations.filter((location) => !locationInCoreOverview(location)).map(({ id }) => id)).toEqual([
      "es-las-palmas-de-gran-canaria",
      "es-santa-cruz-de-tenerife",
      "pt-funchal",
      "pt-horta",
      "pt-madeira",
      "pt-ponta-delgada",
      "pt-santa-cruz-das-flores",
    ]);
    expect(coreOverviewBounds(locations)).toEqual(catalogMapBounds(core));
    expect(coreOverviewBounds([])).toBeNull();
    expect(MAP_CLUSTER_MAX_ZOOM).toBe(6);
    expect(MAP_CLUSTER_RADIUS).toBe(46);
  });

  it("scales compact details padding with viewport height and leaves desktop chrome unchanged", () => {
    for (const height of [390, 768, 844]) {
      const compact = selectedDetailsPadding(true, height);
      expect(compact.bottom).toBe(Math.round(height * COMPACT_DETAILS_SHEET_RATIO));
      expect(compact).toEqual({ top: 16, right: 16, bottom: Math.round(height * COMPACT_DETAILS_SHEET_RATIO), left: 16 });
      expect(selectedDetailsPadding(false, height)).toEqual({ top: 24, right: 424, bottom: 24, left: 24 });
      expect(selectedDetailsPadding(false, height, false)).toEqual({ top: 24, right: 24, bottom: 24, left: 24 });
    }
  });

  it("tints exactly the 28 covered countries", () => {
    const collection = JSON.parse(readFileSync(path.join(process.cwd(), "public/covered-countries.geojson"), "utf8")) as {
      features: Array<{ properties: { countryCode: string } }>;
    };
    expect(collection.features.map((feature) => feature.properties.countryCode)).toEqual([...countryCodes]);
  });

  it("ignores coverage-overlay map errors", () => {
    expect(mapErrorSourceId({ sourceId: COVERED_COUNTRIES_SOURCE })).toBe(COVERED_COUNTRIES_SOURCE);
    expect(mapErrorSourceId({ sourceId: "locations" })).toBe("locations");
    expect(mapErrorSourceId({ error: new Error("style") })).toBeUndefined();
  });

  it("inserts the coverage fill before the first land or water layer", () => {
    expect(coverageLayerBeforeId({ getLayer: (id) => id === "water" ? ({ id } as never) : undefined })).toBe("water");
    expect(coverageLayerBeforeId({ getLayer: (id) => id === "park" ? ({ id } as never) : undefined })).toBe("park");
    expect(coverageLayerBeforeId({ getLayer: () => undefined })).toBeUndefined();
  });

  it("swallows coverage overlay failures", async () => {
    const addSource = vi.fn(() => { throw new Error("style drift"); });
    const addLayer = vi.fn();
    expect(() => applyCoveredCountriesLayer({
      getLayer: () => ({ id: "water" }) as never,
      getSource: () => undefined,
      addSource,
      addLayer,
    }, { type: "FeatureCollection", features: [] })).not.toThrow();
    expect(addLayer).not.toHaveBeenCalled();

    await expect(loadCoveredCountriesLayer({
      getLayer: () => undefined,
      getSource: () => undefined,
      addSource: vi.fn(),
      addLayer: vi.fn(),
    }, undefined, async () => { throw new Error("offline"); })).resolves.toBeUndefined();

    await expect(loadCoveredCountriesLayer({
      getLayer: () => undefined,
      getSource: () => undefined,
      addSource: vi.fn(),
      addLayer: vi.fn(),
    }, undefined, async () => new Response(null, { status: 404 }))).resolves.toBeUndefined();
  });

  it("adds a non-replacing coverage fill in the field-guide cream", () => {
    const addSource = vi.fn();
    const addLayer = vi.fn();
    const map = {
      getLayer: (id: string) => id === "water" ? ({ id } as never) : undefined,
      getSource: () => undefined,
      addSource,
      addLayer,
    };
    applyCoveredCountriesLayer(map, { type: "FeatureCollection", features: [] });
    expect(addSource).toHaveBeenCalledWith(COVERED_COUNTRIES_SOURCE, expect.objectContaining({ type: "geojson" }));
    expect(addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: COVERED_COUNTRIES_LAYER,
      type: "fill",
      paint: { "fill-color": COVERED_LAND_COLOR },
    }), "water");
    expect(COVERED_COUNTRIES_URL).toBe("/covered-countries.geojson");

    const skippedAddSource = vi.fn();
    applyCoveredCountriesLayer({ ...map, getLayer: () => undefined, addSource: skippedAddSource, addLayer: vi.fn() }, { type: "FeatureCollection", features: [] });
    expect(skippedAddSource).not.toHaveBeenCalled();

    const recoveredAddLayer = vi.fn();
    applyCoveredCountriesLayer({ ...map, getSource: () => ({}) as never, addSource: skippedAddSource, addLayer: recoveredAddLayer }, { type: "FeatureCollection", features: [] });
    expect(recoveredAddLayer).toHaveBeenCalledOnce();
  });
});
