import booleanIntersects from "@turf/boolean-intersects";
import { feature } from "@turf/helpers";
import { fromArrayBuffer } from "geotiff";
import { AggregateSourceResultSchema, type AggregateSourceResult, type DiscoveryCandidate, type Location, type NormalizedEvent } from "../../domain/schemas";
import { distanceKm, locationPolygon } from "../../geospatial";
import { fetchWithRetry, mapConcurrent } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

/** Returns true only for a four-cell orthogonally connected flood component. */
export function qualifiesGfmFlood(extent: ArrayLike<number>, likelihood: ArrayLike<number>, advisory: ArrayLike<number>, width: number) {
  if (extent.length !== likelihood.length || extent.length !== advisory.length || width < 1 || extent.length % width) return false;
  const eligible = new Set<number>();
  for (let index = 0; index < extent.length; index += 1) {
    if (Number(extent[index]) > 0 && Number(likelihood[index]) >= 70 && Number(advisory[index]) === 0) eligible.add(index);
  }
  const visited = new Set<number>();
  for (const start of eligible) {
    if (visited.has(start)) continue;
    const queue = [start]; let count = 0;
    while (queue.length) {
      const index = queue.pop()!; if (visited.has(index) || !eligible.has(index)) continue;
      visited.add(index); count += 1;
      const x = index % width;
      if (x > 0) queue.push(index - 1); if (x < width - 1) queue.push(index + 1);
      queue.push(index - width, index + width);
    }
    if (count >= 4) return true;
  }
  return false;
}

export type ActiveFireDetection = { id: string; sensor: "VIIRS" | "MODIS"; longitude: number; latitude: number; acquiredAt: string; confidence: "nominal" | "high" | number };
export function supportedActiveFire(detection: ActiveFireDetection, now: Date) {
  const confidence = detection.sensor === "VIIRS" ? detection.confidence === "high" : Number(detection.confidence) >= 80;
  const acquired = Date.parse(detection.acquiredAt);
  return confidence && Number.isFinite(acquired) && now.getTime() - acquired <= 12 * 60 * 60_000 && acquired <= now.getTime() + 5 * 60_000;
}

function candidateAffectsLocation(candidate: DiscoveryCandidate, location: Location) {
  if (candidate.geometry.type === "Point") return distanceKm(candidate.geometry.coordinates, location.centroid) <= 500;
  try { return booleanIntersects(feature(candidate.geometry), locationPolygon(location)); } catch { return false; }
}

export function selectGfmTargets(candidates: DiscoveryCandidate[], locations: Location[], now: Date, limit = 12) {
  const active = candidates.filter((candidate) => candidate.hazardType === "flood"
      && Date.parse(candidate.startsAt) <= now.getTime()
      && Date.parse(candidate.endsAt) > now.getTime()
      && Date.parse(candidate.expiresAt) > now.getTime())
    .sort((a, b) => Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt) || a.externalId.localeCompare(b.externalId));
  const selected = new Map<string, { location: Location; candidate: DiscoveryCandidate; proximity: number }>();
  for (const candidate of active) {
    for (const location of locations) {
      if (!candidateAffectsLocation(candidate, location)) continue;
      const proximity = candidate.geometry.type === "Point" ? distanceKm(candidate.geometry.coordinates, location.centroid) : 0;
      const previous = selected.get(location.id);
      if (!previous || proximity < previous.proximity || (proximity === previous.proximity && candidate.externalId < previous.candidate.externalId)) {
        selected.set(location.id, { location, candidate, proximity });
      }
    }
  }
  return [...selected.values()].sort((a, b) => a.proximity - b.proximity || a.location.id.localeCompare(b.location.id)).slice(0, limit);
}

export function selectGlofasLocations(raster: ArrayLike<number>, width: number, height: number, bbox: [number, number, number, number], locations: Location[]) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return locations.filter((location) => {
    const x = Math.round((location.centroid[0] - minLon) / (maxLon - minLon) * (width - 1));
    const y = Math.round((maxLat - location.centroid[1]) / (maxLat - minLat) * (height - 1));
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const sampleX = x + dx; const sampleY = y + dy;
      if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) continue;
      const value = Number(raster[sampleY * width + sampleX]);
      if (Number.isFinite(value) && value > 0 && value < 255) return true;
    }
    return false;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function glofasRiskMask(rasters: ArrayLike<number>[]) {
  if (rasters.length !== 3 || rasters.some((band) => band.length !== rasters[0].length)) throw new Error("Unexpected GloFAS RGB contract");
  return Uint8Array.from({ length: rasters[0].length }, (_, index) => {
    const [red, green, blue] = rasters.map((band) => Number(band[index]));
    if (red === 255 && green === 255 && blue === 255) return 0;
    if ((red === 255 && green === 254 && blue === 0) || (red === 230 && green === 0 && blue === 0)) return 1;
    throw new Error(`Unexpected GloFAS risk color ${red},${green},${blue}`);
  });
}

