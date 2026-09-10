"use client";

import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "@/lib/domain/catalog-public";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  applyFieldGuideBasemap,
  CATALOG_OVERVIEW_MAX_ZOOM,
  catalogMapBounds,
  coreOverviewBounds,
  COVERED_COUNTRIES_SOURCE,
  initialMapPadding,
  loadCoveredCountriesLayer,
  locationAppearsOnMap,
  MAP_CLUSTER_MAX_ZOOM,
  MAP_CLUSTER_RADIUS,
  MAP_POINT_HIT_RADIUS,
  mapErrorSourceId,
  selectedDetailsPadding,
  type MapFilter,
} from "@/lib/map-presentation";
import { publicAccessibleLabels, publicLabels, type SelectionOrigin } from "@/lib/ui-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./RiskMap.module.css";

export type MapCameraMode = "core" | "all-coverage" | "manual" | "destination";
export type MapCameraCommand = { mode: "core" | "all-coverage"; nonce: number };

const emptyPadding = { top: 0, right: 0, bottom: 0, left: 0 };
const severityRank = { NORMAL: 0, UNKNOWN: 1, ELEVATED: 2, HIGH: 3, SEVERE: 4 } as const;

function fitOverview(map: MapLibreMap, locations: PublicLocation[], healthBannerVisible: boolean, mode: "core" | "all-coverage"): void {
  const bounds = mode === "core" ? coreOverviewBounds(locations) : catalogMapBounds(locations);
  if (!bounds) return;
  const container = map.getContainer();
  map.stop();
  map.setPadding(emptyPadding);
  map.fitBounds(bounds, {
    padding: initialMapPadding(window.innerWidth, healthBannerVisible, container.clientHeight),
    maxZoom: CATALOG_OVERVIEW_MAX_ZOOM,
    duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
  });
}

function currentLayoutPadding(map: MapLibreMap, healthBannerVisible: boolean) {
  const container = map.getContainer();
  return initialMapPadding(window.innerWidth, healthBannerVisible, container.clientHeight);
}

function basemapSource(map: MapLibreMap): { url: string; tileTemplate: boolean } | null {
  for (const source of Object.values(map.getStyle().sources)) {
    if ("url" in source && typeof source.url === "string" && source.url.includes("openfreemap.org")) return { url: source.url, tileTemplate: false };
    if ("tiles" in source && Array.isArray(source.tiles)) {
      const template = source.tiles.find((url) => url.includes("openfreemap.org"));
      if (template) return { url: template, tileTemplate: true };
    }
  }
  return null;
}

function viewportTileUrl(template: string, map: MapLibreMap, minZoom = 0, maxZoom = 14): string {
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.floor(map.getZoom())));
  const scale = 2 ** zoom;
  const { lng, lat } = map.getCenter();
  const x = Math.floor(((lng + 180) / 360) * scale);
  const latitude = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * scale);
  return template.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{-y}", String(scale - y - 1)).replace("{ratio}", "");
}

