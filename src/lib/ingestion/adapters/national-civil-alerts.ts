import booleanIntersects from "@turf/boolean-intersects";
import { multiPolygon, polygon } from "@turf/helpers";
import { PartitionedSourceResultSchema, countryCodes, type NormalizedEvent, type PartitionedSourceResult } from "../../domain/schemas";
import { locationPolygon } from "../../geospatial";
import { activeNationalSystems, nationalWarningSources } from "../../national-warning-sources";
import { fetchWithRetry, isAllowlistedHttpsUrl, mapConcurrent, withFetchByteBudget } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";
import { fetchAtPartition } from "./national-civil-alerts-at";
import { fetchFrPartition } from "./national-civil-alerts-fr";
import { fetchLuPartition } from "./national-civil-alerts-lu";
import { partitionFailure, type NationalPartition } from "./national-civil-alerts-shared";
import { fetchDePartition } from "./national-civil-alerts-de";
import { fetchEsPartition } from "./national-civil-alerts-es";
import { fetchPlPartition } from "./national-civil-alerts-pl";
import { fetchCzPartition } from "./national-civil-alerts-cz";
import { fetchItPartition } from "./national-civil-alerts-it";
import { fetchLvPartition } from "./national-civil-alerts-lv";

type Vma = {
  Identifier?: unknown; Updated?: unknown; Published?: unknown; Headline?: unknown; Preamble?: unknown;
  PushMessage?: unknown; Area?: Array<{ GeometryInformation?: { Geometry?: unknown } }>;
  GeometryInformation?: { Geometry?: unknown }; Web?: unknown; IsTest?: unknown;
};

function geometryFeature(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const geometry = parsed as { type?: unknown; coordinates?: unknown };
  if (geometry.type === "Polygon") return polygon(geometry.coordinates as Parameters<typeof polygon>[0]);
  if (geometry.type === "MultiPolygon") return multiPolygon(geometry.coordinates as Parameters<typeof multiPolygon>[0]);
  throw new Error("Unsupported VMA geometry");
}

