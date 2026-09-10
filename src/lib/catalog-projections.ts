import { catalog3ConditionsCountryLimit } from "./conditions/publication-budget";
import { serializeCatalog3Conditions } from "./conditions/serialization";
import { catalogLocationsV3 } from "./catalog-data";
import { expandedDelayedHazards } from "./expanded-source-health";
import { expandedHazardCoverage, expandedProviderApplies, expandedProviderIds, type ExpandedProviderId } from "./expanded-coverage";
import { sourceHazards } from "./risk-policy";
import { eventIsPublishable } from "./hazard-lifecycle";
import { clusterPublicHazards, projectCatalog2Snapshot } from "./risk-snapshot";
import { HazardTypeSchema, countryCodes } from "./domain/schemas";
import { catalogV3CountryCodes } from "./domain/contract-identities";
import type { IngestionStateV14 } from "./domain/catalog-state";
import { SnapshotV11Schema, ConditionsV3Schema } from "./domain/catalog-public";
import { conditionAttribution, conditionSourceEnabled } from "./conditions/sources";
import { marineConditionEligible } from "./conditions/marine";
import { currentConditions } from "./conditions/presentation";
import { conditionRecords, CONDITIONS_TOTAL_LIMIT, emptyConditions } from "./domain/conditions";
import { projectCatalog2Conditions } from "./conditions/state";

const legacyCountries = new Set<string>(countryCodes);
const addedCountries = catalogV3CountryCodes.filter((code) => !legacyCountries.has(code));
const addedLocations = catalogLocationsV3.filter(({ countryCode }) => !legacyCountries.has(countryCode));

// These pure preparation projections do not activate monitoring or publish.
// Even if private state contains evidence for a new location, it is deliberately
// withheld until that location's reviewed eligibility is activated.
export function buildPendingCatalog3Snapshot(state: IngestionStateV14, now = new Date()) {
  const legacy = projectCatalog2Snapshot(state, now);
  return SnapshotV11Schema.parse({
    ...legacy, schemaVersion: 11, catalogVersion: 3,
    providers: Object.fromEntries(Object.entries(legacy.providers).map(([id, provider]) => [id, provider.partitions ? {
      ...provider, partitions: { ...provider.partitions, ...Object.fromEntries(addedCountries.map((code) => [code, {
        status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, limitationCode: "catalog_update_pending",
      }])) },
    } : provider])),
    locations: { ...legacy.locations, ...Object.fromEntries(addedLocations.map(({ id }) => [id, {
      level: "UNKNOWN", coverage: "partial", coverageGaps: [], delayedHazards: [], hazards: [], updatePending: true,
    }])) },
  });
}

export function buildPendingCatalog3Conditions(state: IngestionStateV14, now: Date, env: Record<string, string | undefined> = process.env) {
  const legacy = projectCatalog2Conditions(state, now, env);
  const files = [
    ...legacy.map((file) => ConditionsV3Schema.parse({ ...file, schemaVersion: 3, catalogVersion: 3 })),
    ...addedCountries.map((countryCode) => ConditionsV3Schema.parse({
      schemaVersion: 3, catalogVersion: 3, countryCode, generatedAt: now.toISOString(), producerCommitSha: legacy[0].producerCommitSha,
      sources: {}, sourceHealth: {}, locations: Object.fromEntries(addedLocations.filter((location) => location.countryCode === countryCode)
        .map(({ id }) => [id, { ...emptyConditions(), limitations: ["update-pending"] }])),
    })),
  ];
  const sizes = files.map((file) => Buffer.byteLength(serializeCatalog3Conditions(file)));
  if (sizes.some((bytes, index) => bytes > catalog3ConditionsCountryLimit(files[index].countryCode))) throw new Error("Conditions exceed country publication limit");
  if (sizes.reduce((sum, bytes) => sum + bytes, 0) > CONDITIONS_TOTAL_LIMIT) throw new Error("Conditions exceed total publication limit");
  return files;
}

