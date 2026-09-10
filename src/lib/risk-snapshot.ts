import { aggregatePartitionHealth } from "./partition-health";
import type { NormalizedEventV13 as NormalizedEvent } from "./domain/catalog-state";
import { assertCatalog2Collection, type IngestionStateV14 as IngestionState } from "./domain/catalog-state";
import { coverageByCountry, coverageByLocation, locations, locationsById } from "./data";
import {
  countryCodes, providerIdForSourceId, SnapshotSchema, type HazardType,
  type Location, type LocationState, type ProviderId,
  type PublicHazard, type Snapshot, type SourceHealth, type SourceId,
} from "./domain/schemas";
import { eventAffectsLocation } from "./geospatial";
import { comparePublicHazards, eventIsPublishable, hazardTiming } from "./hazard-lifecycle";
import { providerRegistry, publicProviderPartitionState, publicProviderState } from "./provider-registry";
import { nationalWarningManifest, type NationalWarningSystem } from "./national-warning-sources";
import {
  enabledHazards, enabledSources, hazardAppliesToLocation, sourceCadenceMinutes, sourceHazards, weatherFamily,
} from "./risk-policy";

function compactCoverageGaps(gaps: HazardType[]) {
  const unique = [...new Set(gaps)];
  if (weatherFamily.every((hazard) => unique.includes(hazard))) {
    return unique.filter((hazard) => hazard === "severe-weather" || !weatherFamily.includes(hazard));
  }
  return unique;
}

function publicHazard(event: NormalizedEvent, now: Date): PublicHazard {
  const providerId = event.providerId || providerIdForSourceId(event.sourceId);
  return {
    providerId,
    id: event.id, type: event.type, level: event.level, timing: hazardTiming(event.startsAt, now),
    headline: event.headline, explanation: event.explanation, action: event.action,
    affectedArea: { label: event.affectedArea }, startsAt: event.startsAt, endsAt: event.endsAt,
    sourceUpdatedAt: event.sourceUpdatedAt, checkedAt: event.checkedAt, expiresAt: event.expiresAt,
    sourceName: event.sourceName, sourceUrl: event.sourceUrl, confidence: event.confidence,
    evidence: [{
      providerId, sourceName: event.sourceName, sourceUrl: event.sourceUrl,
      sourceUpdatedAt: event.sourceUpdatedAt, checkedAt: event.checkedAt, confidence: event.confidence,
    }],
  };
}

function normalizedIncidentText(value: string) {
  return value.normalize("NFKD").replace(/\p{Mark}/gu, "").toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function incidentKey(event: NormalizedEvent, now: Date) {
  return [
    event.providerId || providerIdForSourceId(event.sourceId), event.type, event.level, hazardTiming(event.startsAt, now),
    normalizedIncidentText(event.headline), normalizedIncidentText(event.affectedArea),
  ].join("|");
}

function primaryEventOrder(a: NormalizedEvent, b: NormalizedEvent) {
  return Number(b.confidence === "HIGH") - Number(a.confidence === "HIGH")
    || Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt)
    || a.id.localeCompare(b.id);
}

function canonicalEvidenceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

function clusteredEvents(events: NormalizedEvent[], now: Date) {
  const pending = events.slice().sort(primaryEventOrder);
  const groups: NormalizedEvent[][] = [];
  while (pending.length) {
    const primary = pending.shift()!;
    const key = incidentKey(primary, now);
    const group = [primary];
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const candidate = pending[index];
      if (incidentKey(candidate, now) !== key
        || Date.parse(candidate.startsAt) >= Date.parse(primary.endsAt)
        || Date.parse(candidate.endsAt) <= Date.parse(primary.startsAt)) continue;
      group.push(...pending.splice(index, 1));
    }
    groups.push(group.sort(primaryEventOrder));
  }
  return groups;
}

