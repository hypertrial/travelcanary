import booleanIntersects from "@turf/boolean-intersects";
import { feature } from "@turf/helpers";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { HazardLevel, NormalizedEvent } from "../../domain/schemas";
import { locationPolygon } from "../../geospatial";
import { fetchAllowlisted } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import { capSeverity, countryLocations, limitEvents, type NationalPartition } from "./national-civil-alerts-shared";

const host = "api.hochwasserzentralen.de";
const eventPrefix = "lhp:";
type LhpFeature = { id?: unknown; geometry?: Geometry | null; properties?: Record<string, unknown> };

function lhpLevel(properties: Record<string, unknown>): HazardLevel | null {
  const cap = capSeverity(properties.severity);
  if (cap) return cap;
  switch (Number(properties.lhpClass)) {
    case 2: return "ELEVATED";
    case 4: return "HIGH";
    case 5:
    case 6: return "SEVERE";
    default: return null;
  }
}

function areasFor(geometry: Geometry) {
  if (geometry.type === "Polygon") return [feature(geometry as Polygon)];
  if (geometry.type === "MultiPolygon") return (geometry as MultiPolygon).coordinates.map((coordinates) => feature({ type: "Polygon" as const, coordinates }));
  return [];
}

export function lhpPartition(value: unknown, context: IngestionContext): NationalPartition {
  const response = value as { features?: unknown; updated?: unknown; lastModified?: unknown };
  if (!Array.isArray(response.features)) throw new Error("LHP response has no features array");
  const german = countryLocations(context, "DE");
  const sourceTime = Date.parse(String(response.lastModified || response.updated || ""));
  if (!Number.isFinite(sourceTime) || sourceTime > context.now.getTime() + 5 * 60_000) throw new Error("LHP response has an invalid update time");
  const events: NormalizedEvent[] = [];
  const removed = new Set<string>();
  let invalid = 0;
  for (const raw of response.features as LhpFeature[]) {
    const properties = raw.properties || {};
    const id = String(raw.id || properties.identifier || "").trim();
    if (Number(properties.lhpClass) === 1 || String(properties.msgType || "").toLowerCase() === "cancel") {
      if (id) removed.add(`${eventPrefix}${id}`);
      continue;
    }
    // LHP intentionally mixes alert areas with river/point reference features.
    // Only area geometry can establish destination coverage.
    if (raw.geometry?.type !== "Polygon" && raw.geometry?.type !== "MultiPolygon") continue;
    const level = lhpLevel(properties);
    let areas: ReturnType<typeof areasFor>;
    try { areas = raw.geometry ? areasFor(raw.geometry) : []; } catch { areas = []; }
    if (!id || !level || !areas.length) { invalid += 1; continue; }
    const affected = german.filter((location) => areas.some((area) => {
      try { return booleanIntersects(area, locationPolygon(location)); } catch { return false; }
    }));
    if (!affected.length) continue;
    const starts = Date.parse(String(properties.onset || properties.effective || response.lastModified || response.updated));
    const expires = Date.parse(String(properties.expires || ""));
    if (Number.isFinite(expires) && expires <= context.now.getTime()) {
      removed.add(`${eventPrefix}${id}`);
      continue;
    }
    const startsAt = new Date(Number.isFinite(starts) ? starts : sourceTime).toISOString();
    const endsAt = new Date(Number.isFinite(expires) && expires > sourceTime ? expires : context.now.getTime() + 30 * 60_000).toISOString();
    const locationIds = affected.map(({ id: locationId }) => locationId).sort();
    events.push({
      id: `${eventPrefix}${id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts", type: "flood", level,
      timing: Date.parse(startsAt) > context.now.getTime() ? "UPCOMING" : "ACTIVE",
      headline: String(properties.alertHeadline || properties.headline || "Official flood warning").slice(0, 180),
      explanation: String(properties.description || `The German LHP flood class ${String(properties.lhpClass || "warning")} applies to this area.`).slice(0, 500),
      action: String(properties.instruction || "Avoid flood water and follow instructions from local flood authorities.").slice(0, 300),
      affectedArea: String(properties.areaDesc || "Affected German flood-warning area").slice(0, 200), geometry: { kind: "locations", ids: locationIds },
      startsAt, endsAt, sourceUpdatedAt: new Date(sourceTime).toISOString(), checkedAt: context.now.toISOString(), expiresAt: endsAt,
      sourceName: "Länderübergreifendes Hochwasserportal", sourceUrl: "https://www.hochwasserzentralen.de/", confidence: "HIGH",
    });
  }
  recordSourceDiagnostics(context, { recordsExamined: response.features.length, targetsScheduled: german.length, targetsCompleted: invalid ? 0 : german.length, matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size });
  return {
    status: invalid ? "partial" : "ok", sourceUpdatedAt: new Date(sourceTime).toISOString(), events: limitEvents(events),
    error: invalid ? `${invalid} LHP records were malformed or unsupported` : null,
    checkedLocationIds: invalid ? [] : german.map(({ id }) => id), unavailableLocationIds: invalid ? german.map(({ id }) => id) : [],
    removedEventPrefixes: invalid ? [...removed].sort() : [eventPrefix],
  };
}

export async function fetchDePartition(context: IngestionContext) {
  const url = `https://${host}/public/v1/data/alerts?format=geojson&lang=en`;
  const response = await fetchAllowlisted(context.fetch, url, [host], 3, { maxBytes: 6 * 1024 * 1024, diagnosticsCategory: "lhp" });
  return lhpPartition(await response.json(), context);
}
