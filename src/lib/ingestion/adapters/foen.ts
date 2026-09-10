import { fromArrayBuffer } from "geotiff";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon } from "@turf/helpers";
import { AggregateSourceResultSchema, type AggregateSourceResult, type HazardLevel, type Location, type NormalizedEvent } from "../../domain/schemas";
import { locationPolygon } from "../../geospatial";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const bbox: [number, number, number, number] = [5.9, 45.8, 10.6, 47.9];
const width = 512;
const height = 256;
const palette = new Map([
  ["255,255,0", 2], ["255,255,170", 2],
  ["255,153,0", 3], ["255,194,102", 3],
  ["255,0,0", 4], ["255,102,102", 4],
  ["128,0,0", 5], ["204,41,41", 5],
]);
const knownPalette = new Set([...palette.keys(), "204,255,102", "229,255,179"]);

export function foenLevel(value: number): HazardLevel | null {
  return value >= 4 ? "SEVERE" : value === 3 ? "HIGH" : value === 2 ? "ELEVATED" : null;
}

export function foenExpiresAt(now: Date) { return new Date(now.getTime() + 90 * 60_000).toISOString(); }

export function sampleFoen(rasters: ArrayLike<number>[], location: Location): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const ring = location.geometry.kind === "polygon" ? location.geometry.coordinates[0] : null;
  const lonRadius = location.geometry.kind === "radius" ? location.geometry.radiusKm / (111.32 * Math.max(0.1, Math.cos(location.centroid[1] * Math.PI / 180))) : 0;
  const latRadius = location.geometry.kind === "radius" ? location.geometry.radiusKm / 110.574 : 0;
  const longitudes = ring ? ring.map(([longitude]) => longitude) : [location.centroid[0] - lonRadius, location.centroid[0] + lonRadius];
  const latitudes = ring ? ring.map(([, latitude]) => latitude) : [location.centroid[1] - latRadius, location.centroid[1] + latRadius];
  const x = (longitude: number) => Math.floor((longitude - minLon) / (maxLon - minLon) * width);
  const y = (latitude: number) => Math.floor((maxLat - latitude) / (maxLat - minLat) * height);
  const startX = Math.max(0, Math.min(width - 1, x(Math.min(...longitudes))));
  const endX = Math.max(0, Math.min(width - 1, x(Math.max(...longitudes))));
  const startY = Math.max(0, Math.min(height - 1, y(Math.max(...latitudes))));
  const endY = Math.max(0, Math.min(height - 1, y(Math.min(...latitudes))));
  const destination = locationPolygon(location);
  let maximum = 0;
  for (let row = startY; row <= endY; row += 1) {
    const north = maxLat - row / height * (maxLat - minLat);
    const south = maxLat - (row + 1) / height * (maxLat - minLat);
    for (let column = startX; column <= endX; column += 1) {
      const west = minLon + column / width * (maxLon - minLon);
      const east = minLon + (column + 1) / width * (maxLon - minLon);
      if (!booleanIntersects(destination, polygon([[[west, south], [east, south], [east, north], [west, north], [west, south]]]))) continue;
      const index = row * width + column;
      maximum = Math.max(maximum, palette.get(`${rasters[0][index]},${rasters[1][index]},${rasters[2][index]}`) || 0);
    }
  }
  return maximum;
}

export class FoenFloodAdapter implements SourceAdapter {
  readonly id = "foen-flood" as const;
  readonly cadence = "slow" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const destinations = context.locations.filter((location) => location.countryCode === "CH").sort((a, b) => a.id.localeCompare(b.id));
    const checkedLocationIds = destinations.map(({ id }) => id);
    const query = new URLSearchParams({
      SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: "ch.bafu.hydroweb-warnkarte_national",
      STYLES: "default", SRS: "EPSG:4326", BBOX: bbox.join(","), WIDTH: String(width), HEIGHT: String(height), FORMAT: "image/tiff",
    });
    try {
      const response = await fetchWithRetry(context.fetch, `https://wms.geo.admin.ch/?${query}`, {}, 3, 1024 * 1024);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const tiff = await fromArrayBuffer(bytes.slice().buffer as ArrayBuffer);
      const image = await tiff.getImage();
      if (image.getWidth() !== width || image.getHeight() !== height || image.getSamplesPerPixel() < 3) throw new Error("Unexpected FOEN raster dimensions");
      const raw = await image.readRasters();
      const rasters = [raw[0], raw[1], raw[2]] as ArrayLike<number>[];
      let paletteValidated = false;
      for (let index = 0; index < width * height; index += 1) {
        if (knownPalette.has(`${rasters[0][index]},${rasters[1][index]},${rasters[2][index]}`)) { paletteValidated = true; break; }
      }
      if (!paletteValidated) throw new Error("FOEN raster contains no recognized palette colors");
      const expiresAt = foenExpiresAt(context.now);
      const events: NormalizedEvent[] = destinations.flatMap((location) => {
        const warning = sampleFoen(rasters, location);
        const level = foenLevel(warning);
        if (!level) return [];
        return [{
          id: `foen-flood:${checkedAt.slice(0, 13)}:${location.id}`, sourceId: "foen-flood" as const, providerId: "foen-flood" as const,
          type: "flood" as const, level, timing: "ACTIVE" as const,
          headline: `FOEN flood warning level ${warning} affects ${location.name}.`,
          explanation: `The official Swiss national flood warning map contains level ${warning} warning pixels within ${location.name}.`,
          action: warning >= 3 ? "Avoid affected waterways and follow local authority instructions." : "Monitor official updates and use caution near waterways.",
          affectedArea: location.name, geometry: { kind: "locations" as const, ids: [location.id] }, startsAt: checkedAt, endsAt: expiresAt,
          sourceUpdatedAt: checkedAt, checkedAt, expiresAt, sourceName: "FOEN", sourceUrl: "https://www.hydrodaten.admin.ch/", confidence: "HIGH" as const,
        }];
      });
      recordSourceDiagnostics(context, {
        recordsExamined: destinations.length, targetsScheduled: destinations.length,
        targetsCompleted: destinations.length, matchedLocations: events.length,
      });
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: checkedAt, events, status: "ok", error: null, checkedLocationIds, unavailableLocationIds: [] });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) });
    }
  }
}
