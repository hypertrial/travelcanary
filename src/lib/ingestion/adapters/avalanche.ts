import type { CatalogLocation as Location } from "../../catalog-data";
import { ExpandedAggregateSourceResultSchema } from "../../domain/catalog-state";
import booleanIntersects from "@turf/boolean-intersects";
import { feature } from "@turf/helpers";
import reportMapping from "../../../../data/avalanche-report-region-mapping.json";
import { AggregateSourceResultSchema, type AggregateSourceResult, type HazardLevel, type NormalizedEvent } from "../../domain/schemas";
import { locationPolygon } from "../../geospatial";
import { fetchAllowlisted, fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type ExpandedIngestionContext as IngestionContext, type SourceAdapter, type ExpandedSourceAdapter } from "../types";

const rating = { no_rating: 0, "no rating": 0, low: 1, moderate: 2, considerable: 3, high: 4, very_high: 5, "very high": 5 } as const;
export function avalancheLevel(value: number): HazardLevel | null { return value >= 5 ? "SEVERE" : value >= 4 ? "HIGH" : value >= 3 ? "ELEVATED" : null; }
function parsedRating(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5) return value;
  const key = String(value).toLowerCase() as keyof typeof rating;
  return Object.hasOwn(rating, key) ? rating[key] : null;
}
function numericRating(value: unknown) { return parsedRating(value) ?? 0; }
type Bulletin = {
  bulletinID?: unknown; publicationTime?: unknown; validTime?: { startTime?: unknown; endTime?: unknown };
  dangerRatings?: Array<{ mainValue?: unknown; dangerLevel?: unknown }>;
  regions?: Array<{ regionID?: unknown }>;
};
type GeoJsonFeature = { properties?: Bulletin; geometry?: { type?: unknown; coordinates?: unknown } };

function maximumRating(bulletin: Bulletin) {
  return Math.max(0, ...(bulletin.dangerRatings || []).map((item) => numericRating(item.mainValue ?? item.dangerLevel)));
}

function eventFor(location: Location, bulletin: Bulletin, danger: number, sourceId: "slf-avalanche" | "euregio-avalanche", context: IngestionContext): NormalizedEvent {
  const starts = Date.parse(String(bulletin.validTime?.startTime || ""));
  const ends = Date.parse(String(bulletin.validTime?.endTime || ""));
  const published = Date.parse(String(bulletin.publicationTime || ""));
  const level = avalancheLevel(danger)!;
  const sourceName = sourceId === "slf-avalanche" ? "SLF" : "Avalanche.report";
  return {
    id: `${sourceId}:${String(bulletin.bulletinID)}:${location.id}`, sourceId, providerId: sourceId, type: "avalanche", level,
    timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE",
    headline: `Avalanche danger level ${danger} applies in ${location.name}.`,
    explanation: "The official bulletin applies to unsecured mountain terrain and does not necessarily describe controlled or open pistes.",
    action: danger >= 4 ? "Avoid unsecured avalanche terrain and follow official closures." : "Check the local bulletin before entering unsecured mountain terrain.",
    affectedArea: location.name, geometry: { kind: "locations", ids: [location.id] },
    startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), sourceUpdatedAt: new Date(published).toISOString(),
    checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(), sourceName,
    sourceUrl: sourceId === "slf-avalanche" ? "https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/" : "https://avalanche.report/",
    confidence: "HIGH",
  };
}

function validBulletin(bulletin: Bulletin) {
  const starts = Date.parse(String(bulletin.validTime?.startTime || ""));
  const ends = Date.parse(String(bulletin.validTime?.endTime || ""));
  const published = Date.parse(String(bulletin.publicationTime || ""));
  return Boolean(String(bulletin.bulletinID || "").trim()) && Number.isFinite(starts) && Number.isFinite(ends)
    && Number.isFinite(published) && ends > starts
    && Array.isArray(bulletin.dangerRatings)
    && bulletin.dangerRatings.some((item) => parsedRating(item.mainValue ?? item.dangerLevel) !== null);
}

function seasonalBulletin(bulletin: Bulletin) {
  const starts = Date.parse(String(bulletin.validTime?.startTime || ""));
  const ends = Date.parse(String(bulletin.validTime?.endTime || ""));
  const published = Date.parse(String(bulletin.publicationTime || ""));
  return Number.isFinite(starts) && Number.isFinite(ends) && Number.isFinite(published) && ends > starts
    && Array.isArray(bulletin.regions) && bulletin.regions.some(({ regionID }) => String(regionID || "").trim())
    && (!Array.isArray(bulletin.dangerRatings) || bulletin.dangerRatings.length === 0);
}

function isCurrentBulletin(bulletin: Bulletin, context: IngestionContext) {
  return Date.parse(String(bulletin.validTime?.endTime || "")) > context.now.getTime();
}

