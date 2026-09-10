import type { CatalogLocation as Location } from "../../catalog-data";
import { ExpandedAggregateSourceResultSchema as AggregateSourceResultSchema } from "../../domain/catalog-state";
import { XMLParser } from "fast-xml-parser";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon } from "@turf/helpers";
import { type AggregateSourceResult, type HazardLevel, type NormalizedEvent } from "../../domain/schemas";
import { distanceKm, eventAffectsLocation, locationPolygon } from "../../geospatial";
import { fetchAllowlisted, fetchWithRetry, mapConcurrent } from "../fetch";
import { recordSourceDiagnostics, type ExpandedIngestionContext as IngestionContext, type ExpandedSourceAdapter } from "../types";

export const usgsDetailHosts = ["earthquake.usgs.gov", "www.earthquake.usgs.gov"] as const;

type UsgsFeature = {
  id: string;
  geometry: { coordinates: [number, number, number] };
  properties: { mag: number; time: number; updated: number; detail: string; status: string; place: string; ids?: string; types?: string };
};
type XmlNode = Record<string, unknown>;
type ShakeMapProduct = { preferredWeight?: number; contents?: Record<string, { url?: string }> };
type UsgsDetail = { properties?: { products?: { shakemap?: ShakeMapProduct[] } } };

type Grid = { lonMin: number; latMin: number; lonSpacing: number; latSpacing: number; nlon: number; nlat: number; mmiIndex: number; rows: number[][] };
const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const MAX_SUMMARY_AGE_MS = 30 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function summaryFeature(value: unknown): UsgsFeature | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> };
  const coordinates = raw.geometry?.coordinates;
  const properties = raw.properties;
  if (!Array.isArray(coordinates) || !properties) return null;
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  const depth = Number(coordinates[2] ?? 0);
  const mag = Number(properties.mag);
  const time = Number(properties.time);
  const updated = Number(properties.updated);
  const id = typeof raw.id === "string" ? raw.id : "";
  const detail = typeof properties.detail === "string" ? properties.detail : "";
  const status = typeof properties.status === "string" ? properties.status : "";
  if (!id || !detail || !status || !Number.isFinite(mag) || !Number.isFinite(time) || !Number.isFinite(updated)
    || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(depth)) return null;
  return {
    id, geometry: { coordinates: [longitude, latitude, depth] },
    properties: {
      mag, time, updated, detail, status, place: typeof properties.place === "string" ? properties.place : "Earthquake area",
      ids: typeof properties.ids === "string" ? properties.ids : undefined,
      types: typeof properties.types === "string" ? properties.types : undefined,
    },
  };
}

export function parseShakeMapGrid(xml: string): Grid {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const root = parsed.shakemap_grid as XmlNode | undefined;
  const spec = root?.grid_specification as XmlNode | undefined;
  const fields = array(root?.grid_field as XmlNode | XmlNode[] | undefined);
  const mmiField = fields.find((field) => String(field["@_name"]).toUpperCase() === "MMI");
  if (!spec || !mmiField || typeof root?.grid_data !== "string") throw new Error("ShakeMap grid is incomplete");
  const rows = root.grid_data.trim().split(/\n+/).map((line: string) => line.trim().split(/\s+/).map(Number)).filter((row: number[]) => row.every(Number.isFinite));
  return {
    lonMin: Number(spec["@_lon_min"]), latMin: Number(spec["@_lat_min"]), lonSpacing: Number(spec["@_nominal_lon_spacing"]),
    latSpacing: Number(spec["@_nominal_lat_spacing"]), nlon: Number(spec["@_nlon"]), nlat: Number(spec["@_nlat"]),
    mmiIndex: Number(mmiField["@_index"]) - 1, rows,
  };
}