export function clusterPublicHazards(events: NormalizedEvent[], now: Date): { hazards: PublicHazard[]; evidenceOverflow: number } {
  let evidenceOverflow = 0;
  const hazards = clusteredEvents(events, now).map((group) => {
    const hazard = publicHazard(group[0], now);
    const evidence = new Map<string, PublicHazard["evidence"][number]>();
    for (const event of group) {
      const providerId = event.providerId || providerIdForSourceId(event.sourceId);
      const item = {
        providerId, sourceName: event.sourceName, sourceUrl: canonicalEvidenceUrl(event.sourceUrl),
        sourceUpdatedAt: event.sourceUpdatedAt, checkedAt: event.checkedAt, confidence: event.confidence,
      };
      const key = `${item.sourceUrl}|${event.sourceUpdatedAt}`;
      if (!evidence.has(key)) evidence.set(key, item);
    }
    const all = [...evidence.values()];
    evidenceOverflow += Math.max(0, all.length - 5);
    return { ...hazard, evidence: all.slice(0, 5) };
  }).sort(comparePublicHazards);
  return { hazards, evidenceOverflow };
}

function sourceIsDelayed(sourceId: SourceId, health: SourceHealth, now: Date) {
  if (!enabledSources.has(sourceId)) return false;
  if (health.status === "not_monitored"
    && providerRegistry[providerIdForSourceId(sourceId)].healthScope === "non_blocking") return false;
  if ([
    "gdacs", "gfm", "emsc", "slf-avalanche", "euregio-avalanche", "effis-active-fire",
    "national-civil-alerts", "vigicrues", "foen-flood", "ehyd-flood", "eonet", "edo-drought", "fcdo-travel-advice",
  ].includes(sourceId) && !health.lastSuccess) return health.consecutiveFailures >= 2;
  if (health.status === "delayed" || !health.lastSuccess) return true;
  const cadence = sourceCadenceMinutes[sourceId];
  if (!cadence) return false;
  const nextExpected = health.nextExpectedUpdate
    ? Date.parse(health.nextExpectedUpdate)
    : Date.parse(health.lastSuccess) + cadence * 60_000;
  return Number.isFinite(nextExpected) && now.getTime() > nextExpected + cadence * 60_000;
}

function transportIsDelayed(health: SourceHealth, cadenceMinutes: number, now: Date) {
  if (health.status === "delayed" || health.consecutiveFailures >= 2) return true;
  return transportIsOverdue(health, cadenceMinutes, now);
}

function transportIsOverdue(health: SourceHealth, cadenceMinutes: number, now: Date) {
  if (!health.lastSuccess) return false;
  const nextExpected = health.nextExpectedUpdate
    ? Date.parse(health.nextExpectedUpdate)
    : Date.parse(health.lastSuccess) + cadenceMinutes * 60_000;
  return Number.isFinite(nextExpected) && now.getTime() > nextExpected + cadenceMinutes * 60_000;
}

function effectiveSources(state: IngestionState, now: Date): IngestionState["sources"] {
  return Object.fromEntries((Object.entries(state.sources) as [SourceId, SourceHealth][]).map(([sourceId, health]) => [
    sourceId,
    sourceIsDelayed(sourceId, health, now)
      ? { ...health, status: "delayed" as const, error: health.error || "Expected source update is overdue" }
      : health,
  ])) as IngestionState["sources"];
}

function sourceDelaysGlobalHealth(sourceId: SourceId, sources: IngestionState["sources"], now: Date) {
  const provider = Object.values(providerRegistry).find((definition) => definition.sourceId === sourceId);
  if (provider?.healthScope === "coverage" || provider?.healthScope === "non_blocking") return false;
  if (sourceId === "gdacs" || sourceId === "effis-active-fire" || sourceId === "national-civil-alerts") return false;
  if (sourceId === "emsc" && !sourceIsDelayed("usgs", sources.usgs, now)) return false;
  return sourceIsDelayed(sourceId, sources[sourceId], now);
}

function providerUnavailableAtLocation(state: IngestionState, providerId: ProviderId, health: SourceHealth, locationId: string, now: Date) {
  const providerCoverage = state.providerCoverage[providerId];
  const currentPartialScope = health.status === "delayed"
    && providerCoverage?.checkedAt === health.lastAttempt
    && providerCoverage.unavailableLocationIds.length > 0
    && !transportIsOverdue(health, providerRegistry[providerId].cadenceMinutes || 10, now);
  return !currentPartialScope || providerCoverage.unavailableLocationIds.includes(locationId);
}

