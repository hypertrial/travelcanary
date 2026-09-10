import type { Feature, GeoJsonProperties, Geometry, MultiPolygon, Point, Polygon } from "geojson";
import { feature } from "@turf/helpers";
import booleanIntersects from "@turf/boolean-intersects";
import { AggregateSourceResultSchema, type AggregateSourceResult, type NormalizedEvent } from "../../domain/schemas";
import { distanceKm, locationPolygon } from "../../geospatial";
import { contextFeedsEnabled } from "../context-feeds";
import { fetchAllowlisted } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const host = "eonet.gsfc.nasa.gov";
const endpoint = `https://${host}/api/v3/events/geojson?status=open&category=volcanoes,wildfires&bbox=-36,72,45,27&days=3&limit=200`;
const maxAgeMs = 72 * 60 * 60_000;

type EonetFeature = Feature<Geometry, GeoJsonProperties & {
  id?: unknown; title?: unknown; date?: unknown; categories?: Array<{ id?: unknown; title?: unknown }>;
}>;

function categoryFor(properties: EonetFeature["properties"]) {
  const values = (properties?.categories || []).flatMap((item) => [String(item.id || "").toLowerCase(), String(item.title || "").toLowerCase()]);
  if (values.some((value) => value === "wildfires" || value === "wildfire")) return { type: "wildfire" as const, radiusKm: 25, name: "Wildfire" };
  if (values.some((value) => value === "volcanoes" || value === "volcano")) return { type: "volcano" as const, radiusKm: 50, name: "Volcanic activity" };
  return null;
}

function polygons(geometry: Polygon | MultiPolygon): Polygon[] {
  return geometry.type === "Polygon"
    ? [geometry]
    : geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
}

function affectedLocationIds(raw: EonetFeature, radiusKm: number, context: IngestionContext) {
  if (raw.geometry.type === "Point") {
    const coordinates = (raw.geometry as Point).coordinates;
    if (coordinates.length < 2 || !coordinates.slice(0, 2).every(Number.isFinite)) return [];
    return context.locations.filter((location) => distanceKm([coordinates[0], coordinates[1]], location.centroid) <= radiusKm + (location.geometry.kind === "radius" ? location.geometry.radiusKm : 0)).map(({ id }) => id);
  }
  if (raw.geometry.type !== "Polygon" && raw.geometry.type !== "MultiPolygon") return [];
  try {
    const areas = polygons(raw.geometry).map((geometry) => feature(geometry));
    return context.locations.filter((location) => areas.some((area) => booleanIntersects(area, locationPolygon(location)))).map(({ id }) => id);
  } catch {
    return [];
  }
}

export function parseEonet(value: unknown, context: IngestionContext) {
  const rawFeatures = (value as { features?: unknown })?.features;
  if (!Array.isArray(rawFeatures)) throw new Error("EONET response has no features array");
  const events: NormalizedEvent[] = [];
  let invalid = 0;
  for (const raw of rawFeatures as EonetFeature[]) {
    const category = categoryFor(raw.properties);
    const updated = Date.parse(String(raw.properties?.date || ""));
    const id = String(raw.properties?.id || raw.id || "").trim();
    if (!category || !id || !raw.geometry || !Number.isFinite(updated) || updated > context.now.getTime() + 5 * 60_000 || context.now.getTime() - updated > maxAgeMs) { invalid += 1; continue; }
    const locationIds = affectedLocationIds(raw, category.radiusKm, context);
    if (!locationIds.length) continue;
    const updatedAt = new Date(updated).toISOString();
    const expiresAt = new Date(updated + maxAgeMs).toISOString();
    const title = String(raw.properties?.title || category.name).trim().slice(0, 140);
    events.push({
      id: `eonet:${id}`, sourceId: "eonet", providerId: "eonet", type: category.type, level: "ELEVATED", timing: "ACTIVE",
      headline: `${category.name} context near ${locationIds.length === 1 ? context.locations.find(({ id: locationId }) => locationId === locationIds[0])?.name || "a destination" : `${locationIds.length} destinations`}.`,
      explanation: `${title} is an open NASA EONET event. This is context only and does not replace local official warnings.`,
      action: "Check local official warnings and access restrictions before travelling nearby.", affectedArea: "Nearby catalog destinations",
      geometry: { kind: "locations", ids: locationIds.sort() }, startsAt: updatedAt, endsAt: expiresAt, sourceUpdatedAt: updatedAt,
      checkedAt: context.now.toISOString(), expiresAt, sourceName: "NASA EONET", sourceUrl: `https://eonet.gsfc.nasa.gov/api/v3/events/${encodeURIComponent(id)}`,
      confidence: "MEDIUM",
    });
  }
  recordSourceDiagnostics(context, { recordsExamined: rawFeatures.length, matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size });
  return { events: events.sort((a, b) => a.id.localeCompare(b.id)), invalid };
}

export class EonetAdapter implements SourceAdapter {
  readonly id = "eonet" as const;
  readonly cadence = "slow" as const;
  constructor(private readonly enabled = contextFeedsEnabled()) {}
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    if (!this.enabled) return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "disabled", limitationCode: "context_feeds_disabled", error: null });
    try {
      const response = await fetchAllowlisted(context.fetch, endpoint, [host], 3, { maxBytes: 2 * 1024 * 1024, diagnosticsCategory: "eonet" });
      const { events, invalid } = parseEonet(await response.json(), context);
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || checkedAt, events, status: invalid ? "partial" : "ok", error: invalid ? `${invalid} invalid or stale EONET records ignored` : null, removedEventPrefixes: invalid ? [] : ["eonet:"] });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) });
    }
  }
}