export function krisinformationPartition(value: unknown, context: IngestionContext) {
  if (!Array.isArray(value)) throw new Error("Krisinformation response is not an array");
  const swedish = context.locations.filter((location) => location.countryCode === "SE").sort((a, b) => a.id.localeCompare(b.id));
  const records = (value as Vma[]).slice().sort((a, b) => String(a.Identifier).localeCompare(String(b.Identifier)));
  const limited = records.slice(0, 50);
  const unavailable = new Set<string>(records.length > 50 ? swedish.map(({ id }) => id) : []);
  const byLocation = new Map<string, NormalizedEvent[]>();
  let parseable = 0;
  let invalid = 0;
  for (const record of limited) {
    if (record.IsTest === true) { parseable += 1; continue; }
    let areas;
    try {
      const geometries = (record.Area || []).map((item) => item.GeometryInformation?.Geometry).filter(Boolean);
      if (!geometries.length && record.GeometryInformation?.Geometry) geometries.push(record.GeometryInformation.Geometry);
      if (!geometries.length) throw new Error("VMA has no geometry");
      areas = geometries.map(geometryFeature);
    } catch { invalid += 1; swedish.forEach(({ id }) => unavailable.add(id)); continue; }
    const id = String(record.Identifier || "").trim();
    const updated = Date.parse(String(record.Updated || record.Published || ""));
    const published = Date.parse(String(record.Published || record.Updated || ""));
    const headline = String(record.Headline || record.PushMessage || "").trim();
    const affected = swedish.filter((location) => {
      try { return areas.some((area) => booleanIntersects(area, locationPolygon(location))); } catch { return false; }
    });
    if (!id || !Number.isFinite(updated) || !Number.isFinite(published) || headline.length < 3) {
      invalid += 1; affected.forEach(({ id: locationId }) => unavailable.add(locationId)); continue;
    }
    parseable += 1;
    const expiresAt = new Date(context.now.getTime() + 30 * 60_000).toISOString();
    for (const location of affected) {
      const event: NormalizedEvent = {
        id: `krisinformation:${id}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
        type: "civil-emergency", level: "ELEVATED", timing: published > context.now.getTime() ? "UPCOMING" : "ACTIVE",
        headline: headline.slice(0, 180),
        explanation: String(record.Preamble || record.PushMessage || "An active Important Public Announcement applies to this area.").slice(0, 500),
        action: "Follow instructions from Swedish authorities and monitor Krisinformation for updates.", affectedArea: location.name,
        geometry: { kind: "locations", ids: [location.id] }, startsAt: new Date(published).toISOString(), endsAt: expiresAt,
        sourceUpdatedAt: new Date(updated).toISOString(), checkedAt: context.now.toISOString(), expiresAt,
        sourceName: "Krisinformation", sourceUrl: typeof record.Web === "string" && isAllowlistedHttpsUrl(record.Web, ["krisinformation.se", "www.krisinformation.se"])
          ? record.Web : "https://www.krisinformation.se/en",
        confidence: "HIGH",
      };
      byLocation.set(location.id, [...(byLocation.get(location.id) || []), event]);
    }
  }
  if (records.length > 0 && parseable === 0) throw new Error("Krisinformation response contains no parseable records");
  const events = [...byLocation.values()].flatMap((locationEvents) => locationEvents
    .sort((a, b) => Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt) || a.id.localeCompare(b.id)).slice(0, 2));
  const checkedLocationIds = swedish.map(({ id }) => id).filter((id) => !unavailable.has(id));
  recordSourceDiagnostics(context, { recordsExamined: records.length });
  return {
    status: invalid || records.length > 50 ? "partial" as const : "ok" as const,
    sourceUpdatedAt: events.map((event) => event.sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events, error: invalid ? `${invalid} Krisinformation records were invalid` : records.length > 50 ? "Krisinformation input limit reached" : null,
    checkedLocationIds, unavailableLocationIds: [...unavailable].sort(),
  };
}

const transportFetchers: Record<string, (context: IngestionContext) => Promise<NationalPartition>> = {
  "at-alert": fetchAtPartition, "fr-alert": fetchFrPartition, "lu-alert": fetchLuPartition,
  "lhp-flood": fetchDePartition, "catalonia-plans": fetchEsPartition, "imgw-hydrology": fetchPlPartition,
  "chmi-hydrology": fetchCzPartition, "dpc-flood-bulletin": fetchItPartition,
  "lvgmc-flood": fetchLvPartition,
  krisinformation: async (current) => {
    const response = await fetchWithRetry(current.fetch, nationalWarningSources.SE.endpoint!, {}, 3, 1024 * 1024);
    return krisinformationPartition(await response.json(), current);
  },
};

export function disabledNationalTransports(value = process.env.NATIONAL_ALERTS_DISABLED_TRANSPORTS) {
  const known = new Set(Object.values(nationalWarningSources).flatMap((country) => country.systems.map(({ id }) => id)));
  const ids = value?.trim() ? value.split(",").map((id) => id.trim()) : [];
  if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) throw new Error("Invalid NATIONAL_ALERTS_DISABLED_TRANSPORTS");
  return new Set(ids);
}

export class NationalCivilAlertsAdapter implements SourceAdapter {
  readonly id = "national-civil-alerts" as const;
  readonly cadence = "fast" as const;

  async fetch(context: IngestionContext): Promise<PartitionedSourceResult> {
    const checkedAt = context.now.toISOString();
    const disabledCountries = parseNationalAlertsDisabledCountries(process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES);
    const disabledTransports = disabledNationalTransports();
    type Transport = NonNullable<PartitionedSourceResult["partitions"]["AT"]["transports"]>[string];
    const results = new Map<string, Transport>();
    const tasks = countryCodes.flatMap((code) => activeNationalSystems(code).map((system) => ({ code, system })));
    recordSourceDiagnostics(context, { targetsScheduled: tasks.filter(({ code, system }) => !disabledCountries.has(code) && !disabledTransports.has(system.id)).length });
    await withFetchByteBudget({ remaining: 24 * 1024 * 1024 }, () => mapConcurrent(tasks, 8, async ({ code, system }) => {
      if (disabledCountries.has(code) || disabledTransports.has(system.id)) {
        results.set(system.id, { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "runtime_transport_disabled" });
        return;
      }
      const previous = context.state?.partitionTransports.nationalCivilAlerts[code]?.[system.id];
      if (previous?.lastAttempt && context.now.getTime() - Date.parse(previous.lastAttempt) < (system.cadenceMinutes || 10) * 60_000) {
        results.set(system.id, { status: "not_due", sourceUpdatedAt: previous.sourceUpdatedAt, events: [], error: null,
          checkedLocationIds: previous.checkedLocationIds, unavailableLocationIds: previous.unavailableLocationIds });
        recordSourceDiagnostics(context, { outcomeCode: `${code.toLowerCase()}_not_due` });
        return;
      }
      let partition: NationalPartition;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("National transport exceeded its eight-second budget")), 8_000);
      try {
        if (context.deadlineAt && context.deadlineAt - Date.now() < 8_000) throw new Error("Source deadline leaves less than the transport budget");
        const fetchTransport = transportFetchers[system.id];
        if (!fetchTransport) throw new Error("No approved parser for national transport");
        const boundedFetch = ((input: RequestInfo | URL, init: RequestInit = {}) => context.fetch(input, {
          ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
        })) as typeof fetch;
        partition = await fetchTransport({ ...context, fetch: boundedFetch });
      } catch (error) { partition = partitionFailure(context, code, error); }
      finally { clearTimeout(timeout); }
      results.set(system.id, { ...partition, events: partition.events.map((event) => ({ ...event, transportId: system.id })) });
    }));
    const partitions = Object.fromEntries(countryCodes.map((code) => {
      const systems = activeNationalSystems(code);
      const transports = Object.fromEntries(systems.map(({ id }) => [id, results.get(id)!]));
      const effective = systems.map(({ id }) => {
        const result = results.get(id)!;
        if (result.status !== "not_due") return result;
        const previous = context.state?.partitionTransports.nationalCivilAlerts[code]?.[id];
        const status = previous?.status === "ok" ? "ok" : previous?.status === "partial" ? "partial" : previous?.status === "not_monitored" ? "disabled" : "failed";
        return { ...result, status };
      });
      const enabled = effective.filter(({ status }) => status !== "disabled");
      const status = !enabled.length ? "disabled" : enabled.every((result) => result.status === "ok") ? "ok"
        : enabled.some((result) => result.status === "ok" || result.status === "partial") ? "partial" : "failed";
      const unavailable = new Set(enabled.flatMap((result) => result.unavailableLocationIds || []));
      return [code, {
        status, sourceUpdatedAt: enabled.map((result) => result.sourceUpdatedAt).filter(Boolean).sort().at(-1) || null,
        events: effective.flatMap((result) => result.events || []),
        error: status === "failed" || status === "partial" ? "Some national transports unavailable" : null,
        limitationCode: status === "disabled" ? disabledCountries.has(code) ? "runtime_country_disabled" : nationalWarningSources[code].limitationCode || "runtime_transport_disabled" : null,
        checkedLocationIds: [...new Set(enabled.flatMap((result) => result.checkedLocationIds || []))].filter((id) => !unavailable.has(id)),
        unavailableLocationIds: [...unavailable], transports,
      }];
    }));
    recordSourceDiagnostics(context, { targetsCompleted: results.size,
      matchedLocations: new Set([...results.values()].flatMap((result) => (result.events || []).flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : []))).size });
    return PartitionedSourceResultSchema.parse({ sourceId: this.id, checkedAt, partitions });
  }
}

export function parseNationalAlertsDisabledCountries(value: string | undefined) {
  if (!value?.trim()) return new Set<keyof typeof nationalWarningSources>();
  const codes = value.split(",").map((code) => code.trim());
  if (codes.some((code) => !/^[A-Z]{2}$/.test(code) || !(code in nationalWarningSources))) {
    throw new Error("NATIONAL_ALERTS_DISABLED_COUNTRIES must be a comma-separated list of reviewed uppercase ISO country codes");
  }
  if (new Set(codes).size !== codes.length) throw new Error("NATIONAL_ALERTS_DISABLED_COUNTRIES contains duplicates");
  return new Set(codes as Array<keyof typeof nationalWarningSources>);
}
