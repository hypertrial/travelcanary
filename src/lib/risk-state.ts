import { aggregatePartitionHealth } from "./partition-health";
import type { NormalizedEventV13 as NormalizedEvent } from "./domain/catalog-state";
import catalogV2 from "../../data/catalog-releases/2.json";
import { expandedReceiptLocationIds, IngestionStateV14Schema, parseCatalogState, type IngestionStateV14 as IngestionState } from "./domain/catalog-state";
import { createHash } from "node:crypto";
import {
  countryCodes,
  providerIdForSourceId, sourceIds, type AggregateSourceResult, type CountryCode,
  type PartitionedSourceResult, type SourceHealth,
  type SourceId, type SourceResult,
} from "./domain/schemas";
import { distanceKm } from "./geospatial";
import { hazardLevelRank } from "./hazard-lifecycle";
import { nationalWarningSources } from "./national-warning-sources";
import { providerRegistry } from "./provider-registry";
import { enabledSources, sourceCadenceMinutes } from "./risk-policy";
import { MAX_RETAINED_EVENTS, MAX_RETAINED_FINGERPRINTS } from "./ingestion/limits";
import { ConditionsCacheSchema } from "./domain/conditions";

function emptyHealth(sourceId: SourceId): SourceHealth {
  return {
    status: enabledSources.has(sourceId) ? "failed" : "not_monitored",
    lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
    itemCount: 0, consecutiveFailures: 0, error: enabledSources.has(sourceId) ? "Not yet checked" : null,
  };
}

export function createEmptyState(now = new Date()): IngestionState {
  const sources = Object.fromEntries(sourceIds.map((id) => [id, emptyHealth(id)]));
  const meteoalarm = Object.fromEntries(countryCodes.map((countryCode) => [countryCode, emptyHealth("meteoalarm")]));
  const eea = Object.fromEntries(countryCodes.map((countryCode) => [countryCode, emptyHealth("eea")]));
  const nationalCivilAlerts = Object.fromEntries(countryCodes.map((countryCode) => [countryCode, nationalWarningSources[countryCode].enabled
    ? emptyHealth("national-civil-alerts")
    : { ...emptyHealth("national-civil-alerts"), status: "not_monitored" as const, error: nationalWarningSources[countryCode].limitationCode }])) as Record<CountryCode, SourceHealth>;
  sources["national-civil-alerts"] = aggregatePartitionHealth(nationalCivilAlerts);
  const transportHealth = (sourceId: SourceId, active: boolean, limitationCode: string | null) => ({
    ...(active ? emptyHealth(sourceId) : { ...emptyHealth(sourceId), status: "not_monitored" as const, error: limitationCode }),
    checkedLocationIds: [], unavailableLocationIds: [],
  });
  const meteoalarmTransports = Object.fromEntries(countryCodes.map((countryCode) => [countryCode,
    Object.fromEntries(nationalWarningSources[countryCode].systems
      .filter(({ runtimeTarget }) => runtimeTarget === "meteoalarm-fallback")
      .map((system) => [system.id, transportHealth("meteoalarm", system.status === "active", system.limitationCode)])),
  ]));
  const nationalTransports = Object.fromEntries(countryCodes.map((countryCode) => [countryCode,
    Object.fromEntries(nationalWarningSources[countryCode].systems
      .filter(({ runtimeTarget }) => runtimeTarget !== "meteoalarm-fallback")
      .map((system) => [system.id, transportHealth("national-civil-alerts", system.status === "active", system.limitationCode)])),
  ]));
  const providers = Object.fromEntries(Object.keys(providerRegistry).map((id) => [
    id, structuredClone(sources[providerRegistry[id as keyof typeof providerRegistry].sourceId]),
  ]));
  return parseCatalogState({
    schemaVersion: 12, updatedAt: now.toISOString(), events: [], candidates: [], sources, providers,
    sourcePartitions: { meteoalarm, eea, nationalCivilAlerts }, providerCoverage: {}, fingerprints: {},
    partitionTransports: { meteoalarm: meteoalarmTransports, nationalCivilAlerts: nationalTransports, eea: Object.fromEntries(countryCodes.map((code) => [code, {}])) },
    conditions: ConditionsCacheSchema.parse({}),
  });
}