function locationBounds(location: Location): [number, number, number, number] {
  if (location.geometry.kind === "polygon") {
    const coordinates = location.geometry.coordinates.flat();
    return [
      Math.min(...coordinates.map(([lon]) => lon)), Math.min(...coordinates.map(([, lat]) => lat)),
      Math.max(...coordinates.map(([lon]) => lon)), Math.max(...coordinates.map(([, lat]) => lat)),
    ];
  }
  const [lon, lat] = location.centroid;
  const latDelta = location.geometry.radiusKm / 110.574;
  const lonDelta = location.geometry.radiusKm / (111.32 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  return [lon - lonDelta, lat - latDelta, lon + lonDelta, lat + latDelta];
}

export function mmiAtLocation(grid: Grid, location: Location): number | null {
  const destination = locationPolygon(location);
  const [minLon, minLat, maxLon, maxLat] = locationBounds(location);
  const halfLon = Math.abs(grid.lonSpacing) / 2;
  const halfLat = Math.abs(grid.latSpacing) / 2;
  let maximum: number | null = null;
  for (const row of grid.rows) {
    const [lon, lat] = row;
    const mmi = row[grid.mmiIndex];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(mmi)) continue;
    if (lon + halfLon < minLon || lon - halfLon > maxLon || lat + halfLat < minLat || lat - halfLat > maxLat) continue;
    const cell = polygon([[[lon - halfLon, lat - halfLat], [lon + halfLon, lat - halfLat], [lon + halfLon, lat + halfLat], [lon - halfLon, lat + halfLat], [lon - halfLon, lat - halfLat]]]);
    if (booleanIntersects(destination, cell)) maximum = maximum === null ? mmi : Math.max(maximum, mmi);
  }
  return maximum;
}

export function mmiLevel(mmi: number): HazardLevel | null {
  if (mmi >= 8) return "SEVERE";
  if (mmi >= 6) return "HIGH";
  if (mmi >= 4) return "ELEVATED";
  return null;
}

export function earthquakeExpiresAt(feature: UsgsFeature, reviewed: boolean): string {
  const preliminaryExpiry = feature.properties.time + 6 * 60 * 60 * 1000;
  const reviewedExpiry = feature.properties.updated + 6 * 60 * 60 * 1000;
  return new Date(reviewed ? Math.max(preliminaryExpiry, reviewedExpiry) : preliminaryExpiry).toISOString();
}