function delayedHazards(sources: IngestionState["sources"], excludedSource?: SourceId): Set<HazardType> {
  const hazards = new Set<HazardType>();
  for (const [sourceId, health] of Object.entries(sources) as [SourceId, SourceHealth][]) {
    if (sourceId === excludedSource) continue;
    const provider = Object.values(providerRegistry).find((definition) => definition.sourceId === sourceId);
    if (provider?.healthScope === "coverage" || provider?.healthScope === "non_blocking") continue;
    if (["gdacs", "slf-avalanche", "euregio-avalanche", "effis-active-fire", "national-civil-alerts"].includes(sourceId)) continue;
    if (sourceId === "emsc" && sources.usgs?.status === "ok") continue;
    if (sourceId === "gfm" && sources.meteoalarm?.status === "ok") continue;
    if (health.status === "delayed") for (const hazard of sourceHazards[sourceId] || []) hazards.add(hazard);
  }
  return hazards;
}

const locationsByCountry = new Map<string, Location[]>();
for (const countryCode of countryCodes) {
  locationsByCountry.set(countryCode, locations.filter((location) => location.countryCode === countryCode));
}

export function indexEventsByLocation(events: NormalizedEvent[], now: Date): Map<string, NormalizedEvent[]> {
  const indexed = new Map<string, NormalizedEvent[]>();
  const add = (locationId: string, event: NormalizedEvent) => {
    if (!locationsById.has(locationId)) return;
    const current = indexed.get(locationId);
    if (current) current.push(event);
    else indexed.set(locationId, [event]);
  };
  for (const event of events) {
    if (!eventIsPublishable(event, now)) continue;
    if (event.geometry.kind === "locations") {
      for (const locationId of event.geometry.ids) add(locationId, event);
      continue;
    }
    const candidates = event.geometry.kind === "regions"
      ? locationsByCountry.get(event.geometry.countryCode) || []
      : locations;
    for (const location of candidates) if (eventAffectsLocation(event, location)) add(location.id, event);
  }
  return indexed;
}

export function buildSnapshot(state: IngestionState, now = new Date()): Snapshot {
  assertCatalog2Collection(state);
  return projectCatalog2Snapshot(state, now);
}

