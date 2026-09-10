import { createHash } from "node:crypto";
import { fromArrayBuffer } from "geotiff";
import booleanIntersects from "@turf/boolean-intersects";
import { feature, multiPolygon, polygon } from "@turf/helpers";
import { AggregateSourceResultSchema, type AggregateSourceResult, type Location, type NormalizedEvent } from "../../domain/schemas";
import { distanceKm, eventAffectsLocation, locationPolygon } from "../../geospatial";
import { fetchAllowlisted, mapConcurrent } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";
import { supportedActiveFire, type ActiveFireDetection } from "./satellite";

const host = "firms.modaps.eosdis.nasa.gov";
const effisHost = "maps.effis.emergency.copernicus.eu";
const datasets = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"] as const;
const area = "-25,25,45,72";
const maxResponseBytes = 1_300_000;
const expiryMs = 12 * 60 * 60_000;

type Dataset = typeof datasets[number];
type FirmsDetection = ActiveFireDetection & { dataset: Dataset | "EFFIS"; satellite: string; transport?: "EFFIS" | "FIRMS" };

function acquiredAt(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(time)) return null;
  const padded = time.padStart(4, "0");
  const hour = Number(padded.slice(0, 2));
  const minute = Number(padded.slice(2));
  if (hour > 23 || minute > 59) return null;
  const parsed = new Date(`${date}T${padded.slice(0, 2)}:${padded.slice(2)}:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function parseFirmsCsv(csv: string, dataset: Dataset, now: Date): { detections: FirmsDetection[]; invalidRows: number; validRows: number } {
  const lines = csv.trim().split(/\r?\n/);
  const headers = (lines.shift() || "").split(",").map((value) => value.trim());
  const field = Object.fromEntries(headers.map((name, index) => [name, index]));
  const required = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence"];
  if (required.some((name) => field[name] === undefined)) throw new Error("FIRMS response is missing required columns");

  const detections: FirmsDetection[] = [];
  let invalidRows = 0;
  let validRows = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const values = line.split(",");
    const rawLatitude = values[field.latitude]?.trim() || "";
    const rawLongitude = values[field.longitude]?.trim() || "";
    const latitude = rawLatitude ? Number(rawLatitude) : Number.NaN;
    const longitude = rawLongitude ? Number(rawLongitude) : Number.NaN;
    const detectedAt = acquiredAt(values[field.acq_date]?.trim() || "", values[field.acq_time]?.trim() || "");
    const instrument = values[field.instrument]?.trim().toUpperCase();
    const satellite = values[field.satellite]?.trim() || "";
    const rawConfidence = values[field.confidence]?.trim().toLowerCase();
    const sensor = instrument === "VIIRS" ? "VIIRS" as const : instrument === "MODIS" ? "MODIS" as const : null;
    const expectedSensor = dataset === "MODIS_NRT" ? "MODIS" : "VIIRS";
    const confidence = sensor === "VIIRS"
      ? rawConfidence === "n" ? "nominal" as const : rawConfidence === "h" ? "high" as const : rawConfidence === "l" ? 0 : null
      : rawConfidence !== "" && Number.isFinite(Number(rawConfidence)) ? Number(rawConfidence) : null;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !detectedAt || !satellite || sensor !== expectedSensor || confidence === null) {
      invalidRows += 1;
      continue;
    }
    validRows += 1;
    const detection: FirmsDetection = {
      id: `${dataset}:${detectedAt}:${latitude.toFixed(5)}:${longitude.toFixed(5)}`,
      dataset, satellite,
      sensor, latitude, longitude, acquiredAt: detectedAt, confidence, transport: "FIRMS",
    };
    if (supportedActiveFire(detection, now)) detections.push(detection);
  }
  return { detections, invalidRows, validRows };
}

function detectionEvent(detection: FirmsDetection, checkedAt: string): NormalizedEvent {
  const endsAt = new Date(Date.parse(detection.acquiredAt) + expiryMs).toISOString();
  return {
    id: `active-fire:${detection.id}`,
    sourceId: "effis-active-fire",
    providerId: "effis-active-fire",
    type: "wildfire",
    level: "ELEVATED",
    timing: "ACTIVE",
    headline: "A satellite fire hotspot was detected nearby.",
    explanation: `${detection.transport === "EFFIS" ? "EFFIS" : "NASA FIRMS"} detected a recent thermal hotspot. Satellite detections can miss fires and do not confirm a wildfire perimeter or evacuation area.`,
    action: "Check official local fire information before travelling near the affected area.",
    affectedArea: "Within 25 km of a destination",
    geometry: { kind: "point", coordinates: [detection.longitude, detection.latitude], radiusKm: 25 },
    startsAt: detection.acquiredAt,
    endsAt,
    sourceUpdatedAt: detection.acquiredAt,
    checkedAt,
    expiresAt: endsAt,
    sourceName: detection.transport === "EFFIS" ? "EFFIS active fires" : "NASA FIRMS",
    sourceUrl: detection.transport === "EFFIS" ? "https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation/" : "https://firms.modaps.eosdis.nasa.gov/",
    confidence: "MEDIUM",
  };
}

function preferDetection(candidate: FirmsDetection, current: FirmsDetection): boolean {
  if (candidate.sensor !== current.sensor) return candidate.sensor === "VIIRS";
  return Date.parse(candidate.acquiredAt) > Date.parse(current.acquiredAt);
}

function eventsForLocations(detections: FirmsDetection[], context: IngestionContext): NormalizedEvent[] {
  const selected = new Map<string, FirmsDetection>();
  const checkedAt = context.now.toISOString();
  const locationsById = new Map(context.locations.map((location) => [location.id, location]));
  const matchRadius = new Map(context.locations.map((location) => [location.id, location.geometry.kind === "radius"
    ? location.geometry.radiusKm + 25
    : Math.max(...location.geometry.coordinates.flatMap((ring) => ring).map((position) => distanceKm(location.centroid, position))) + 25]));
  for (const detection of detections) {
    const candidate = detectionEvent(detection, checkedAt);
    const detectionPoint: [number, number] = [detection.longitude, detection.latitude];
    for (const location of context.locations) {
      if (distanceKm(detectionPoint, location.centroid) > matchRadius.get(location.id)!) continue;
      if (!eventAffectsLocation(candidate, location)) continue;
      const current = selected.get(location.id);
      if (!current || preferDetection(detection, current)) selected.set(location.id, detection);
    }
  }
  return [...selected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([locationId, detection]) => {
    const location = locationsById.get(locationId)!;
    return {
      ...detectionEvent(detection, checkedAt),
      id: `active-fire:${detection.id}:${locationId}`,
      headline: `A satellite fire hotspot was detected near ${location.name}.`,
      affectedArea: `Within 25 km of ${location.name}`,
      geometry: { kind: "locations" as const, ids: [locationId] },
    };
  });
}

function field(text: string, names: string[]) {
  for (const name of names) {
    const match = text.match(new RegExp(`\\b${name}\\s*=\\s*['\"]?([^'\"\\r\\n<]+)`, "i"));
    if (match) return match[1].trim();
  }
  return "";
}