function updateHealth(
  previous: SourceHealth,
  result: { status: "ok" | "partial" | "failed" | "disabled" | "not_due"; checkedAt: string; sourceUpdatedAt: string | null; itemCount: number; error: string | null; limitationCode?: string | null },
  cadence: number | null,
  countPartialFailure = false,
): SourceHealth {
  if (result.status === "not_due") return previous;
  const nextExpectedUpdate = cadence ? new Date(Date.parse(result.checkedAt) + cadence * 60_000).toISOString() : null;
  if (result.status === "ok") return {
    status: "ok", lastAttempt: result.checkedAt, lastSuccess: result.checkedAt, sourceUpdatedAt: result.sourceUpdatedAt,
    nextExpectedUpdate, itemCount: result.itemCount, consecutiveFailures: 0, error: null,
  };
  if (result.status === "partial") {
    const consecutiveFailures = countPartialFailure ? previous.consecutiveFailures + 1 : 0;
    return {
      status: consecutiveFailures >= 2 ? "delayed" : "partial",
      lastAttempt: result.checkedAt, lastSuccess: result.checkedAt, sourceUpdatedAt: result.sourceUpdatedAt,
      nextExpectedUpdate, itemCount: result.itemCount, consecutiveFailures, error: result.error,
    };
  }
  if (result.status === "disabled") return {
    status: "not_monitored", lastAttempt: result.checkedAt, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0,
    error: result.limitationCode || "not_supported",
  };
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const failedNextExpectedUpdate = previous.nextExpectedUpdate
    || (cadence && previous.lastSuccess ? new Date(Date.parse(previous.lastSuccess) + cadence * 60_000).toISOString() : null);
  return {
    ...previous, status: consecutiveFailures >= 2 ? "delayed" : "failed", lastAttempt: result.checkedAt,
    nextExpectedUpdate: failedNextExpectedUpdate, consecutiveFailures, error: result.error,
  };
}


// Absence remains never collected. Legacy-only results cannot renew this cohort.
export function mergeExpandedSourceReceipt(state: IngestionState, result: AggregateSourceResult) {
  if (state.collection.catalogVersion !== 3 || !Object.hasOwn(expandedReceiptLocationIds, result.sourceId)) return;
  const source = result.sourceId as keyof typeof expandedReceiptLocationIds;
  const scope = new Set<string>(expandedReceiptLocationIds[source]);
  const checked = (result.checkedLocationIds || []).filter((id) => scope.has(id));
  const unavailable = (result.unavailableLocationIds || []).filter((id) => scope.has(id));
  if (!checked.length && !unavailable.length) return;
  const classified = [...checked, ...unavailable];
  if (classified.length !== scope.size || new Set(classified).size !== scope.size) throw new Error("Expanded receipt requires its complete reviewed scope");
  if ((result.status === "failed" || result.status === "disabled") && checked.length) throw new Error("Failed expanded result cannot claim checked destinations");
  const previous = state.expandedSourceHealth[source];
  if (previous?.health.lastAttempt && Date.parse(result.checkedAt) <= Date.parse(previous.health.lastAttempt)) return;
  const priorHealth = previous?.health || emptyHealth(source);
  const status = result.status === "disabled" ? "disabled" : checked.length === scope.size ? "ok" : checked.length ? "partial" : "failed";
  const health = updateHealth(priorHealth, { ...result, status,
    error: status === "ok" ? null : result.error || "Expanded destinations unavailable",
    itemCount: result.events.filter((event) => event.geometry.kind === "locations" && event.geometry.ids.some((id) => scope.has(id))).length,
  }, sourceCadenceMinutes[source], true);
  if (!checked.length) {
    health.lastSuccess = priorHealth.lastSuccess;
    health.sourceUpdatedAt = priorHealth.sourceUpdatedAt;
  }
  state.expandedSourceHealth[source] = { health, checkedLocationIds: checked.slice().sort(), unavailableLocationIds: unavailable.slice().sort() };
}

