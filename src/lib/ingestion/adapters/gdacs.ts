import booleanIntersects from "@turf/boolean-intersects";
import { multiPolygon, polygon } from "@turf/helpers";
import { AggregateSourceResultSchema, DiscoveryGeometrySchema, type AggregateSourceResult, type DiscoveryCandidate } from "../../domain/schemas";
import { fetchAllowlisted, readJsonWithLimit } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";
import type { Location } from "../../domain/schemas";
import { distanceKm, locationPolygon } from "../../geospatial";

type Feature = { properties?: { eventtype?: string; eventid?: number | string; episodeid?: number | string; iscurrent?: string | boolean; alertscore?: number; fromdate?: string; todate?: string; datemodified?: string; url?: string | { report?: string } }; geometry?: { type?: string; coordinates?: unknown } };
const types = { EQ: "earthquake", FL: "flood", WF: "wildfire", TC: "coastal" } as const;
function gdacsTime(value: string | undefined) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
}

function polygonAffectsCatalog(
  geometry: Extract<DiscoveryCandidate["geometry"], { type: "Polygon" | "MultiPolygon" }>,
  locations: Location[],
) {
  try {
    const feature = geometry.type === "Polygon" ? polygon(geometry.coordinates) : multiPolygon(geometry.coordinates);
    return locations.some((location) => booleanIntersects(feature, locationPolygon(location)));
  } catch {
    return false;
  }
}

export function parseGdacsCandidates(value: unknown, now: Date, locations: Location[] = [], limit = 200, stats?: { supported?: number; parseable: number; invalid?: number }): DiscoveryCandidate[] {
  const features = (value as { features?: Feature[] })?.features || [];
  const ranked = features.flatMap((feature) => {
    const p = feature.properties || {}; const hazardType = types[p.eventtype as keyof typeof types];
    if (!hazardType) {
      if (p.eventtype === "DR" || p.eventtype === "VO") return [];
      if (stats) stats.invalid = (stats.invalid || 0) + 1;
      return [];
    }
    if (stats) stats.supported = (stats.supported || 0) + 1;
    const starts = gdacsTime(p.fromdate), updated = gdacsTime(p.datemodified), end = gdacsTime(p.todate);
    const geometry = DiscoveryGeometrySchema.safeParse(feature.geometry);
    if (!p.eventid || !geometry.success || !Number.isFinite(starts) || !Number.isFinite(updated)
      || updated > now.getTime() + 5 * 60_000) {
      if (stats) stats.invalid = (stats.invalid || 0) + 1;
      return [];
    }
    if (Number.isFinite(end) && end < starts) {
      if (stats) stats.invalid = (stats.invalid || 0) + 1;
      return [];
    }
    const ends = Number.isFinite(end) && end > starts ? end : starts + 24 * 60 * 60_000;
    const expires = Math.min(ends, updated + 24 * 60 * 60_000);
    if (expires <= starts) {
      if (stats) stats.invalid = (stats.invalid || 0) + 1;
      return [];
    }
    if (stats) stats.parseable += 1;
    if (now.getTime() - updated > 48 * 60 * 60_000 || expires <= now.getTime()) return [];
    let proximity = Number.POSITIVE_INFINITY;
    if (locations.length) {
      if (geometry.data.type === "Point") {
        const point = geometry.data.coordinates;
        proximity = Math.min(...locations.map((location) => distanceKm(point, location.centroid)));
        if (proximity > 500) return [];
      } else {
        if (!polygonAffectsCatalog(geometry.data, locations)) return [];
        proximity = 0;
      }
    }
    const officialUrl = typeof p.url === "object" ? p.url.report : p.url;
    return [{ candidate: { providerId: "gdacs" as const, externalId: `${p.eventtype}:${p.eventid}:${p.episodeid || 0}`, hazardType, geometry: geometry.data, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), sourceUpdatedAt: new Date(updated).toISOString(), officialUrl: officialUrl || "https://www.gdacs.org/", expiresAt: new Date(expires).toISOString() }, current: p.iscurrent === true || p.iscurrent === "true", alert: Number(p.alertscore || 0), proximity }];
  });
  return ranked.sort((a, b) => Number(b.current) - Number(a.current) || b.alert - a.alert
    || Date.parse(b.candidate.sourceUpdatedAt) - Date.parse(a.candidate.sourceUpdatedAt) || a.proximity - b.proximity)
    .slice(0, limit).map(({ candidate }) => candidate);
}

export class GdacsAdapter implements SourceAdapter {
  readonly id = "gdacs" as const; readonly cadence = "slow" as const;
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    try {
      const response = await fetchAllowlisted(context.fetch, "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/search", ["www.gdacs.org"], 1, {
        maxBytes: 2 * 1024 * 1024, timeoutMs: 4_000, diagnosticsCategory: "gdacs_discovery",
      });
      const payload = await readJsonWithLimit(response, 2 * 1024 * 1024);
      if (!Array.isArray((payload as { features?: unknown })?.features)) throw new Error("GDACS response has no features array");
      const stats = { supported: 0, parseable: 0, invalid: 0 };
      const parsed = parseGdacsCandidates(payload, context.now, context.locations, 201, stats);
      if ((stats.supported > 0 || stats.invalid > 0) && stats.parseable === 0) throw new Error("GDACS response contains no parseable records");
      const overflow = parsed.length > 200;
      const candidates = parsed.slice(0, 200);
      recordSourceDiagnostics(context, { recordsExamined: (payload as { features: unknown[] }).features.length });
      const sourceUpdatedAt = candidates.map((candidate) => candidate.sourceUpdatedAt).sort().at(-1) || null;
      const partial = overflow || stats.invalid > 0;
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt, sourceUpdatedAt, events: [], candidates,
        status: partial ? "partial" : "ok",
        error: [overflow ? "GDACS candidate limit reached" : null, stats.invalid ? `${stats.invalid} GDACS records were invalid` : null].filter(Boolean).join("; ") || null,
      });
    } catch (error) { return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) }); }
  }
}