export function parseEffisFeatureInfo(text: string, now: Date): FirmsDetection[] {
  const blocks = text.split(/(?:^|\n)\s*Feature \d+:/i).slice(1);
  return blocks.flatMap((block, index) => {
    const latitude = Number(field(block, ["latitude", "lat"]));
    const longitude = Number(field(block, ["longitude", "lon"]));
    const rawDate = field(block, ["acq_datetime", "acq_date", "datetime", "date"]);
    const rawTime = field(block, ["acq_time", "time"]);
    const directTime = Date.parse(rawDate);
    const acquired = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawTime
      ? acquiredAt(rawDate, rawTime)
      : Number.isFinite(directTime) ? new Date(directTime).toISOString() : null;
    const acquiredTime = Date.parse(String(acquired || ""));
    const instrument = field(block, ["instrument", "sensor", "satellite"]).toUpperCase();
    const sensor = instrument.includes("MODIS") ? "MODIS" as const : instrument ? "VIIRS" as const : null;
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(acquiredTime) || acquiredTime > now.getTime() + 5 * 60_000 || now.getTime() - acquiredTime > expiryMs || !sensor) return [];
    const acquiredAtValue = new Date(acquiredTime).toISOString();
    return [{ id: `EFFIS:${acquiredAtValue}:${latitude.toFixed(5)}:${longitude.toFixed(5)}:${index}`, dataset: "EFFIS" as const, satellite: instrument, sensor, latitude, longitude, acquiredAt: acquiredAtValue, confidence: "nominal" as const, transport: "EFFIS" as const }];
  });
}