function eventTargetsLocations(event: NormalizedEvent, locationIds: Set<string>) {
  return event.geometry.kind === "locations" && event.geometry.ids.some((id) => locationIds.has(id));
}

function eventMatchesRemovalPrefix(eventId: string, prefix: string) {
  return prefix.endsWith(":") ? eventId.startsWith(prefix) : eventId === prefix || eventId.startsWith(`${prefix}:`);
}

const legacyLocationIds = new Set<string>(catalogV2.locationIds);

function legacyAggregateHealthResult(result: AggregateSourceResult) {
  if (!Object.hasOwn(expandedReceiptLocationIds, result.sourceId) || !result.checkedLocationIds || !result.unavailableLocationIds) return result;
  const checked = result.checkedLocationIds.filter((id) => legacyLocationIds.has(id));
  const unavailable = result.unavailableLocationIds.filter((id) => legacyLocationIds.has(id));
  const status = result.status === "disabled" ? "disabled" : unavailable.length === 0 && checked.length ? "ok" : checked.length ? "partial" : "failed";
  return { ...result, status, error: status === "ok" ? null : result.error,
    events: result.events.filter((event) => event.geometry.kind === "locations" && event.geometry.ids.some((id) => legacyLocationIds.has(id))),
  } as AggregateSourceResult;
}

function mergeAggregateResult(events: NormalizedEvent[], state: IngestionState, result: AggregateSourceResult): NormalizedEvent[] {
  mergeExpandedSourceReceipt(state, result);
  const legacyResult = legacyAggregateHealthResult(result);
  const nextHealth = updateHealth(
    state.sources[result.sourceId] || emptyHealth(result.sourceId),
    { ...legacyResult, itemCount: legacyResult.events.length },
    sourceCadenceMinutes[result.sourceId],
    true,
  );
  state.sources[result.sourceId] = nextHealth;
  const providerId = providerIdForSourceId(result.sourceId);
  if (providerId in state.providers) state.providers[providerId as keyof typeof state.providers] = nextHealth;
  const checked = new Set(result.checkedLocationIds || []);
  if (checked.size || (result.unavailableLocationIds?.length || 0) > 0) state.providerCoverage[providerId] = {
    checkedAt: result.checkedAt,
    checkedLocationIds: [...checked].sort(),
    unavailableLocationIds: [...new Set(result.unavailableLocationIds || [])].sort(),
  };
  const collected = Object.hasOwn(expandedReceiptLocationIds, result.sourceId) && result.checkedLocationIds && result.unavailableLocationIds
    ? new Set([...result.checkedLocationIds, ...result.unavailableLocationIds]) : null;
  if (result.status === "disabled") return events.filter((event) => event.sourceId !== result.sourceId
    || (collected !== null && !eventTargetsLocations(event, collected)));
  if (result.status === "ok") {
    const retained = checked.size
      ? events.filter((event) => event.sourceId !== result.sourceId || !eventTargetsLocations(event, checked))
      : events.filter((event) => event.sourceId !== result.sourceId);
    return [...retained, ...result.events];
  }
  if (result.status === "partial") {
    const removed = result.removedEventPrefixes || [];
    const unavailable = new Set(result.unavailableEventIds || []);
    const previousById = new Map(events.filter((event) => event.sourceId === result.sourceId).map((event) => [event.id, event]));
    const refreshed = result.events.map((event) => unavailable.has(event.id) ? previousById.get(event.id) || event : event);
    const retained = checked.size
      ? events.filter((event) => event.sourceId !== result.sourceId
        || !eventTargetsLocations(event, checked)
        || (removed.length > 0 && !removed.some((prefix) => eventMatchesRemovalPrefix(event.id, prefix))))
      : events.filter((event) => event.sourceId !== result.sourceId
        || (collected !== null && !eventTargetsLocations(event, collected))
        || !removed.some((prefix) => eventMatchesRemovalPrefix(event.id, prefix)));
    return [...retained, ...refreshed];
  }
  return events;
}