async function glofasTargetLocations(context: IngestionContext): Promise<Location[]> {
  if (process.env.GLOFAS_TARGETING_ENABLED !== "true") return [];
  const bbox: [number, number, number, number] = [-36, 25, 45, 72]; const width = 810; const height = 470;
  const query = new URLSearchParams({ SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: "sumAL41EGE", STYLES: "default", SRS: "EPSG:4326", BBOX: bbox.join(","), WIDTH: String(width), HEIGHT: String(height), FORMAT: "image/tiff", TIME: `${context.now.toISOString().slice(0, 10)}T00:00Z` });
  const response = await fetchWithRetry(context.fetch, `https://ows.globalfloods.eu/glofas-ows/ows.py?${query}`, {}, 1, 2 * 1024 * 1024, undefined, 5_000, "glofas_targeting");
  const tiff = await fromArrayBuffer(await response.arrayBuffer()); const image = await tiff.getImage();
  if (image.getWidth() !== width || image.getHeight() !== height) throw new Error("Unexpected GloFAS raster dimensions");
  const raster = glofasRiskMask(await image.readRasters());
  return selectGlofasLocations(raster, width, height, bbox, context.locations);
}

async function gfmRaster(context: IngestionContext, layer: string, bbox: [number, number, number, number], byteBudget: { remaining: number }) {
  if (Date.now() >= (context.deadlineAt ?? Number.POSITIVE_INFINITY)) throw new Error("Ingestion source deadline reached");
  const query = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: layer, STYLES: "",
    SRS: "EPSG:4326", BBOX: bbox.join(","), WIDTH: "256", HEIGHT: "256", FORMAT: "image/geotiff",
    TIME: `${context.now.toISOString().slice(0, 10)}T00:00:00.000Z`,
  });
  const response = await fetchWithRetry(
    context.fetch,
    `https://geoserver.gfm.eodc.eu/geoserver/gfm/wms?${query}`,
    {}, 3, 256 * 1024, byteBudget, 5_000, layer,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tiff = await fromArrayBuffer(bytes.slice().buffer as ArrayBuffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== 256 || image.getHeight() !== 256 || image.getSamplesPerPixel() !== 1) throw new Error(`Unexpected GFM ${layer} raster dimensions`);
  return (await image.readRasters())[0];
}