function eventForLocation(feature: UsgsFeature, location: Location, level: HazardLevel, checkedAt: Date, mmi?: number): NormalizedEvent {
  const startsAt = new Date(feature.properties.time).toISOString();
  const expiresAt = earthquakeExpiresAt(feature, mmi !== undefined);
  return {
    id: `usgs:${feature.id}:${location.id}`, sourceId: "usgs", providerId: "usgs", type: "earthquake", level, timing: "ACTIVE",
    headline: `Earthquake shaking was reported near ${location.name}.`,
    explanation: mmi ? `USGS ShakeMap estimates local intensity MMI ${mmi.toFixed(1)} near ${location.name}.` : `A magnitude ${feature.properties.mag.toFixed(1)} earthquake occurred ${Math.round(distanceKm([feature.geometry.coordinates[0], feature.geometry.coordinates[1]], location.centroid))} km from ${location.name}. Impact information is preliminary.`,
    action: "Expect possible aftershocks and follow local emergency instructions.", affectedArea: `${location.name} and nearby areas`,
    geometry: { kind: "locations", ids: [location.id] }, startsAt, endsAt: expiresAt,
    earthquake: {
      ids: [...new Set([feature.id, ...(feature.properties.ids || "").split(",").filter(Boolean)])],
      coordinates: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]],
      magnitude: feature.properties.mag,
    },
    sourceUpdatedAt: new Date(feature.properties.updated).toISOString(), checkedAt: checkedAt.toISOString(), expiresAt,
    sourceName: "USGS", sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${feature.id}`, confidence: mmi ? "HIGH" : "MEDIUM",
  };
}

export class UsgsAdapter implements ExpandedSourceAdapter {
  readonly catalogVersion = 3 as const;
  readonly id = "usgs" as const;
  readonly cadence = "fast" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    try {
      const response = await fetchWithRetry(context.fetch, "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson");
      const payload = await response.json() as { metadata?: { generated?: number }; features?: unknown[] };
      const generated = typeof payload.metadata?.generated === "number" ? payload.metadata.generated : Number.NaN;
      if (!Array.isArray(payload.features) || !Number.isFinite(generated)) throw new Error("USGS response is not a valid feature collection");
      if (generated > context.now.getTime() + MAX_FUTURE_SKEW_MS || context.now.getTime() - generated > MAX_SUMMARY_AGE_MS) {
        throw new Error("USGS summary update time is stale or future-dated");
      }
      let invalid = 0;
      let parseable = 0;
      const removedEventPrefixes: string[] = [];
      const unavailableEventIds: string[] = [];
      let unavailableProducts = 0;
      const unavailableLocations = new Set<string>();
      const candidates = payload.features.flatMap((raw) => {
        const feature = summaryFeature(raw);
        if (!feature) { invalid += 1; return []; }
        parseable += 1;
        if (feature.properties.status === "deleted") {
          removedEventPrefixes.push(`usgs:${feature.id}:`);
          return [];
        }
        const nearby = context.locations.filter((location) => {
          const radiusKm = feature.properties.mag >= 5.5 ? 250 : 100;
          return feature.properties.mag >= 4.5 && eventAffectsLocation({
            id: feature.id, sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
            headline: "Earthquake candidate", explanation: "Earthquake candidate for location matching.", action: "Follow local advice.",
            affectedArea: feature.properties.place || "Earthquake area", geometry: { kind: "point", coordinates: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]], radiusKm },
            startsAt: new Date(feature.properties.time).toISOString(), endsAt: new Date(feature.properties.time + 6 * 60 * 60 * 1000).toISOString(),
            sourceUpdatedAt: new Date(feature.properties.updated).toISOString(), checkedAt, expiresAt: new Date(feature.properties.time + 6 * 60 * 60 * 1000).toISOString(),
            sourceName: "USGS", sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${feature.id}`, confidence: "MEDIUM",
          }, location);
        });
        return nearby.length ? [{ feature, nearby }] : [];
      });
      if (payload.features.length > 0 && parseable === 0) throw new Error("USGS response contains no parseable records");
      const eventGroups = await mapConcurrent(candidates, 3, async ({ feature, nearby }) => {
        const events: NormalizedEvent[] = [];
        let grid: Grid | null = null;
        let impactUnavailable = false;
        try {
          const detail = await (await fetchAllowlisted(context.fetch, feature.properties.detail, usgsDetailHosts)).json() as UsgsDetail;
          const products = detail?.properties?.products?.shakemap;
          const preferred = Array.isArray(products) ? products.sort((a, b) => Number(b.preferredWeight || 0) - Number(a.preferredWeight || 0))[0] : null;
          const gridUrl = preferred?.contents?.["download/grid.xml"]?.url;
          if (gridUrl) grid = parseShakeMapGrid(await (await fetchAllowlisted(context.fetch, gridUrl, usgsDetailHosts)).text());
        } catch {
          grid = null;
          impactUnavailable = true;
          unavailableProducts += 1;
        }
        if (!impactUnavailable) removedEventPrefixes.push(`usgs:${feature.id}:`);
        for (const location of nearby) {
          if (impactUnavailable) { unavailableEventIds.push(`usgs:${feature.id}:${location.id}`); unavailableLocations.add(location.id); }
          const mmi = grid ? mmiAtLocation(grid, location) : null;
          const level = mmi === null ? "ELEVATED" : mmiLevel(mmi);
          if (level) events.push(eventForLocation(feature, location, level, context.now, mmi ?? undefined));
        }
        return events;
      });
      const events = eventGroups.flat();
      recordSourceDiagnostics(context, {
        recordsExamined: payload.features.length, targetsScheduled: candidates.length, targetsCompleted: eventGroups.length,
        matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size,
      });
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt, sourceUpdatedAt: new Date(generated).toISOString(),
        events, removedEventPrefixes, unavailableEventIds,
        checkedLocationIds: invalid ? [] : context.locations.map(({ id }) => id).filter((id) => !unavailableLocations.has(id)),
        unavailableLocationIds: invalid ? context.locations.map(({ id }) => id) : [...unavailableLocations].sort(),
        status: invalid || unavailableProducts ? "partial" : "ok",
        error: [invalid ? `${invalid} USGS records were invalid` : null,
          unavailableProducts ? `${unavailableProducts} USGS impact products unavailable` : null].filter(Boolean).join("; ") || null,
      });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: (error instanceof Error ? error.message : "USGS failed").slice(0, 300) });
    }
  }
}
