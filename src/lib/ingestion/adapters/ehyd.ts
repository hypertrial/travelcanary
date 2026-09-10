import mapping from "../../../../data/ehyd-station-mapping.json";
import { AggregateSourceResultSchema, type AggregateSourceResult, type HazardLevel, type NormalizedEvent } from "../../domain/schemas";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

export const EHYD_ITEMS_URL = "https://gis.lfrz.gv.at/api/geodata/i000501/ogc/features/v1/collections/i000501:pegel_aktuell/items?f=application/geo%2Bjson&limit=500";
const levelByStage: Record<number, HazardLevel> = { 4: "ELEVATED", 5: "HIGH", 6: "SEVERE" };
const stageLabels: Record<number, string> = {
  4: "flood stage 1",
  5: "flood stage 2",
  6: "flood stage 3",
};

type StationWarning = { stationId: string; name: string; waterway: string; stage: number; updatedAt: string };

export function ehydExpiresAt(now: Date) {
  return new Date(now.getTime() + 90 * 60_000).toISOString();
}

export function parseGesamtcode(value: unknown): { stage: number; trend: number; stale: boolean } | null {
  const code = Number(value);
  if (!Number.isInteger(code) || code < 100 || code > 999) return null;
  const stage = Math.floor(code / 100);
  const trend = Math.floor(code / 10) % 10;
  const freshness = code % 10;
  if (![1, 2, 3, 4, 5, 6, 9].includes(stage) || trend > 3 || freshness > 1) return null;
  return { stage, trend, stale: freshness === 1 };
}

function features(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { features?: unknown }).features)) {
    throw new Error("eHYD response is not a GeoJSON FeatureCollection");
  }
  return (value as { features: Array<Record<string, unknown>> }).features;
}

export function ehydEvents(value: unknown, context: IngestionContext) {
  const records = features(value);
  const byStation = new Map<string, StationWarning>();
  const unavailable = new Set<string>();
  let parseable = 0;
  let invalid = 0;
  for (const feature of records.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const properties = feature.properties && typeof feature.properties === "object"
      ? feature.properties as Record<string, unknown>
      : {};
    const stationId = String(properties.hzbnr || "").trim();
    const decoded = parseGesamtcode(properties.gesamtcode);
    const timestamp = Date.parse(String(properties.zeitpunkt || ""));
    if (decoded && (decoded.stage === 9 || decoded.stale || !levelByStage[decoded.stage])) {
      parseable += 1;
      continue;
    }
    if (!stationId || !decoded || !Number.isFinite(timestamp)) {
      invalid += 1;
      const affected = stationId
        ? mapping.mappings.filter(({ stationIds }) => stationIds.includes(stationId))
        : mapping.mappings;
      affected.forEach(({ locationId }) => unavailable.add(locationId));
      continue;
    }
    parseable += 1;
    const candidate: StationWarning = {
      stationId,
      name: String(properties.messstelle || stationId).trim(),
      waterway: String(properties.gewaesser || "this river").trim(),
      stage: decoded.stage,
      updatedAt: new Date(timestamp).toISOString(),
    };
    const previous = byStation.get(stationId);
    if (!previous || candidate.stage > previous.stage || (candidate.stage === previous.stage && candidate.updatedAt > previous.updatedAt)) {
      byStation.set(stationId, candidate);
    }
  }
  const expiresAt = ehydExpiresAt(context.now);
  const events: NormalizedEvent[] = [];
  for (const destination of [...mapping.mappings].sort((a, b) => a.locationId.localeCompare(b.locationId))) {
    const warnings = destination.stationIds.flatMap((stationId) => byStation.has(stationId) ? [byStation.get(stationId)!] : []);
    const warning = warnings.sort((a, b) => b.stage - a.stage || b.updatedAt.localeCompare(a.updatedAt) || a.stationId.localeCompare(b.stationId))[0];
    if (!warning) continue;
    const location = context.locations.find((candidate) => candidate.id === destination.locationId);
    if (!location) continue;
    events.push({
      id: `ehyd:${warning.stationId}:${location.id}`, sourceId: "ehyd-flood", providerId: "ehyd-flood", type: "flood",
      level: levelByStage[warning.stage], timing: "ACTIVE",
      headline: `${warning.waterway} at ${warning.name} is at official ${stageLabels[warning.stage]}.`,
      explanation: `Hydrographie Österreich reports an official eHYD flood-warning stage for a station intersecting ${location.name}.`,
      action: warning.stage >= 5 ? "Avoid affected riverbanks and follow local authority instructions." : "Monitor official updates and use caution near rivers.",
      affectedArea: `${location.name} and the ${warning.waterway} at ${warning.name}`,
      geometry: { kind: "locations", ids: [location.id] },
      startsAt: warning.updatedAt, endsAt: expiresAt, sourceUpdatedAt: warning.updatedAt, checkedAt: context.now.toISOString(), expiresAt,
      sourceName: "eHYD", sourceUrl: "https://ehyd.gv.at/", confidence: "HIGH",
    });
  }
  return { records, parseable, invalid, events, unavailableLocationIds: [...unavailable].sort() };
}

export class EhydFloodAdapter implements SourceAdapter {
  readonly id = "ehyd-flood" as const;
  readonly cadence = "slow" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const checkedLocationIds = mapping.mappings.map(({ locationId }) => locationId).sort();
    try {
      const response = await fetchWithRetry(context.fetch, EHYD_ITEMS_URL, {}, 3, 1024 * 1024);
      const parsed = ehydEvents(await response.json(), context);
      if (parsed.records.length > 0 && parsed.parseable === 0) throw new Error("eHYD feed contains no parseable station records");
      const unavailable = new Set(parsed.unavailableLocationIds);
      const events = parsed.events.filter((event) => event.geometry.kind !== "locations"
        || event.geometry.ids.every((id) => !unavailable.has(id)));
      recordSourceDiagnostics(context, {
        recordsExamined: parsed.records.length, targetsScheduled: checkedLocationIds.length,
        targetsCompleted: checkedLocationIds.length - unavailable.size,
        matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size,
      });
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt,
        sourceUpdatedAt: parsed.events.map((event) => event.sourceUpdatedAt).sort().at(-1) || checkedAt,
        events, status: parsed.invalid ? "partial" : "ok",
        error: parsed.invalid ? `${parsed.invalid} eHYD records were invalid` : null,
        checkedLocationIds: checkedLocationIds.filter((id) => !unavailable.has(id)), unavailableLocationIds: parsed.unavailableLocationIds,
      });
    } catch (error) {
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300),
      });
    }
  }
}