export class GfmAdapter implements SourceAdapter {
  readonly id = "gfm" as const;
  readonly cadence = "satellite" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    if (process.env.GFM_ENABLED !== "true") return AggregateSourceResultSchema.parse({
      sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "disabled", error: null,
      limitationCode: "environment_disabled", checkedLocationIds: [], unavailableLocationIds: [],
    });
    const gdacsTargets = selectGfmTargets(context.state?.candidates || [], context.locations, context.now, 12);
    const glofas = await glofasTargetLocations(context).then((value) => ({ locations: value, error: null })).catch((error) => ({ locations: [] as Location[], error: String(error).slice(0, 120) }));
    const gdacsLocationIds = new Set(gdacsTargets.map(({ location }) => location.id));
    const glofasTargets = glofas.locations.filter((location) => !gdacsLocationIds.has(location.id)).map((location) => ({
      location, proximity: 0, candidate: {
        providerId: "gdacs" as const, externalId: `glofas-days-1-3:${checkedAt.slice(0, 10)}:${location.id}`, hazardType: "flood" as const,
        geometry: { type: "Point" as const, coordinates: location.centroid }, startsAt: checkedAt, endsAt: new Date(context.now.getTime() + 24 * 60 * 60_000).toISOString(),
        sourceUpdatedAt: checkedAt, officialUrl: "https://global-flood.emergency.copernicus.eu/", expiresAt: new Date(context.now.getTime() + 24 * 60 * 60_000).toISOString(),
      },
    }));
    const targets = [...gdacsTargets, ...glofasTargets].slice(0, 12);
    recordSourceDiagnostics(context, { targetsScheduled: targets.length });
    if (!targets.length) return AggregateSourceResultSchema.parse({
      sourceId: this.id, checkedAt, sourceUpdatedAt: checkedAt, events: [], status: glofas.error ? "partial" : "ok",
      error: glofas.error ? "GloFAS targeting failed" : null,
      checkedLocationIds: [], unavailableLocationIds: [],
    });
    const byteBudget = { remaining: 9 * 1024 * 1024 };
    const results = await mapConcurrent(targets, 3, async ({ location, candidate }) => {
      try {
        if (Date.now() >= (context.deadlineAt ?? Number.POSITIVE_INFINITY)) throw new Error("Ingestion source deadline reached");
        const [longitude, latitude] = location.centroid;
        const latRadius = 2.56 / 110.574;
        const lonRadius = 2.56 / (111.32 * Math.max(0.1, Math.cos(latitude * Math.PI / 180)));
        const bbox: [number, number, number, number] = [longitude - lonRadius, latitude - latRadius, longitude + lonRadius, latitude + latRadius];
        const extent = await gfmRaster(context, "observed_flood_extent", bbox, byteBudget);
        const likelihood = await gfmRaster(context, "uncertainty_values", bbox, byteBudget);
        const advisory = await gfmRaster(context, "advisory_flags", bbox, byteBudget);
        const events: NormalizedEvent[] = qualifiesGfmFlood(extent, likelihood, advisory, 256) ? [{
          id: `gfm:${candidate.externalId}:${location.id}`, sourceId: "gfm", providerId: "gfm", type: "flood", level: "ELEVATED", timing: "ACTIVE",
          headline: `Satellite flood extent is detected near ${location.name}.`,
          explanation: candidate.externalId.startsWith("glofas-days-1-3:") ? "Current Copernicus Global Flood Monitoring pixels confirm a destination selected from the GloFAS days 1–3 forecast summary. The forecast alone is never published." : "Copernicus Global Flood Monitoring pixels corroborate an active GDACS flood candidate. Satellite evidence can contain false positives.",
          action: "Check local authority flood warnings and avoid flooded roads or waterways.", affectedArea: location.name,
          geometry: { kind: "locations", ids: [location.id] }, startsAt: checkedAt,
          endsAt: new Date(context.now.getTime() + 4 * 60 * 60_000).toISOString(), sourceUpdatedAt: checkedAt, checkedAt,
          expiresAt: new Date(context.now.getTime() + 4 * 60 * 60_000).toISOString(), sourceName: "Copernicus Global Flood Monitoring",
          sourceUrl: "https://global-flood.emergency.copernicus.eu/", confidence: "MEDIUM",
        }] : [];
        return { locationId: location.id, events, error: null };
      } catch (error) {
        return { locationId: location.id, events: [] as NormalizedEvent[], error: String(error).slice(0, 120) };
      }
    });
    const checkedLocationIds = results.filter(({ error }) => !error).map(({ locationId }) => locationId).sort();
    const unavailableLocationIds = results.filter(({ error }) => error).map(({ locationId }) => locationId).sort();
    const events = results.flatMap((result) => result.events).sort((a, b) => a.id.localeCompare(b.id));
    recordSourceDiagnostics(context, {
      recordsExamined: checkedLocationIds.length * 256 * 256,
      targetsCompleted: results.length,
      matchedLocations: events.length,
      ...(byteBudget.remaining < 1 ? { overflowCode: "gfm_run_byte_budget" } : {}),
    });
    const targetStatus = unavailableLocationIds.length === 0 ? "ok" : checkedLocationIds.length ? "partial" : "failed";
    const status = targetStatus === "ok" && glofas.error ? "partial" : targetStatus;
    const errors = [unavailableLocationIds.length ? `${unavailableLocationIds.length} GFM targets unavailable` : null, glofas.error ? "GloFAS targeting failed" : null].filter(Boolean);
    return AggregateSourceResultSchema.parse({
      sourceId: this.id, checkedAt, sourceUpdatedAt: checkedLocationIds.length ? checkedAt : null, events, status,
      error: errors.join("; ") || null,
      checkedLocationIds, unavailableLocationIds,
    });
  }
}