export function effisCandidatePixels(raster: ArrayLike<number>, width: number, height: number, locations: Location[], limit = 50) {
  const occupied = new Set<number>();
  for (let index = 0; index < raster.length; index += 1) if (Number(raster[index]) !== 0) occupied.add(index);
  const visited = new Set<number>();
  const candidates: Array<{ pixel: [number, number]; proximity: number; size: number }> = [];
  for (const start of occupied) {
    if (visited.has(start)) continue;
    const queue = [start]; const component: number[] = [];
    while (queue.length) {
      const index = queue.pop()!; if (visited.has(index) || !occupied.has(index)) continue;
      visited.add(index); component.push(index); const x = index % width;
      if (x > 0) queue.push(index - 1); if (x < width - 1) queue.push(index + 1);
      if (index >= width) queue.push(index - width); if (index + width < raster.length) queue.push(index + width);
    }
    const representative = component.sort((a, b) => a - b)[Math.floor(component.length / 2)];
    const x = representative % width; const y = Math.floor(representative / width);
    const lon = -25 + (x + 0.5) / width * 70; const lat = 72 - (y + 0.5) / height * 47;
    const proximity = locations.length ? Math.min(...locations.map((location) => distanceKm([lon, lat], location.centroid))) : 0;
    candidates.push({ pixel: [x, y], proximity, size: component.length });
  }
  return { pixels: candidates.sort((a, b) => a.proximity - b.proximity || b.size - a.size || a.pixel[1] - b.pixel[1] || a.pixel[0] - b.pixel[0]).slice(0, limit).map(({ pixel }) => pixel), overflow: candidates.length > limit };
}

export async function fetchEffisDetections(context: IngestionContext) {
  const bbox = [-25, 25, 45, 72] as const;
  const width = 700;
  const height = 470;
  const common = { SERVICE: "WMS", VERSION: "1.1.1", STYLES: "default", SRS: "EPSG:4326", BBOX: bbox.join(","), WIDTH: String(width), HEIGHT: String(height) };
  const mapUrl = `https://${effisHost}/effis?${new URLSearchParams({ ...common, REQUEST: "GetMap", LAYERS: "all.hs", FORMAT: "image/tiff", TRANSPARENT: "true" })}`;
  const response = await fetchAllowlisted(context.fetch, mapUrl, [effisHost], 3, { maxBytes: 2 * 1024 * 1024, diagnosticsCategory: "effis_candidates" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tiff = await fromArrayBuffer(bytes.slice().buffer as ArrayBuffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== width || image.getHeight() !== height || image.getSamplesPerPixel() !== 1) throw new Error("EFFIS active-fire raster dimensions changed");
  const raster = (await image.readRasters())[0];
  const selected = effisCandidatePixels(raster, width, height, context.locations, 50);
  const candidates = selected.pixels;
  const confirmations = await mapConcurrent(candidates, 4, async ([x, y]) => {
    try {
      const infoUrl = `https://${effisHost}/effis?${new URLSearchParams({ ...common, REQUEST: "GetFeatureInfo", LAYERS: "all.hs", QUERY_LAYERS: "all.hs.query", INFO_FORMAT: "text/plain", FEATURE_COUNT: "10", X: String(x), Y: String(y) })}`;
      const info = await fetchAllowlisted(context.fetch, infoUrl, [effisHost], 2, { maxBytes: 64 * 1024, diagnosticsCategory: "effis_confirmations" }).then((item) => item.text());
      const parsed = parseEffisFeatureInfo(info, context.now);
      return { parsed, invalid: !parsed.length && /Feature \d+:/i.test(info) ? 1 : 0, failed: 0 };
    } catch { return { parsed: [] as FirmsDetection[], invalid: 0, failed: 1 }; }
  });
  const detections = confirmations.flatMap(({ parsed }) => parsed);
  const invalid = confirmations.reduce((total, item) => total + item.invalid, 0);
  const failures = confirmations.reduce((total, item) => total + item.failed, 0);
  const unique = new Map(detections.map((detection) => [`${detection.sensor}:${detection.acquiredAt}:${detection.latitude.toFixed(4)}:${detection.longitude.toFixed(4)}`, detection]));
  recordSourceDiagnostics(context, { recordsExamined: candidates.length, targetsScheduled: candidates.length, targetsCompleted: candidates.length, overflowCode: selected.overflow ? "effis_candidate_limit" : undefined });
  return { detections: [...unique.values()], invalid, failures, overflow: selected.overflow };
}

export type EffisPerimeter = { id: string; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown }; updatedAt: string };
export function parseEffisPerimeters(value: unknown, now: Date): Perimeter[] {
  const features = value && typeof value === "object" ? (value as { features?: unknown }).features : null;
  if (!Array.isArray(features)) throw new Error("EFFIS perimeter response is not GeoJSON");
  return features.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as { id?: unknown; geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> };
    if (item.geometry?.type !== "Polygon" && item.geometry?.type !== "MultiPolygon") return [];
    const updated = Date.parse(String(item.properties?.lastupdate || item.properties?.updated || item.properties?.firedate || item.properties?.acq_date || ""));
    if (!Number.isFinite(updated) || updated > now.getTime() + 5 * 60_000 || now.getTime() - updated > 12 * 60 * 60_000) return [];
    try {
      if (item.geometry.type === "Polygon") polygon(item.geometry.coordinates as Parameters<typeof polygon>[0]);
      else multiPolygon(item.geometry.coordinates as Parameters<typeof multiPolygon>[0]);
    }
    catch { return []; }
    return [{ id: String(item.id || item.properties?.id || index), geometry: item.geometry as Perimeter["geometry"], updatedAt: new Date(updated).toISOString() }];
  });
}