async function verifyBasemap(map: MapLibreMap, signal: AbortSignal): Promise<void> {
  const source = basemapSource(map);
  if (!source) return;
  if (source.tileTemplate) {
    const response = await fetch(viewportTileUrl(source.url, map), { signal });
    if (!response.ok) throw new Error(`Basemap tile returned HTTP ${response.status}`);
    return;
  }
  const metadataResponse = await fetch(source.url, { signal });
  if (!metadataResponse.ok) throw new Error(`Basemap source returned HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json() as { tiles?: string[]; minzoom?: number; maxzoom?: number };
  const template = metadata.tiles?.find((url) => url.includes("openfreemap.org"));
  if (!template) throw new Error("Basemap source has no OpenFreeMap tile template");
  const tileResponse = await fetch(viewportTileUrl(template, map, metadata.minzoom, metadata.maxzoom), { signal });
  if (!tileResponse.ok) throw new Error(`Basemap tile returned HTTP ${tileResponse.status}`);
}

const featureCollection = (features: GeoJSON.Feature<GeoJSON.Point>[]): GeoJSON.FeatureCollection<GeoJSON.Point> => ({ type: "FeatureCollection", features });

export function RiskMap({ catalogVersion = 2, locations, snapshot, selectedId, filter, detailsOpen, compactMode, mobileMode, detailsOverlay, healthBannerVisible, viewActive, cameraCommand, onSelect, onFailure }: {
  catalogVersion?: 2 | 3;
  locations: PublicLocation[];
  snapshot: Snapshot | null;
  selectedId: string | null;
  filter: MapFilter;
  detailsOpen: boolean;
  compactMode: boolean;
  mobileMode: boolean;
  detailsOverlay: boolean;
  healthBannerVisible: boolean;
  viewActive: boolean;
  cameraCommand: MapCameraCommand | null;
  onSelect: (id: string, origin: SelectionOrigin, returnTarget: HTMLElement | null) => void;
  onFailure: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const onFailureRef = useRef(onFailure);
  const styleReadyRef = useRef(false);
  const postStyleErrorsRef = useRef<number[]>([]);
  const cameraContextRef = useRef<string | null>(null);
  const cameraModeRef = useRef<MapCameraMode>("core");
  const detailsOpenRef = useRef(false);
  const returnCameraRef = useRef<{ center: [number, number]; zoom: number; mode: MapCameraMode } | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [markerCount, setMarkerCount] = useState<number | null>(null);
  const [zoom, setZoom] = useState(4);
  const [cameraSnapshot, setCameraSnapshot] = useState({ lng: 10, lat: 50, zoom: 4, mode: "core" as MapCameraMode, padding: emptyPadding });
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { onFailureRef.current = onFailure; }, [onFailure]);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
    maplibregl.prewarm();
    const map = new maplibregl.Map({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [10, 50],
      zoom: 4,
      minZoom: 1.8,
      maxZoom: 12,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
      attributionControl: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    const attribution = container.current.querySelector<HTMLDetailsElement>(".maplibregl-ctrl-attrib");
    const collapseInitialAttribution = () => {
      if (!attribution || attribution.classList.contains("maplibregl-attrib-empty")) return;
      attribution.removeAttribute("open");
      attribution.classList.remove("maplibregl-compact-show");
      map.off("styledata", collapseInitialAttribution);
    };
    map.on("styledata", collapseInitialAttribution);
    collapseInitialAttribution();

    const failureTimer = window.setTimeout(() => { if (!styleReadyRef.current) onFailureRef.current(); }, 8_000);
    const probeController = new AbortController();
    let probeTimer: number | null = null;
    let disposed = false;

    map.on("style.load", () => {
      styleReadyRef.current = true;
      postStyleErrorsRef.current = [];
      applyFieldGuideBasemap(map);
      window.clearTimeout(failureTimer);
      probeTimer = window.setTimeout(() => probeController.abort(), 5_000);
      void verifyBasemap(map, probeController.signal).catch(() => { if (!disposed) onFailureRef.current(); }).finally(() => { if (probeTimer !== null) window.clearTimeout(probeTimer); });
    });
    map.on("error", (event) => {
      if (mapErrorSourceId(event) === COVERED_COUNTRIES_SOURCE) return;
      const message = String((event.error as Error | undefined)?.message || "");
      if (!styleReadyRef.current) {
        if (/style|source|network|fetch|load/i.test(message)) onFailureRef.current();
        return;
      }
      const now = Date.now();
      postStyleErrorsRef.current = [...postStyleErrorsRef.current.filter((timestamp) => now - timestamp < 10_000), now];
      if (postStyleErrorsRef.current.length >= 3) onFailureRef.current();
    });
    map.on("dragstart", () => {
      cameraModeRef.current = "manual";
    });
    let stopPointerPan: (() => void) | null = null;
    const onCanvasPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      stopPointerPan?.();
      const canvasContainer = map.getCanvasContainer();
      let nativeMouseDown = false;
      const noteNativeMouseDown = () => { nativeMouseDown = true; };
      canvasContainer.addEventListener("mousedown", noteNativeMouseDown, { capture: true, once: true });
      let lastX = event.clientX;
      let lastY = event.clientY;
      let panning = false;
      const onMove = (pointer: PointerEvent) => {
        if (pointer.pointerId !== event.pointerId) return;
        if (nativeMouseDown) return;
        const dx = pointer.clientX - lastX;
        const dy = pointer.clientY - lastY;
        if (!panning && Math.hypot(dx, dy) < 3) return;
        panning = true;
        lastX = pointer.clientX;
        lastY = pointer.clientY;
        cameraModeRef.current = "manual";
        map.panBy([-dx, -dy], { animate: false });
      };
      const stop = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
        canvasContainer.removeEventListener("mousedown", noteNativeMouseDown, true);
        if (stopPointerPan === stop) stopPointerPan = null;
      };
      const onUp = (pointer: PointerEvent) => {
        if (pointer.pointerId !== event.pointerId) return;
        stop();
      };
      stopPointerPan = stop;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    };
    map.getCanvas().addEventListener("pointerdown", onCanvasPointerDown);
    map.on("zoomstart", (event) => { if ("originalEvent" in event && event.originalEvent) cameraModeRef.current = "manual"; });
    map.on("zoom", () => setZoom(map.getZoom()));
    map.on("moveend", () => {
      const center = map.getCenter();
      const padding = map.getPadding();
      setCameraSnapshot({
        lng: center.lng,
        lat: center.lat,
        zoom: map.getZoom(),
        mode: cameraModeRef.current,
        padding: { top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0 },
      });
    });
    mapRef.current = map;
    return () => {
      disposed = true;
      stopPointerPan?.();
      map.getCanvas().removeEventListener("pointerdown", onCanvasPointerDown);
      window.clearTimeout(failureTimer);
      if (probeTimer !== null) window.clearTimeout(probeTimer);
      probeController.abort();
      styleReadyRef.current = false;
      map.remove();
      mapRef.current = null;
      postStyleErrorsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const controller = new AbortController();
    const load = () => { void loadCoveredCountriesLayer(map, controller.signal, fetch, catalogVersion); };
    map.on("style.load", load);
    if (map.isStyleLoaded()) load();
    return () => { controller.abort(); map.off("style.load", load); };
  }, [catalogVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || locations.length === 0) return;
    const selectedFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
    const visibleFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const location of locations) {
      const level = snapshot?.locations[location.id]?.level || "UNKNOWN";
      const selected = location.id === selectedId;
      if (!locationAppearsOnMap(level, selected, filter)) continue;
      const feature: GeoJSON.Feature<GeoJSON.Point> = {
        type: "Feature",
        geometry: { type: "Point", coordinates: location.centroid },
        properties: { id: location.id, name: location.name, country: location.country, level, severityRank: severityRank[level], status: publicLabels[level], accessibleStatus: publicAccessibleLabels[level] },
      };
      if (selected) selectedFeatures.push(feature);
      else visibleFeatures.push(feature);
    }
    const allVisibleCount = visibleFeatures.length + selectedFeatures.length;

    const fitCameraIfNeeded = () => {
      if (!styleReadyRef.current || !container.current?.clientWidth || !container.current.clientHeight || selectedId) return;
      if (cameraModeRef.current === "manual" || cameraModeRef.current === "destination") return;
      const context = `${window.innerWidth}:${window.innerHeight}:${container.current.clientWidth}:${container.current.clientHeight}:${healthBannerVisible}:${cameraModeRef.current}`;
      if (cameraContextRef.current === context) return;
      fitOverview(map, locations, healthBannerVisible, cameraModeRef.current === "all-coverage" ? "all-coverage" : "core");
      cameraContextRef.current = context;
    };

    const load = () => {
      const existing = map.getSource("locations") as GeoJSONSource | undefined;
      const selectedSource = map.getSource("selected-location") as GeoJSONSource | undefined;
      if (existing && selectedSource) {
        existing.setData(featureCollection(visibleFeatures));
        selectedSource.setData(featureCollection(selectedFeatures));
        setMarkerCount(allVisibleCount);
        fitCameraIfNeeded();
        setLocationsReady(true);
        return;
      }

      map.addSource("locations", {
        type: "geojson",
        data: featureCollection(visibleFeatures),
        cluster: true,
        clusterMaxZoom: MAP_CLUSTER_MAX_ZOOM,
        clusterRadius: MAP_CLUSTER_RADIUS,
        clusterProperties: { maxSeverity: ["max", ["get", "severityRank"]] },
      });
      map.addSource("selected-location", { type: "geojson", data: featureCollection(selectedFeatures) });
      map.addLayer({ id: "location-clusters", type: "circle", source: "locations", filter: ["has", "point_count"], paint: { "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 35, 27], "circle-color": ["match", ["get", "maxSeverity"], 4, "#A3253B", 3, "#B64318", 2, "#986100", "#53657C"], "circle-stroke-color": "#FFFDF6", "circle-stroke-width": 3 } });
      map.addLayer({ id: "location-cluster-count", type: "symbol", source: "locations", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true }, paint: { "text-color": "#fff" } });
      map.addLayer({ id: "location-hit-targets", type: "circle", source: "locations", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": MAP_POINT_HIT_RADIUS, "circle-color": "#000", "circle-opacity": 0.01 } });
      map.addLayer({ id: "locations-points", type: "circle", source: "locations", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": ["match", ["get", "level"], "NORMAL", 4, "UNKNOWN", 10, "ELEVATED", 10, "HIGH", 11.5, "SEVERE", 13, 10], "circle-color": ["match", ["get", "level"], "NORMAL", "#71847F", "ELEVATED", "#986100", "HIGH", "#B64318", "SEVERE", "#A3253B", "#596A80"], "circle-stroke-color": "#FFFDF6", "circle-stroke-width": ["match", ["get", "level"], "NORMAL", 1.5, 2.5] } });
      map.addLayer({ id: "location-status-symbols", type: "symbol", source: "locations", filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "level"], "NORMAL"]], layout: { "text-field": ["match", ["get", "level"], "UNKNOWN", "?", "SEVERE", "!!", "!"], "text-size": 10, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true }, paint: { "text-color": "#fff" } });
      map.addLayer({ id: "selected-location-halo", type: "circle", source: "selected-location", paint: { "circle-radius": 20, "circle-color": "rgba(255,253,246,0.86)", "circle-stroke-color": "#012F62", "circle-stroke-width": 3 } });
      map.addLayer({ id: "selected-location-point", type: "circle", source: "selected-location", paint: { "circle-radius": 8, "circle-color": ["match", ["get", "level"], "ELEVATED", "#986100", "HIGH", "#B64318", "SEVERE", "#A3253B", "#596A80"], "circle-stroke-color": "#FFFDF6", "circle-stroke-width": 2 } });
      map.addLayer({ id: "selected-location-label", type: "symbol", source: "selected-location", layout: { "text-field": ["get", "name"], "text-size": 12, "text-font": ["Noto Sans Bold"], "text-offset": [0, 2.25], "text-anchor": "top", "text-allow-overlap": true }, paint: { "text-color": "#173A3F", "text-halo-color": "#FFFDF6", "text-halo-width": 2 } });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: styles.tooltip });
      map.on("click", "location-hit-targets", (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") onSelectRef.current(id, "map", container.current);
      });
      map.on("click", "location-clusters", (event) => {
        const feature = event.features?.[0];
        const clusterId = Number(feature?.properties?.cluster_id);
        if (!feature || feature.geometry.type !== "Point" || !Number.isFinite(clusterId)) return;
        const coordinates = feature.geometry.coordinates as [number, number];
        const source = map.getSource("locations") as GeoJSONSource;
        void source.getClusterExpansionZoom(clusterId).then((nextZoom) => {
          cameraModeRef.current = "manual";
          map.easeTo({ center: coordinates, zoom: nextZoom, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220 });
          setAnnouncement(`Expanded a cluster of ${feature.properties?.point_count} destinations.`);
        });
      });
      map.on("mousemove", "location-hit-targets", (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;
        const { name, country, status, accessibleStatus } = feature.properties || {};
        map.getCanvas().style.cursor = "pointer";
        popup.setLngLat(feature.geometry.coordinates as [number, number]).setText(`${name}, ${country} · ${status}`).addTo(map);
        popup.getElement().setAttribute("aria-label", `${name}, ${country}. ${accessibleStatus}.`);
      });
      for (const layer of ["location-hit-targets", "location-clusters"]) {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
      }
      fitCameraIfNeeded();
      setMarkerCount(allVisibleCount);
      setLocationsReady(true);
    };

    let cancelled = false;
    let retryTimer: number | null = null;
    const loadWhenReady = () => {
      if (cancelled) return;
      if (map.isStyleLoaded()) load();
      else retryTimer = window.setTimeout(loadWhenReady, 100);
    };
    loadWhenReady();
    map.on("resize", fitCameraIfNeeded);
    return () => { cancelled = true; map.off("resize", fitCameraIfNeeded); if (retryTimer !== null) window.clearTimeout(retryTimer); };
  }, [filter, healthBannerVisible, locations, selectedId, snapshot]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !cameraCommand || locations.length === 0) return;
    cameraModeRef.current = cameraCommand.mode;
    cameraContextRef.current = null;
    fitOverview(map, locations, healthBannerVisible, cameraCommand.mode);
    setAnnouncement(cameraCommand.mode === "core" ? "Map reset to core Europe." : `Map now shows all ${locations.length} destinations.`);
  }, [cameraCommand, healthBannerVisible, locations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !viewActive) return;
    const frame = window.requestAnimationFrame(() => map.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [compactMode, detailsOpen, detailsOverlay, mobileMode, viewActive]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId || !map.getLayer("selected-location-halo")) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    const startedAt = performance.now();
    let frame = 0;
    const animate = (timestamp: number) => {
      if (!map.getLayer("selected-location-halo")) return;
      const progress = Math.min(1, (timestamp - startedAt) / 220);
      map.setPaintProperty("selected-location-halo", "circle-radius", 26 - progress * 6);
      map.setPaintProperty("selected-location-halo", "circle-opacity", 0.45 + progress * 0.55);
      if (progress < 1) frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const location = locations.find((item) => item.id === selectedId);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!location || !detailsOpen) {
      if (!detailsOpenRef.current) return;
      detailsOpenRef.current = false;
      const returnCamera = returnCameraRef.current;
      returnCameraRef.current = null;
      map.stop();
      if (!returnCamera) {
        cameraModeRef.current = "core";
        fitOverview(map, locations, healthBannerVisible, "core");
        return;
      }
      cameraModeRef.current = returnCamera.mode;
      map.easeTo({ center: returnCamera.center, zoom: returnCamera.zoom, padding: currentLayoutPadding(map, healthBannerVisible), duration: reduceMotion ? 0 : 180, essential: false });
      return;
    }
    if (!detailsOpenRef.current) {
      const center = map.getCenter();
      returnCameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom(), mode: cameraModeRef.current };
      detailsOpenRef.current = true;
    }
    cameraModeRef.current = "destination";
    map.easeTo({ center: location.centroid, zoom: Math.max(map.getZoom(), compactMode ? 6.75 : 7.25), padding: selectedDetailsPadding(compactMode, window.innerHeight, detailsOverlay), duration: reduceMotion ? 0 : 420, essential: false });
  }, [compactMode, detailsOpen, detailsOverlay, healthBannerVisible, locations, selectedId]);

  const changeZoom = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    cameraModeRef.current = "manual";
    map.easeTo({ center: map.getCenter(), zoom: Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + delta)), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220 });
  };

  return <>
    <div ref={container} className={styles.map} role="region" data-locations-ready={locationsReady} data-marker-count={markerCount} data-camera-mode={cameraSnapshot.mode} data-camera-lng={cameraSnapshot.lng.toFixed(5)} data-camera-lat={cameraSnapshot.lat.toFixed(5)} data-camera-zoom={cameraSnapshot.zoom.toFixed(3)} data-camera-padding={`${cameraSnapshot.padding.top},${cameraSnapshot.padding.right},${cameraSnapshot.padding.bottom},${cameraSnapshot.padding.left}`} aria-label="Interactive map of destination risk. Use search or the Alerts view for a keyboard-accessible alternative." />
    <div className={styles.cameraControls} aria-label="Map camera controls">
      <button type="button" aria-label="Reset map to core Europe" onClick={() => { const map = mapRef.current; if (!map) return; cameraModeRef.current = "core"; cameraContextRef.current = null; fitOverview(map, locations, healthBannerVisible, "core"); setAnnouncement("Map reset to core Europe."); }}><UiIcon name="home" /></button>
      <button type="button" aria-label="Zoom in" disabled={zoom >= 11.99} onClick={() => changeZoom(.75)}><UiIcon name="plus" /></button>
      <button type="button" aria-label="Zoom out" disabled={zoom <= 1.81} onClick={() => changeZoom(-.75)}><UiIcon name="minus" /></button>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </>;
}