// A compatibility publication uses the same evidence, scoped to the frozen old
// destinations. Expanded country failures must not change the old aggregate.
export function projectCatalog2Snapshot(input: IngestionState, now = new Date()): Snapshot {
  const sourcesForLegacy = { ...input.sources };
  if (input.collection.catalogVersion === 3) {
    for (const [source, group] of [["meteoalarm", "meteoalarm"], ["eea", "eea"], ["national-civil-alerts", "nationalCivilAlerts"]] as const) {
      sourcesForLegacy[source] = aggregatePartitionHealth(Object.fromEntries(countryCodes.map((code) => [code, input.sourcePartitions[group][code]])));
    }
  }
  const state = { ...input, sources: sourcesForLegacy };
  const sources = effectiveSources(state, now);
  const lastSuccesses = (Object.entries(sources) as [SourceId, SourceHealth][])
    .filter(([sourceId]) => Object.values(providerRegistry).find((definition) => definition.sourceId === sourceId)?.healthScope !== "non_blocking")
    .map(([, source]) => source.lastSuccess ? Date.parse(source.lastSuccess) : 0)
    .filter(Boolean);
  const newestSuccess = lastSuccesses.length ? Math.max(...lastSuccesses) : 0;
  const stale = newestSuccess === 0 || now.getTime() - newestSuccess > 2 * 60 * 60_000;
  const delayedByAge = newestSuccess > 0 && now.getTime() - newestSuccess > 30 * 60_000;
  const delayed = delayedByAge || (Object.keys(sources) as SourceId[]).some((id) => sourceDelaysGlobalHealth(id, sources, now));
  const dataHealth = stale ? "stale" : delayed ? "delayed" : "complete";
  const globallyDelayed = delayedHazards(sources, "meteoalarm");
  const eventsByLocation = indexEventsByLocation(state.events, now);
  const locationStates: Record<string, LocationState> = {};

  for (const location of locations) {
    const locationEvents = eventsByLocation.get(location.id) || [];
    const hazardIsApplicable = (hazard: HazardType) => hazardAppliesToLocation(hazard, location)
      || (hazard === "volcano" && locationEvents.some((event) => event.type === "volcano"));
    const coverage = { ...coverageByCountry[location.countryCode].hazards, ...(coverageByLocation[location.id] || {}) };
    let coverageGaps = (Object.entries(coverage) as [HazardType, { status: "monitored" | "partial" | "not_monitored" }][]) 
      .filter(([hazard, entry]) => entry.status !== "monitored" && hazardIsApplicable(hazard))
      .map(([hazard]) => hazard);
    if (location.sourceRegionCodes.meteoalarm.every((code) => code.endsWith(":country"))) {
      for (const hazard of sourceHazards.meteoalarm || []) if (!coverageGaps.includes(hazard)) coverageGaps.push(hazard);
    }
    const applicableDelayed = [...globallyDelayed].filter(hazardIsApplicable);
    const meteoHealth = state.sourcePartitions.meteoalarm[location.countryCode];
    if (sourceIsDelayed("meteoalarm", meteoHealth, now)) {
      for (const hazard of sourceHazards.meteoalarm || []) if (hazardIsApplicable(hazard) && !applicableDelayed.includes(hazard)) applicableDelayed.push(hazard);
    }
    const eeaHealth = state.sourcePartitions.eea[location.countryCode];
    if (coverage["air-quality"].providerIds.includes("eea-aqi")
      && sourceIsDelayed("eea", eeaHealth, now)
      && providerUnavailableAtLocation(state, "eea-aqi", eeaHealth, location.id, now)
      && !applicableDelayed.includes("air-quality")) applicableDelayed.push("air-quality");
    const nationalHealth = state.sourcePartitions.nationalCivilAlerts[location.countryCode];
    const coverageSystems = nationalWarningManifest.countries[location.countryCode].systems.filter((system) => system.status === "active"
      && system.runtimeTarget === "national-civil-alerts" && system.role === "coverage" && system.coverageContribution !== "none"
      && (!system.coverageLocationIds || system.coverageLocationIds.includes(location.id)));
    const transportHealth = state.partitionTransports.nationalCivilAlerts[location.countryCode];
    for (const system of coverageSystems) {
      const health = transportHealth[system.id];
      const unavailable = health ? !health.checkedLocationIds.includes(location.id)
        || health.unavailableLocationIds.includes(location.id)
        || transportIsOverdue(health, system.cadenceMinutes || 10, now) : true;
      const late = health?.lastAttempt
        ? transportIsDelayed(health, system.cadenceMinutes || 10, now) && unavailable
        : sourceIsDelayed("national-civil-alerts", nationalHealth, now)
          && providerUnavailableAtLocation(state, "national-civil-alerts", nationalHealth, location.id, now);
      if (!late) continue;
      for (const hazard of system.hazards) {
        if (coverage[hazard]?.providerIds.includes("national-civil-alerts") && !applicableDelayed.includes(hazard)) applicableDelayed.push(hazard);
      }
    }
    for (const [hazard, entry] of Object.entries(coverage) as [HazardType, { providerIds: ProviderId[] }][]) {
      if (!hazardIsApplicable(hazard)) continue;
      for (const providerId of entry.providerIds) {
        if (providerId === "eea-aqi" || providerId === "national-civil-alerts") continue;
        const definition = providerRegistry[providerId];
        const health = state.sources[definition.sourceId];
        if (definition.healthScope === "coverage"
          && providerUnavailableAtLocation(state, providerId, health, location.id, now)
          && sourceIsDelayed(definition.sourceId, health, now)
          && !applicableDelayed.includes(hazard)) applicableDelayed.push(hazard);
      }
    }
    if (stale) {
      for (const hazard of enabledHazards) {
        if (hazardIsApplicable(hazard) && !applicableDelayed.includes(hazard)) applicableDelayed.push(hazard);
      }
    }
    coverageGaps = compactCoverageGaps(coverageGaps);
    const delayedHazards = [...new Set(applicableDelayed)];
    const hazards = clusterPublicHazards(locationEvents, now).hazards;
    const coverageState = delayedHazards.length > 0 ? "delayed" : coverageGaps.length ? "partial" : "complete";
    if (hazards.length) {
      locationStates[location.id] = {
        level: hazards[0].level, timing: hazards[0].timing, coverage: coverageState, coverageGaps, delayedHazards, hazards,
      };
    } else if (delayedHazards.length > 0) {
      locationStates[location.id] = { level: "UNKNOWN", coverage: coverageState, coverageGaps, delayedHazards, hazards: [] };
    } else {
      locationStates[location.id] = { level: "NORMAL", coverage: coverageState, coverageGaps, delayedHazards, hazards: [] };
    }
  }
  const providers = Object.fromEntries(Object.keys(providerRegistry).map((id) => {
    const providerId = id as keyof typeof providerRegistry;
    const sourceId = providerRegistry[providerId].sourceId;
    const provider = publicProviderState(providerId, sources[sourceId]);
    if (!["meteoalarm", "eea-aqi", "national-civil-alerts"].includes(providerId)) return [id, provider];
    const partitionKey = providerId === "national-civil-alerts" ? "nationalCivilAlerts" : providerId === "eea-aqi" ? "eea" : "meteoalarm";
    const partitions = Object.fromEntries(countryCodes.map((countryCode) => {
      const health = state.sourcePartitions[partitionKey][countryCode];
      const effective = sourceIsDelayed(sourceId, health, now)
        ? { ...health, status: "delayed" as const }
        : health;
      const systems = providerId === "national-civil-alerts"
        ? nationalWarningManifest.countries[countryCode].systems.filter(({ runtimeTarget }) => runtimeTarget !== "meteoalarm-fallback")
        : providerId === "meteoalarm"
          ? nationalWarningManifest.countries[countryCode].systems.filter(({ runtimeTarget }) => runtimeTarget === "meteoalarm-fallback")
          : [];
      const transportHealth = providerId === "national-civil-alerts"
        ? state.partitionTransports.nationalCivilAlerts[countryCode]
        : providerId === "meteoalarm" ? state.partitionTransports.meteoalarm[countryCode] : {};
      const fallbackStatus = publicProviderPartitionState(effective).status;
      const transportState = (system: NationalWarningSystem) => {
        const current = transportHealth[system.id];
        const status = system.status !== "active" ? "disabled" as const
          : system.role === "fallback" && effective.status === "ok" ? "ok" as const
          : current?.status === "not_monitored" ? "disabled" as const
            : current && system.role === "coverage" && transportIsDelayed(current, system.cadenceMinutes || 10, now) ? "delayed" as const
            : current?.status === "ok" || current?.status === "partial" || current?.status === "delayed" ? current.status
              : current?.status === "failed" ? "failed" as const : fallbackStatus;
        return {
          id: system.id, name: system.systemName, role: system.role, status,
          sourceUpdatedAt: current?.sourceUpdatedAt || null,
          limitationCode: status === "disabled" ? system.limitationCode : null,
          officialUrl: system.officialUrl,
        };
      };
      const partition = publicProviderPartitionState(effective);
      return [countryCode, systems.length ? { ...partition, transports: systems.map(transportState) } : partition];
    }));
    return [id, { ...provider, partitions }];
  }));
  return SnapshotSchema.parse({ schemaVersion: 10, catalogVersion: 2, generatedAt: now.toISOString(), valid: true, dataHealth, providers, locations: locationStates });
}

export function snapshotProjectionMetrics(state: IngestionState, snapshot: Snapshot, now: Date) {
  const visibleIncidents = Object.values(snapshot.locations).reduce((total, location) => total + location.hazards.length, 0);
  const evidenceLinks = Object.values(snapshot.locations).reduce((total, location) => total
    + location.hazards.reduce((count, hazard) => count + hazard.evidence.length, 0), 0);
  const projections = [...indexEventsByLocation(state.events, now).values()].map((events) => ({ events: events.length, ...clusterPublicHazards(events, now) }));
  const evidenceOverflow = projections.reduce((total, result) => total + result.evidenceOverflow, 0);
  return {
    retainedNormalizedEvents: state.events.length,
    visibleIncidents,
    evidenceLinks,
    clusteredDuplicates: projections.reduce((total, result) => total + Math.max(0, result.events - result.hazards.length), 0),
    evidenceOverflow,
  };
}