function gmlRing(text: string): number[][] | null {
  const raw = text.match(/<gml:posList\b[^>]*>([\s\S]*?)<\/gml:posList>/i)?.[1];
  if (!raw) return null;
  const values = raw.trim().split(/\s+/).map(Number);
  if (values.length < 8 || values.length % 2 !== 0 || values.some((value) => !Number.isFinite(value))) return null;
  const ring = Array.from({ length: values.length / 2 }, (_, index) => [values[index * 2], values[index * 2 + 1]]);
  if (ring[0][0] !== ring.at(-1)?.[0] || ring[0][1] !== ring.at(-1)?.[1]) return null;
  return ring;
}

export function parseEffisPerimeterGml(text: string, confirmedAt: Date): Perimeter[] {
  if (!/<wfs:FeatureCollection\b/i.test(text)) throw new Error("EFFIS perimeter response is not WFS GML");
  const members = [...text.matchAll(/<gml:featureMember\b[^>]*>([\s\S]*?)<\/gml:featureMember>/gi)];
  return members.flatMap((member) => {
    const polygons = [...member[1].matchAll(/<gml:Polygon\b[^>]*>([\s\S]*?)<\/gml:Polygon>/gi)].flatMap((match) => {
      const exterior = match[1].match(/<gml:exterior\b[^>]*>([\s\S]*?)<\/gml:exterior>/i)?.[1];
      const outer = exterior ? gmlRing(exterior) : null;
      if (!outer) return [];
      const holes = [...match[1].matchAll(/<gml:interior\b[^>]*>([\s\S]*?)<\/gml:interior>/gi)].map((hole) => gmlRing(hole[1])).filter((ring): ring is number[][] => Boolean(ring));
      return [[outer, ...holes]];
    });
    if (!polygons.length) return [];
    const geometry: Perimeter["geometry"] = polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
    const id = createHash("sha256").update(JSON.stringify(geometry)).digest("hex").slice(0, 24);
    return [{ id, geometry, updatedAt: confirmedAt.toISOString() }];
  });
}

type Perimeter = EffisPerimeter;

function perimeterNearPoint(perimeter: Perimeter, coordinates: [number, number], radiusKm: number) {
  const buffer = polygon([Array.from({ length: 33 }, (_, index) => {
    const angle = index % 32 / 32 * Math.PI * 2;
    return [coordinates[0] + Math.cos(angle) * radiusKm / (111.32 * Math.max(0.01, Math.cos(coordinates[1] * Math.PI / 180))), coordinates[1] + Math.sin(angle) * radiusKm / 110.574];
  })]);
  try { return booleanIntersects(feature(perimeter.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon), buffer); }
  catch { return false; }
}

function pointToSegmentKm(point: number[], start: number[], end: number[]) {
  const latitude = (point[1] + start[1] + end[1]) / 3 * Math.PI / 180;
  const longitudeScale = 111.32 * Math.cos(latitude); const latitudeScale = 110.574;
  const px = point[0] * longitudeScale; const py = point[1] * latitudeScale;
  const ax = start[0] * longitudeScale; const ay = start[1] * latitudeScale;
  const bx = end[0] * longitudeScale; const by = end[1] * latitudeScale;
  const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
  const ratio = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + ratio * (bx - ax)), py - (ay + ratio * (by - ay)));
}

function geometryRings(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon) {
  return geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat(1);
}

