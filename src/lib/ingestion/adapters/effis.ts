import { fromArrayBuffer } from "geotiff";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon } from "@turf/helpers";
import { AggregateSourceResultSchema, type AggregateSourceResult, type Location, type NormalizedEvent } from "../../domain/schemas";
import { locationPolygon } from "../../geospatial";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const outdoorTypes = new Set(["resort", "island", "park", "mountain", "coastal"]);

export function fwiLevel(value: number) { return value >= 38 ? "ELEVATED" as const : null; }

export function effisSourceTimestamp(productDate: string, now: Date): string {
  const timestamp = Date.parse(`${productDate}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > 30 * 60 * 60_000) {
    throw new Error("EFFIS product date is missing or stale");
  }
  return new Date(timestamp).toISOString();
}

export function sampleFwi(raster: ArrayLike<number>, width: number, height: number, bbox: [number, number, number, number], location: Location): number | null {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latitudeScale = 110.574;
  const longitudeScale = 111.32 * Math.max(0.1, Math.cos((location.centroid[1] * Math.PI) / 180));
  const ring = location.geometry.kind === "polygon" ? location.geometry.coordinates[0] : null;
  const longitudeRadius = location.geometry.kind === "radius" ? location.geometry.radiusKm / longitudeScale : 0;
  const latitudeRadius = location.geometry.kind === "radius" ? location.geometry.radiusKm / latitudeScale : 0;
  const longitudes = ring ? ring.map(([longitude]) => longitude) : [location.centroid[0] - longitudeRadius, location.centroid[0] + longitudeRadius];
  const latitudes = ring ? ring.map(([, latitude]) => latitude) : [location.centroid[1] - latitudeRadius, location.centroid[1] + latitudeRadius];
  const xForLongitude = (longitude: number) => Math.floor(((longitude - minLon) / (maxLon - minLon)) * width);
  const yForLatitude = (latitude: number) => Math.floor(((maxLat - latitude) / (maxLat - minLat)) * height);
  const startX = Math.max(0, Math.min(width - 1, xForLongitude(Math.min(...longitudes))));
  const endX = Math.max(0, Math.min(width - 1, xForLongitude(Math.max(...longitudes))));
  const startY = Math.max(0, Math.min(height - 1, yForLatitude(Math.max(...latitudes))));
  const endY = Math.max(0, Math.min(height - 1, yForLatitude(Math.min(...latitudes))));
  const destination = locationPolygon(location);
  let maximum: number | null = null;

  for (let y = startY; y <= endY; y += 1) {
    const north = maxLat - (y / height) * (maxLat - minLat);
    const south = maxLat - ((y + 1) / height) * (maxLat - minLat);
    for (let x = startX; x <= endX; x += 1) {
      const west = minLon + (x / width) * (maxLon - minLon);
      const east = minLon + ((x + 1) / width) * (maxLon - minLon);
      const cell = polygon([[[west, south], [east, south], [east, north], [west, north], [west, south]]]);
      if (!booleanIntersects(destination, cell)) continue;
      const value = Number(raster[y * width + x]);
      if (Number.isFinite(value) && value >= 0 && value < 500) maximum = maximum === null ? value : Math.max(maximum, value);
    }
  }
  return maximum;
}

export function sampleEffisDestinations(raster: ArrayLike<number>, width: number, height: number, bbox: [number, number, number, number], locations: Location[]) {
  const destinations = locations.filter((location) => outdoorTypes.has(location.type));
  const samples = destinations.flatMap((location) => {
    const fwi = sampleFwi(raster, width, height, bbox, location);
    return fwi === null ? [] : [{ location, fwi }];
  });
  if (destinations.length > 0 && samples.length === 0) throw new Error("EFFIS raster contains no usable destination samples");
  return samples;
}

export class EffisAdapter implements SourceAdapter {
  readonly id = "effis" as const;
  readonly cadence = "slow" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const date = checkedAt.slice(0, 10);
    const bbox: [number, number, number, number] = [-25, 25, 50, 72];
    const width = 1200;
    const height = 752;
    const query = new URLSearchParams({ SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: "mf010.fwi", STYLES: "default", SRS: "EPSG:4326", BBOX: bbox.join(","), WIDTH: String(width), HEIGHT: String(height), FORMAT: "image/tiff", TIME: date });
    try {
      const response = await fetchWithRetry(context.fetch, `https://maps.effis.emergency.copernicus.eu/effis?${query}`, {}, 3, 5 * 1024 * 1024);
      const sourceUpdatedAt = effisSourceTimestamp(date, context.now);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const tiff = await fromArrayBuffer(bytes.slice().buffer as ArrayBuffer);
      const image = await tiff.getImage();
      if (image.getWidth() !== width || image.getHeight() !== height || image.getSamplesPerPixel() !== 1) throw new Error("Unexpected EFFIS raster dimensions");
      const rasters = await image.readRasters();
      const raster = rasters[0];
      const events: NormalizedEvent[] = [];
      const destinations = context.locations.filter((location) => outdoorTypes.has(location.type));
      const samples = sampleEffisDestinations(raster, width, height, bbox, context.locations);
      const checkedLocationIds = samples.map(({ location }) => location.id);
      const unavailableLocationIds = destinations.filter(({ id }) => !checkedLocationIds.includes(id)).map(({ id }) => id);
      for (const { location, fwi } of samples) {
        const level = fwiLevel(fwi);
        if (!level) continue;
        const expiresAt = new Date(context.now.getTime() + 30 * 60 * 60 * 1000).toISOString();
        events.push({
          id: `effis:fwi:${date}:${location.id}`, sourceId: "effis", providerId: "effis-fire-danger", type: "fire-danger", level, timing: "ACTIVE",
          headline: `Very high fire danger affects ${location.name}.`, explanation: `EFFIS reports a Fire Weather Index of ${fwi.toFixed(1)} near ${location.name}. This indicates conditions that can support fast-spreading fires, not a confirmed active wildfire.`,
          action: "Avoid activities that could start a fire and check local access restrictions.", affectedArea: `${location.name} and nearby outdoor areas`,
          geometry: { kind: "locations", ids: [location.id] }, startsAt: checkedAt, endsAt: expiresAt,
          sourceUpdatedAt, checkedAt, expiresAt, sourceName: "EFFIS",
          sourceUrl: "https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation/", confidence: "HIGH",
        });
      }
      recordSourceDiagnostics(context, {
        recordsExamined: samples.length, targetsScheduled: destinations.length,
        targetsCompleted: samples.length, matchedLocations: events.length,
      });
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt, events,
        status: unavailableLocationIds.length ? "partial" : "ok",
        error: unavailableLocationIds.length ? `${unavailableLocationIds.length} EFFIS destinations have no usable sample` : null,
        checkedLocationIds, unavailableLocationIds });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: (error instanceof Error ? error.message : "EFFIS failed").slice(0, 300) });
    }
  }
}