// Active projection is still pure: callers must finish the rollout gates before
// selecting this output for publication. Only approved, destination-scoped
// evidence can affect additions; neighboring polygons and legacy global health
// never grant expanded coverage.
export function buildCatalog3Snapshot(state: IngestionStateV14, now = new Date()) {
  const snapshot = buildPendingCatalog3Snapshot(state, now);
  for (const providerId of expandedProviderIds) {
    const receipt = state.expandedSourceHealth[providerId];
    if (!receipt) continue;
    snapshot.providers[providerId].expandedCoverage = {
      status: receipt.health.status === "not_monitored" ? "disabled" : receipt.health.status,
      checkedAt: receipt.health.lastAttempt!,
      checkedLocationIds: receipt.checkedLocationIds.slice(),
      unavailableLocationIds: receipt.unavailableLocationIds.slice(),
    };
  }
  for (const country of addedCountries) for (const provider of Object.values(snapshot.providers)) {
    if (provider.partitions) provider.partitions[country] = {
      status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, limitationCode: "not_supported",
    };
  }
  const indexed = new Map<string, IngestionStateV14["events"]>();
  const addedById = new Map(addedLocations.map((location) => [location.id, location]));
  for (const event of state.events) {
    if (!eventIsPublishable(event, now) || event.geometry.kind !== "locations") continue;
    for (const id of event.geometry.ids) {
      const location = addedById.get(id);
      if (!location || !expandedProviderApplies(event.sourceId, location)
        || !sourceHazards[event.sourceId]?.includes(event.type)) continue;
      const events = indexed.get(id) || [];
      events.push(event); indexed.set(id, events);
    }
  }
  for (const location of addedLocations) {
    const hazards = clusterPublicHazards(indexed.get(location.id) || [], now).hazards;
    const coverage = expandedHazardCoverage(location);
    const coverageGaps = HazardTypeSchema.options.filter((hazard) => coverage[hazard].status !== "monitored");
    const warningAttempted = ["usgs", "emsc", "slf-avalanche"].some((source) => expandedProviderApplies(source, location)
      && state.expandedSourceHealth[source as ExpandedProviderId]);
    if (!warningAttempted && !hazards.length) {
      snapshot.locations[location.id] = { level: "UNKNOWN", coverage: "partial", coverageGaps, delayedHazards: [], hazards: [], updatePending: true };
      continue;
    }
    const delayedHazards = expandedDelayedHazards(location, snapshot.providers, now);
    const common = { coverage: delayedHazards.length ? "delayed" as const : "partial" as const, coverageGaps, delayedHazards, hazards };
    snapshot.locations[location.id] = hazards.length ? { ...common, level: hazards[0].level, timing: hazards[0].timing }
      : delayedHazards.length ? { ...common, level: "UNKNOWN", hazards: [] } : { ...common, level: "NORMAL", hazards: [] };
  }
  if (snapshot.dataHealth === "complete" && addedLocations.some(({ id }) => snapshot.locations[id].coverage === "delayed"
    || ("updatePending" in snapshot.locations[id] && snapshot.locations[id].updatePending))) snapshot.dataHealth = "delayed";
  return SnapshotV11Schema.parse(snapshot);
}

export function buildCatalog3Conditions(state: IngestionStateV14, now: Date, env: Record<string, string | undefined> = process.env) {
  const legacy = projectCatalog2Conditions(state, now, env);
  const files = legacy.map((file) => ConditionsV3Schema.parse({ ...file, schemaVersion: 3, catalogVersion: 3 }));
  const enabled = (source: Parameters<typeof conditionSourceEnabled>[0]) => conditionSourceEnabled(source, env);
  for (const countryCode of addedCountries) {
    const entries = Object.fromEntries(addedLocations.filter((location) => location.countryCode === countryCode).map((location) => {
      const raw = state.conditions.locations[location.id];
      const allowed = emptyConditions();
      if (raw?.weather?.sourceId === "open-meteo-weather") allowed.weather = raw.weather;
      if (raw?.airQuality?.sourceId === "open-meteo-air") allowed.airQuality = raw.airQuality;
      const marineEligible = marineConditionEligible(location.id, 3);
      if (marineEligible && raw?.marine?.sourceId === "open-meteo-marine") allowed.marine = raw.marine;
      const data = currentConditions(allowed, now, enabled);
      const anyEnabled = enabled("open-meteo-weather") || enabled("open-meteo-air") || (marineEligible && enabled("open-meteo-marine"));
      data.limitations = conditionRecords(data).length ? [] : [anyEnabled ? "update-pending" : "disabled"];
      if (location.isCoastal && enabled("open-meteo-marine") && !marineEligible) data.limitations.push("outside-product");
      if (conditionRecords(data).length && ((enabled("open-meteo-weather") && !data.weather)
        || (enabled("open-meteo-air") && !data.airQuality)
        || (marineEligible && enabled("open-meteo-marine") && !data.marine))) data.limitations.push("partial-data");
      return [location.id, data];
    }));
    const sources = [...new Set(Object.values(entries).flatMap((entry) => conditionRecords(entry).map((item) => item.sourceId)))];
    files.push(ConditionsV3Schema.parse({
      schemaVersion: 3, catalogVersion: 3, countryCode, generatedAt: now.toISOString(), producerCommitSha: legacy[0].producerCommitSha,
      sources: Object.fromEntries(sources.map((source) => [source, conditionAttribution(source)])), sourceHealth: {}, locations: entries,
    }));
  }
  const sizes = files.map((file) => Buffer.byteLength(serializeCatalog3Conditions(file)));
  if (sizes.some((bytes, index) => bytes > catalog3ConditionsCountryLimit(files[index].countryCode)) || sizes.reduce((sum, bytes) => sum + bytes, 0) > CONDITIONS_TOTAL_LIMIT) {
    throw new Error("Conditions exceed catalog publication limits");
  }
  return files;
}