function ringsWithinKm(left: number[][][], right: number[][][], limit: number) {
  const near = (points: number[][][], segments: number[][][]) => points.some((ring) => ring.some((point) => segments.some((other) => other.slice(1).some((end, index) => pointToSegmentKm(point, other[index], end) <= limit))));
  return near(left, right) || near(right, left);
}

export function effisPerimeterNearLocation(perimeter: Perimeter, location: Location) {
  try {
    const perimeterFeature = feature(perimeter.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon);
    const destination = locationPolygon(location);
    return booleanIntersects(perimeterFeature, destination)
      || ringsWithinKm(geometryRings(perimeter.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon), destination.geometry.coordinates, 25);
  } catch { return false; }
}

async function effisPerimeterEvents(detections: FirmsDetection[], context: IngestionContext): Promise<{ events: NormalizedEvent[]; failures: number }> {
  if (process.env.EFFIS_PERIMETERS_ENABLED !== "true" || !detections.length) return { events: [], failures: 0 };
  const windows = [...new Map(detections.map((detection) => [`${Math.floor(detection.longitude)}:${Math.floor(detection.latitude)}`, detection])).values()].slice(0, 12);
  const budget = { remaining: 4 * 1024 * 1024 };
  let failed = 0;
  const results = await mapConcurrent(windows, 4, async (detection) => {
    try {
      const bbox = [detection.longitude - 0.6, detection.latitude - 0.6, detection.longitude + 0.6, detection.latitude + 0.6].join(",");
      const infoBbox = [detection.longitude - 0.1, detection.latitude - 0.1, detection.longitude + 0.1, detection.latitude + 0.1].join(",");
      const info = new URLSearchParams({ service: "WMS", version: "1.1.1", request: "GetFeatureInfo", layers: "effis.nrt.ba.poly", query_layers: "effis.nrt.ba.poly", styles: "default", srs: "EPSG:4326", bbox: infoBbox, width: "101", height: "101", x: "50", y: "50", info_format: "text/plain", feature_count: "5", time: context.now.toISOString().slice(0, 10) });
      const current = await fetchAllowlisted(context.fetch, `https://${effisHost}/effis?${info}`, [effisHost], 1, { maxBytes: 64 * 1024, byteBudget: budget, diagnosticsCategory: "effis_perimeter_confirmation" }).then((response) => response.text());
      if (!/Feature \d+:/i.test(current)) return [];
      info.set("time", new Date(context.now.getTime() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10));
      const future = await fetchAllowlisted(context.fetch, `https://${effisHost}/effis?${info}`, [effisHost], 1, { maxBytes: 64 * 1024, byteBudget: budget, diagnosticsCategory: "effis_perimeter_confirmation" }).then((response) => response.text());
      if (/Feature \d+:/i.test(future)) throw new Error("EFFIS perimeter time slice was not confirmed");
      const query = new URLSearchParams({ service: "WFS", version: "1.1.0", request: "GetFeature", typeName: "effis.nrt.ba.poly", maxFeatures: "100", bbox: `${bbox},EPSG:4326`, time: context.now.toISOString().slice(0, 10) });
      const perimeters = await fetchAllowlisted(context.fetch, `https://${effisHost}/effis?${query}`, [effisHost], 1, { maxBytes: 350 * 1024, byteBudget: budget, diagnosticsCategory: "effis_perimeters" })
        .then((response) => response.text()).then((text) => parseEffisPerimeterGml(text, context.now));
      if (!perimeters.length) throw new Error("EFFIS returned no valid current perimeter geometry");
      return perimeters.filter((perimeter) => perimeterNearPoint(perimeter, [detection.longitude, detection.latitude], 2));
    } catch { failed += 1; return []; }
  });
  const perimeters = results.flat(); const checkedAt = context.now.toISOString();
  const events = context.locations.flatMap((location) => {
    const perimeter = perimeters.find((candidate) => effisPerimeterNearLocation(candidate, location));
    if (!perimeter) return [];
    const paired = detections.filter((detection) => distanceKm([detection.longitude, detection.latitude], location.centroid) <= (location.geometry.kind === "radius" ? location.geometry.radiusKm : 0) + 25 && context.now.getTime() - Date.parse(detection.acquiredAt) <= expiryMs)
      .sort((a, b) => Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt))[0];
    if (!paired) return [];
    const expiresAt = new Date(Date.parse(paired.acquiredAt) + expiryMs).toISOString();
    return [{ id: `active-fire:perimeter:${perimeter.id}:${location.id}`, sourceId: "effis-active-fire" as const, providerId: "effis-active-fire" as const, type: "wildfire" as const, level: "HIGH" as const, timing: "ACTIVE" as const,
      headline: `A fresh mapped wildfire perimeter affects ${location.name}.`, explanation: "EFFIS reports a current burned-area perimeter paired with a satellite detection no older than 12 hours.",
      action: "Avoid the affected area and follow local fire and evacuation instructions.", affectedArea: `${location.name} and its 25 km buffer`, geometry: { kind: "locations" as const, ids: [location.id] },
      startsAt: perimeter.updatedAt, endsAt: expiresAt, sourceUpdatedAt: perimeter.updatedAt, checkedAt, expiresAt, sourceName: "EFFIS active-fire perimeter", sourceUrl: "https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation/", confidence: "MEDIUM" as const }];
  });
  return { events, failures: failed };
}