function bestByLocation(events: NormalizedEvent[]) {
  const level = { ELEVATED: 1, HIGH: 2, SEVERE: 3 } as const;
  const best = new Map<string, NormalizedEvent>();
  for (const event of events) {
    const locationId = event.geometry.kind === "locations" ? event.geometry.ids[0] : "";
    const previous = best.get(locationId);
    if (!previous || level[event.level] > level[previous.level]
      || (level[event.level] === level[previous.level] && event.sourceUpdatedAt > previous.sourceUpdatedAt)
      || (level[event.level] === level[previous.level] && event.sourceUpdatedAt === previous.sourceUpdatedAt && event.id < previous.id)) best.set(locationId, event);
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function slfEvents(value: unknown, context: IngestionContext) {
  const features = (value as { features?: unknown })?.features;
  if (!Array.isArray(features)) throw new Error("SLF response has no features array");
  const destinations = context.locations.filter((location) => (location.countryCode === "CH" && ["mountain", "resort", "park"].includes(location.type)) || location.id === "li-malbun").sort((a, b) => a.id.localeCompare(b.id));
  const unavailable = new Set<string>();
  const events: NormalizedEvent[] = [];
  let parseable = 0;
  let invalid = 0;
  for (const raw of features as GeoJsonFeature[]) {
    const bulletin = raw.properties || {};
    if (!validBulletin(bulletin) || !raw.geometry) { invalid += 1; destinations.forEach(({ id }) => unavailable.add(id)); continue; }
    let area;
    try { area = feature(raw.geometry as Parameters<typeof feature>[0]); } catch { invalid += 1; destinations.forEach(({ id }) => unavailable.add(id)); continue; }
    parseable += 1;
    if (!isCurrentBulletin(bulletin, context)) continue;
    const danger = maximumRating(bulletin);
    const level = avalancheLevel(danger);
    if (!level) continue;
    for (const location of destinations) {
      try { if (booleanIntersects(area, locationPolygon(location))) events.push(eventFor(location, bulletin, danger, "slf-avalanche", context)); } catch { unavailable.add(location.id); }
    }
  }
  if (features.length > 0 && parseable === 0) throw new Error("SLF response contains no parseable bulletins");
  const matched = bestByLocation(events);
  recordSourceDiagnostics(context, {
    recordsExamined: features.length, targetsScheduled: destinations.length,
    targetsCompleted: destinations.length - unavailable.size, matchedLocations: matched.length,
  });
  return {
    events: matched, status: invalid ? "partial" as const : "ok" as const,
    error: invalid ? `${invalid} SLF bulletins were invalid` : null,
    checkedLocationIds: destinations.map(({ id }) => id).filter((id) => !unavailable.has(id)), unavailableLocationIds: [...unavailable].sort(),
  };
}

function parseEuregioEvents(value: unknown, context: IngestionContext) {
  const bulletins = (value as { bulletins?: unknown })?.bulletins;
  if (!Array.isArray(bulletins)) throw new Error("Avalanche.report response has no bulletins array");
  const enabledFeedCodes = new Set(reportMapping.partitions.filter(({ enabled }) => enabled).map(({ feedCode }) => feedCode));
  const destinations = reportMapping.mappings.filter((mapping) => mapping.feedCodes.some((feedCode) => enabledFeedCodes.has(feedCode))).flatMap((mapping) => {
    const location = context.locations.find(({ id }) => id === mapping.locationId);
    return location ? [{ location, regionPrefixes: mapping.regionPrefixes }] : [];
  });
  const unavailable = new Set<string>();
  const events: NormalizedEvent[] = [];
  let parseable = 0;
  let invalid = 0;
  for (const bulletin of bulletins as Bulletin[]) {
    if (seasonalBulletin(bulletin)) { parseable += 1; continue; }
    if (!validBulletin(bulletin) || !Array.isArray(bulletin.regions)
      || !bulletin.regions.some(({ regionID }) => String(regionID || "").trim())) {
      invalid += 1; destinations.forEach(({ location }) => unavailable.add(location.id)); continue;
    }
    parseable += 1;
    if (!isCurrentBulletin(bulletin, context)) continue;
    const danger = maximumRating(bulletin);
    if (!avalancheLevel(danger)) continue;
    const bulletinRegions = new Set(bulletin.regions.map(({ regionID }) => String(regionID || "")).filter(Boolean));
    for (const { location, regionPrefixes } of destinations) {
      if ([...bulletinRegions].some((regionId) => regionPrefixes.some((prefix) => regionId.startsWith(prefix)))) events.push(eventFor(location, bulletin, danger, "euregio-avalanche", context));
    }
  }
  if (bulletins.length > 0 && parseable === 0) throw new Error("Avalanche.report response contains no parseable bulletins");
  const matched = bestByLocation(events);
  recordSourceDiagnostics(context, {
    recordsExamined: bulletins.length, targetsScheduled: destinations.length,
    targetsCompleted: destinations.length - unavailable.size, matchedLocations: matched.length,
  });
  return {
    events: matched, status: invalid ? "partial" as const : "ok" as const,
    error: invalid ? `${invalid} Avalanche.report bulletins were invalid` : null,
    checkedLocationIds: destinations.map(({ location }) => location.id).filter((id) => !unavailable.has(id)), unavailableLocationIds: [...unavailable].sort(),
  };
}

export function euregioEvents(value: unknown, context: IngestionContext) {
  return parseEuregioEvents(value, context).events;
}

export class EuregioAvalancheAdapter implements SourceAdapter {
  readonly id = "euregio-avalanche" as const;
  readonly cadence = "slow" as const;
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    try {
      const date = checkedAt.slice(0, 10);
      const byteBudget = { remaining: 9 * 1024 * 1024 };
      const partitions = await Promise.all(reportMapping.partitions.filter(({ enabled }) => enabled).map(async ({ feedCode }) => {
        const url = reportMapping.urlTemplate.replaceAll("{date}", date).replace("{feedCode}", feedCode);
        try {
          const response = await fetchAllowlisted(context.fetch, url, ["static.avalanche.report"], 1, { maxBytes: 512 * 1024, byteBudget, diagnosticsCategory: `eaws_${feedCode}` });
          const text = await response.text();
          const payload = text.trim() ? JSON.parse(text) : { bulletins: [] };
          if (!Array.isArray(payload?.bulletins)) throw new Error("Avalanche.report response has no bulletins array");
          return { feedCode, bulletins: payload.bulletins, failed: false };
        } catch (error) {
          if (String(error).includes("HTTP 404")) return { feedCode, bulletins: [], failed: false };
          return { feedCode, bulletins: [], failed: true };
        }
      }));
      const parsedPartitions = partitions.map((partition) => {
        const locationIds = reportMapping.mappings
          .filter(({ feedCodes }) => feedCodes.includes(partition.feedCode))
          .map(({ locationId }) => locationId);
        if (partition.failed) return { ...partition, locationIds, parsed: null };
        const partitionContext = { ...context, locations: context.locations.filter(({ id }) => locationIds.includes(id)) };
        try {
          const parsed = partition.bulletins.length
            ? parseEuregioEvents({ bulletins: partition.bulletins }, partitionContext)
            : { events: [], status: "ok" as const, error: null, checkedLocationIds: locationIds, unavailableLocationIds: [] };
          return { ...partition, locationIds, parsed };
        } catch {
          return { ...partition, failed: true, locationIds, parsed: null };
        }
      });
      const failed = parsedPartitions.filter(({ failed }) => failed);
      if (failed.length === parsedPartitions.length) throw new Error("All enabled EAWS bulletin partitions failed");
      const unavailable = new Set([
        ...failed.flatMap(({ locationIds }) => locationIds),
        ...parsedPartitions.flatMap(({ parsed }) => parsed?.unavailableLocationIds || []),
      ]);
      const checked = new Set(parsedPartitions.flatMap(({ parsed }) => parsed?.checkedLocationIds || []));
      const events = bestByLocation(parsedPartitions.flatMap(({ parsed }) => parsed?.events || []));
      const parseErrors = [...new Set(parsedPartitions.flatMap(({ parsed }) => parsed?.error || []))];
      const status = failed.length || parseErrors.length ? "partial" : "ok";
      const error = [
        ...parseErrors,
        failed.length ? `${failed.length} EAWS bulletin partitions failed` : null,
      ].filter(Boolean).join("; ") || null;
      const checkedLocationIds = [...checked].filter((id) => !unavailable.has(id)).sort();
      const unavailableLocationIds = [...unavailable].sort();
      recordSourceDiagnostics(context, {
        targetsScheduled: parsedPartitions.length,
        targetsCompleted: parsedPartitions.length - failed.length,
        matchedLocations: events.length,
      });
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt, sourceUpdatedAt: events.map((event) => event.sourceUpdatedAt).sort().at(-1) || checkedAt,
        events, status, error, checkedLocationIds, unavailableLocationIds,
      });
    } catch (error) { return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) }); }
  }
}

export class SlfAvalancheAdapter implements ExpandedSourceAdapter {
  readonly catalogVersion = 3 as const;
  readonly id = "slf-avalanche" as const;
  readonly cadence = "slow" as const;
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    try {
      const response = await fetchWithRetry(context.fetch, "https://aws.slf.ch/api/bulletin/caaml/v4/en/geojson", {}, 3, 2 * 1024 * 1024);
      const parsed = slfEvents(await response.json(), context);
      return ExpandedAggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: parsed.events.map((event) => event.sourceUpdatedAt).sort().at(-1) || checkedAt, ...parsed });
    } catch (error) { return ExpandedAggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) }); }
  }
}