function eventBelongsToCountry(event: NormalizedEvent, countryCode: CountryCode) {
  if (event.geometry.kind === "regions") return event.geometry.countryCode === countryCode;
  return event.geometry.kind === "locations" && event.geometry.ids.some((id) => id.startsWith(`${countryCode.toLowerCase()}-`));
}

function partitionTransportCadence(
  countryCode: CountryCode,
  transportId: string,
  sourceId: SourceId,
) {
  const system = nationalWarningSources[countryCode].systems.find(({ id }) => id === transportId);
  return system?.cadenceMinutes ?? sourceCadenceMinutes[sourceId];
}

function mergePartitionedResult(events: NormalizedEvent[], state: IngestionState, result: PartitionedSourceResult): NormalizedEvent[] {
  const partitionKey = result.sourceId === "national-civil-alerts" ? "nationalCivilAlerts" : result.sourceId;
  const partitions = state.sourcePartitions[partitionKey];
  const providerId = providerIdForSourceId(result.sourceId);
  const previousCoverage = state.providerCoverage[providerId];
  const checkedLocationIds = new Set<string>();
  const unavailableLocationIds = new Set<string>();
  for (const countryCode of countryCodes) {
    const partition = result.partitions[countryCode];
    if (partitions[countryCode].lastAttempt && Date.parse(result.checkedAt) < Date.parse(partitions[countryCode].lastAttempt)) {
      const prefix = `${countryCode.toLowerCase()}-`;
      previousCoverage?.checkedLocationIds.filter((id) => id.startsWith(prefix)).forEach((id) => checkedLocationIds.add(id));
      previousCoverage?.unavailableLocationIds.filter((id) => id.startsWith(prefix)).forEach((id) => unavailableLocationIds.add(id));
      continue;
    }
    partitions[countryCode] = updateHealth(
      partitions[countryCode],
      { ...partition, checkedAt: result.checkedAt, itemCount: partition.events.length },
      sourceCadenceMinutes[result.sourceId],
      partition.limitationCode !== "ifrc_fallback" && partition.limitationCode !== "national_authority_fallback",
    );
    const obsoleteTransports = new Set<string>();
    if (partition.transports) {
      const transportState = state.partitionTransports[partitionKey][countryCode];
      for (const [transportId, transport] of Object.entries(partition.transports)) {
        if (transport.status === "not_due") continue;
        const previous = transportState[transportId] || {
          ...emptyHealth(result.sourceId), checkedLocationIds: [], unavailableLocationIds: [],
        };
        if (previous.lastAttempt && Date.parse(previous.lastAttempt) > Date.parse(result.checkedAt)) {
          obsoleteTransports.add(transportId);
          continue;
        }
        transportState[transportId] = {
          ...updateHealth(previous, { ...transport, checkedAt: result.checkedAt, itemCount: transport.events?.length ?? partition.events.length },
            partitionTransportCadence(countryCode, transportId, result.sourceId), true),
          checkedLocationIds: [...new Set(transport.checkedLocationIds || [])].sort(),
          unavailableLocationIds: [...new Set(transport.unavailableLocationIds || [])].sort(),
        };
      }
    }
    (partition.checkedLocationIds || []).forEach((id) => checkedLocationIds.add(id));
    (partition.unavailableLocationIds || []).forEach((id) => unavailableLocationIds.add(id));
    const owned = Object.entries(partition.transports || {}).filter(([, transport]) => transport.events !== undefined);
    if (owned.length) {
      for (const [transportId, transport] of owned) {
        if (obsoleteTransports.has(transportId) || transport.status === "not_due" || transport.status === "failed") continue;
        const checked = new Set(transport.checkedLocationIds || []);
        events = events.filter((event) => {
          if (event.sourceId !== result.sourceId || event.transportId !== transportId || !eventBelongsToCountry(event, countryCode)) return true;
          if (transport.status === "ok" || transport.status === "disabled") return false;
          return !eventTargetsLocations(event, checked) && !(transport.removedEventPrefixes || []).some((prefix) => eventMatchesRemovalPrefix(event.id, prefix));
        });
        if (transport.status !== "disabled") {
          const previousById = new Map(events.filter((event) => event.sourceId === result.sourceId).map((event) => [event.id, event]));
          events.push(...transport.events!.map((event) => {
            const previous = previousById.get(event.id);
            // An incomplete AQI sample set can raise the known worst category, but cannot lower it.
            if (result.sourceId === "eea" && transport.status === "partial" && previous
              && hazardLevelRank[previous.level] > hazardLevelRank[event.level]) return previous;
            return { ...event, transportId };
          }));
        }
      }
      // CAP references supersede the authority's warning, not just its delivery path.
      // Direct CAP transports also carry explicit references alongside a broad
      // list-replacement prefix. Only the explicit references cross transports.
      const superseded = result.sourceId === "meteoalarm" ? owned.flatMap(([id, transport]) => {
        if (obsoleteTransports.has(id) || !["ok", "partial"].includes(transport.status)) return [];
        const removed = transport.removedEventPrefixes || [];
        if (["meteoalarm-primary", "ifrc-meteoalarm"].includes(id)) return removed;
        const root = id === "aemet-cap" ? "meteoalarm:aemet:" : id === "dhmz-cap" ? "meteoalarm:dhmz:" : null;
        return root ? removed.filter((prefix) => prefix.startsWith(root) && prefix.length > root.length)
          .map((prefix) => `meteoalarm:${prefix.slice(root.length)}`) : [];
      }) : [];
      if (superseded.length) events = events.filter((event) => event.sourceId !== result.sourceId
        || !eventBelongsToCountry(event, countryCode)
        || !superseded.some((prefix) => eventMatchesRemovalPrefix(event.id, prefix)
          || eventMatchesRemovalPrefix(event.id.replace(/^meteoalarm:(?:aemet|dhmz):/, "meteoalarm:"), prefix)));
      continue;
    }
    if (partition.status === "ok" || partition.status === "disabled") {
      events = events.filter((event) => event.sourceId !== result.sourceId || !eventBelongsToCountry(event, countryCode));
      if (partition.status === "ok") events.push(...partition.events);
    } else if (partition.status === "partial") {
      const replaced = new Set(partition.checkedLocationIds || []);
      events = events.filter((event) => event.sourceId !== result.sourceId
        || (!(partition.removedEventPrefixes || []).some((prefix) => eventMatchesRemovalPrefix(event.id, prefix)) && !eventTargetsLocations(event, replaced)));
      events.push(...partition.events);
    }
  }
  state.sources[result.sourceId] = aggregatePartitionHealth(partitions);
  state.providers[providerId] = state.sources[result.sourceId];
  if (checkedLocationIds.size || unavailableLocationIds.size) state.providerCoverage[providerId] = {
    checkedAt: state.sources[result.sourceId].lastAttempt || result.checkedAt,
    checkedLocationIds: [...checkedLocationIds].sort(),
    unavailableLocationIds: [...unavailableLocationIds].sort(),
  };
  return events;
}