export class FirmsAdapter implements SourceAdapter {
  readonly id = "effis-active-fire" as const;
  readonly cadence = "slow" as const;

  constructor(private readonly mapKey = process.env.FIRMS_MAP_KEY?.trim()) {}

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const firmsConfigured = Boolean(this.mapKey && /^[A-Za-z0-9]{32}$/.test(this.mapKey));
    const effis = await fetchEffisDetections(context).then((value) => ({ value, error: null })).catch((error) => ({ value: null, error: String(error) }));
    recordSourceDiagnostics(context, { outcomeCode: `effis_${effis.value ? "ok" : "failed"}` });
    const results = firmsConfigured ? await Promise.allSettled(datasets.map(async (dataset) => {
      const url = `https://${host}/api/area/csv/${this.mapKey}/${dataset}/${area}/1`;
      const response = await fetchAllowlisted(context.fetch, url, [host], 3, {
        maxBytes: maxResponseBytes,
        byteBudget: { remaining: maxResponseBytes },
        diagnosticsCategory: dataset,
      });
      return parseFirmsCsv(await response.text(), dataset, context.now);
    })) : [];
    recordSourceDiagnostics(context, { targetsScheduled: results.length, targetsCompleted: results.length, outcomeCode: firmsConfigured ? undefined : "firms_not_configured" });
    results.forEach((result, index) => recordSourceDiagnostics(context, {
      outcomeCode: `firms_${datasets[index]}_${result.status === "fulfilled" ? "ok" : "failed"}`,
    }));
    const successes = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!effis.value && successes.length === 0) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: "All active-fire transports failed" });
    }
    const detections = [...(effis.value?.detections || []), ...successes.flatMap(({ detections }) => detections)];
    const invalidRows = successes.reduce((total, result) => total + result.invalidRows, 0);
    const validRows = successes.reduce((total, result) => total + result.validRows, 0);
    const failedDatasets = results.length - successes.length;
    if (!effis.value && invalidRows > 0 && validRows === 0) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: "FIRMS responses contained no parseable rows" });
    }
    const perimeters = await effisPerimeterEvents(detections, context);
    const perimeterLocations = new Set(perimeters.events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : []));
    const events = [...eventsForLocations(detections, context).filter((event) => event.geometry.kind !== "locations" || !event.geometry.ids.some((id) => perimeterLocations.has(id))), ...perimeters.events];
    recordSourceDiagnostics(context, { recordsExamined: validRows + invalidRows, matchedLocations: events.length });
    const sourceUpdatedAt = detections.map(({ acquiredAt }) => acquiredAt).sort().at(-1) || checkedAt;
    const partial = !effis.value || failedDatasets > 0 || invalidRows > 0 || Boolean(effis.value?.invalid) || Boolean(effis.value?.failures) || Boolean(effis.value?.overflow) || perimeters.failures > 0;
    const error = [
      failedDatasets ? `${failedDatasets} FIRMS dataset requests failed` : null,
      invalidRows ? `${invalidRows} malformed FIRMS rows ignored` : null,
      effis.error ? "EFFIS active-fire transport failed" : null,
      effis.value?.invalid ? `${effis.value.invalid} malformed EFFIS records ignored` : null,
      effis.value?.failures ? `${effis.value.failures} EFFIS confirmation requests failed` : null,
      effis.value?.overflow ? "EFFIS candidate limit reached" : null,
      perimeters.failures ? `${perimeters.failures} EFFIS perimeter windows failed` : null,
    ].filter(Boolean).join("; ") || null;
    return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt, events, status: partial ? "partial" : "ok", error });
  }
}