function earthquakeEventsMatch(usgs: NormalizedEvent, emsc: NormalizedEvent): boolean {
  if (!usgs.earthquake || !emsc.earthquake) return false;
  const usgsIds = new Set(usgs.earthquake.ids.map((id) => id.toLowerCase()));
  if (emsc.earthquake.ids.some((id) => usgsIds.has(id.toLowerCase()))) return true;
  return Math.abs(Date.parse(usgs.startsAt) - Date.parse(emsc.startsAt)) <= 90_000
    && distanceKm(usgs.earthquake.coordinates, emsc.earthquake.coordinates) <= 50
    && Math.abs(usgs.earthquake.magnitude - emsc.earthquake.magnitude) <= 0.5;
}

export function mergeSourceResults(state: IngestionState, results: SourceResult[], now: Date): IngestionState {
  const nextState = structuredClone(state);
  let events = nextState.events.filter((event) => Date.parse(event.expiresAt) > now.getTime());
  for (const result of results) {
    const previousAttempt = nextState.sources[result.sourceId].lastAttempt;
    if (!("partitions" in result) && previousAttempt
      && Date.parse(result.checkedAt) < Date.parse(previousAttempt)) continue;
    events = "partitions" in result
      ? mergePartitionedResult(events, nextState, result)
      : mergeAggregateResult(events, nextState, result);
    if (!("partitions" in result) && result.candidates && result.status !== "failed") {
      const providerId = providerIdForSourceId(result.sourceId);
      const retained = result.status === "ok" && providerId !== "gdelt"
        ? nextState.candidates.filter((candidate) => candidate.providerId !== providerId)
        : nextState.candidates;
      const candidates = [...retained, ...result.candidates];
      const byExternalId = new Map<string, typeof candidates[number]>();
      for (const candidate of candidates.sort((a, b) => Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt))) {
        const key = `${candidate.providerId}:${candidate.externalId}`;
        if (!byExternalId.has(key)) byExternalId.set(key, candidate);
      }
      nextState.candidates = [...byExternalId.values()].filter((candidate) => candidate.providerId !== providerId)
        .concat([...byExternalId.values()].filter((candidate) => candidate.providerId === providerId).slice(0, 200));
    }
  }

  const activeCandidates = nextState.candidates.filter((candidate) => Date.parse(candidate.expiresAt) > now.getTime());
  nextState.candidates = ["gdacs", "gdelt"].flatMap((providerId) => activeCandidates
    .filter((candidate) => candidate.providerId === providerId)
    .sort((a, b) => Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt) || a.externalId.localeCompare(b.externalId))
    .slice(0, 200));
  events = events.filter((event) => {
    if (event.sourceId !== "emsc" || event.geometry.kind !== "locations") return true;
    return !events.some((other) => other.sourceId === "usgs" && other.geometry.kind === "locations"
      && earthquakeEventsMatch(other, event)
      && other.geometry.ids.some((id) => event.geometry.kind === "locations" && event.geometry.ids.includes(id)));
  });

  events = events.map((event) => ({ ...event, providerId: event.providerId || providerIdForSourceId(event.sourceId) }));
  const uniqueById = new Map<string, NormalizedEvent>();
  for (const event of events) {
    const key = `${event.sourceId}:${event.id}`;
    const previous = uniqueById.get(key);
    if (!previous || Date.parse(event.sourceUpdatedAt) >= Date.parse(previous.sourceUpdatedAt)) uniqueById.set(key, event);
  }
  const unique = [...uniqueById.values()];
  if (unique.length > MAX_RETAINED_EVENTS) throw new Error(`Private ingestion state exceeds the ${MAX_RETAINED_EVENTS}-event hard limit`);

  const fingerprints = Object.fromEntries(Object.entries(nextState.fingerprints)
    .filter(([, expiresAt]) => Date.parse(expiresAt) > now.getTime()));
  for (const event of unique) {
    const fingerprint = createHash("sha256").update(`${event.sourceId}:${event.id}`).digest("hex");
    fingerprints[fingerprint] = new Date(now.getTime() + 48 * 60 * 60_000).toISOString();
  }
  const boundedFingerprints = Object.fromEntries(Object.entries(fingerprints)
    .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
    .slice(0, MAX_RETAINED_FINGERPRINTS));
  return IngestionStateV14Schema.parse({
    ...nextState, schemaVersion: 14,
    updatedAt: Date.parse(nextState.updatedAt) > now.getTime() ? nextState.updatedAt : now.toISOString(),
    events: unique, fingerprints: boundedFingerprints,
  });
}
