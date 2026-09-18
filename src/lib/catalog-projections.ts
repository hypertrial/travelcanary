import { catalog3ConditionsCountryLimit } from "./conditions/publication-budget";
import { serializeCatalog3Conditions } from "./conditions/serialization";
import { catalogLocationsV3 } from "./catalog-data";
import { expandedDelayedHazards } from "./expanded-source-health";
import { expandedHazardCoverage, expandedProviderApplies, expandedProviderIds, type ExpandedProviderId } from "./expanded-coverage";
import { sourceHazards } from "./risk-policy";
import { eventIsPublishable } from "./hazard-lifecycle";
import { clusterPublicHazards, projectCoreSnapshot } from "./risk-snapshot";
import { HazardTypeSchema, countryCodes, providerIdForSourceId, type SourceHealth } from "./domain/schemas";
import { catalogV3CountryCodes } from "./domain/contract-identities";
import type { IngestionStateV15, IngestionStateV16 } from "./domain/catalog-state";
import { SnapshotV11Schema, ConditionsV3Schema } from "./domain/catalog-public";
import { conditionAttribution, conditionSourceEnabled } from "./conditions/sources";
import { marineConditionEligible } from "./conditions/marine";
import { currentConditions } from "./conditions/presentation";
import { conditionRecords, conditionSourceAppliesToCountry, CONDITIONS_TOTAL_LIMIT, emptyConditions } from "./domain/conditions";
import { eventAffectsLocation } from "./geospatial";
import { nationalWarningManifest, type NationalWarningSystem } from "./national-warning-sources";
import { providerRegistry, publicProviderPartitionState } from "./provider-registry";

const legacyCountries = new Set<string>(countryCodes);
const forecastHealthSources = new Set(["open-meteo-weather", "open-meteo-air", "open-meteo-marine", "met-norway"]);
const addedCountries = catalogV3CountryCodes.filter((code) => !legacyCountries.has(code));
const addedLocations = catalogLocationsV3.filter(({ countryCode }) => !legacyCountries.has(countryCode));
type ProjectionState = IngestionStateV15 | IngestionStateV16;

// These pure preparation projections do not activate monitoring or publish.
// Even if private state contains evidence for a new location, it is deliberately
// withheld until that location's reviewed eligibility is activated.
export function buildPendingCatalog3Snapshot(state: ProjectionState, now = new Date()) {
  const legacy = projectCoreSnapshot(state, now);
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

// Active projection is still pure: callers must finish the rollout gates before
// selecting this output for publication. Only approved, destination-scoped
// evidence can affect additions; neighboring polygons and legacy global health
// never grant expanded coverage.
export function buildCatalog3Snapshot(state: ProjectionState, now = new Date()) {
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
  const transportState = (health: SourceHealth | undefined, system: NationalWarningSystem, fallback: ReturnType<typeof publicProviderPartitionState>["status"]) => {
    const authorized = system.status === "active" || system.status === "credential_gated" && Boolean(health && health.status !== "not_monitored");
    const status = !authorized || health?.status === "not_monitored" ? "disabled" as const
      : health?.status === "ok" || health?.status === "partial" || health?.status === "delayed" ? health.status
        : health?.status === "failed" ? "failed" as const : fallback;
    return { id: system.id, name: system.systemName, role: system.role, status,
      lastSuccess: health?.lastSuccess || null, sourceUpdatedAt: health?.sourceUpdatedAt || null,
      nextExpectedUpdate: health?.nextExpectedUpdate || null,
      limitationCode: status === "disabled" ? system.limitationCode || "credential_not_configured" : null,
      officialUrl: system.officialUrl };
  };
  for (const country of addedCountries) for (const providerId of ["meteoalarm", "eea-aqi", "national-civil-alerts"] as const) {
    const group = providerId === "meteoalarm" ? "meteoalarm" : providerId === "eea-aqi" ? "eea" : "nationalCivilAlerts";
    const health = state.sourcePartitions[group][country];
    const partition = publicProviderPartitionState(health);
    const target = providerId === "meteoalarm" ? ["meteoalarm-primary", "meteoalarm-fallback"] : providerId === "national-civil-alerts" ? ["national-civil-alerts"] : [];
    const systems = nationalWarningManifest.countries[country].systems.filter(({ runtimeTarget }) => target.includes(runtimeTarget));
    const transports = providerId === "meteoalarm" ? state.partitionTransports.meteoalarm[country]
      : providerId === "national-civil-alerts" ? state.partitionTransports.nationalCivilAlerts[country] : {};
    snapshot.providers[providerId].partitions![country] = systems.length
      ? { ...partition, transports: systems.map((system) => transportState(transports[system.id], system, partition.status)) }
      : partition;
  }
  const indexed = new Map<string, ProjectionState["events"]>();
  const addedById = new Map(addedLocations.map((location) => [location.id, location]));
  for (const event of state.events) {
    if (!eventIsPublishable(event, now)) continue;
    const providerId = event.providerId || providerIdForSourceId(event.sourceId);
    for (const [id, location] of addedById) {
      const capability = expandedHazardCoverage(location)[event.type];
      if (!expandedProviderApplies(providerId, location) || !sourceHazards[event.sourceId]?.includes(event.type)
        || providerRegistry[providerId]?.satisfiesCoverage !== false && !capability.providerIds.includes(providerId)
        || !eventAffectsLocation(event, location)) continue;
      const events = indexed.get(id) || [];
      events.push(event); indexed.set(id, events);
    }
  }
  for (const location of addedLocations) {
    const hazards = clusterPublicHazards(indexed.get(location.id) || [], now).hazards;
    const coverage = expandedHazardCoverage(location);
    const coverageGaps = HazardTypeSchema.options.filter((hazard) => coverage[hazard].status !== "monitored");
    const warningAttempted = ["usgs", "emsc", "slf-avalanche"].some((source) => expandedProviderApplies(source, location)
      && state.expandedSourceHealth[source as ExpandedProviderId])
      || (["meteoalarm", "national-civil-alerts"] as const).some((source) => expandedProviderApplies(source, location)
        && state.collectionReceipts[3][source]?.checkedLocationIds.includes(location.id));
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

export function buildCatalog3Conditions(state: ProjectionState, now: Date, env: Record<string, string | undefined> = process.env) {
  const enabled = (source: Parameters<typeof conditionSourceEnabled>[0]) => conditionSourceEnabled(source, env);
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  const producerCommitSha = sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  const files = catalogV3CountryCodes.map((countryCode) => {
    const added = addedCountries.includes(countryCode);
    const countryLocations = catalogLocationsV3.filter((location) => location.countryCode === countryCode);
    const entries = Object.fromEntries(countryLocations.map((location) => {
      const raw = state.conditions.locations[location.id] || emptyConditions();
      const allowed = added ? emptyConditions() : raw;
      if (added && raw.weather?.sourceId === "open-meteo-weather") allowed.weather = raw.weather;
      if (added && raw.airQuality?.sourceId === "open-meteo-air") allowed.airQuality = raw.airQuality;
      const marineEligible = marineConditionEligible(location.id, 3);
      if (added && marineEligible && raw.marine?.sourceId === "open-meteo-marine") allowed.marine = raw.marine;
      const data = currentConditions(allowed, now, enabled);
      const anyEnabled = enabled("open-meteo-weather") || enabled("open-meteo-air") || (marineEligible && enabled("open-meteo-marine"));
      data.limitations = conditionRecords(data).length ? [] : [anyEnabled ? "update-pending" : "disabled"];
      if (location.isCoastal && enabled("open-meteo-marine") && !marineEligible) data.limitations.push("outside-product");
      if (conditionRecords(data).length && ((enabled("open-meteo-weather") && !data.weather)
        || (enabled("open-meteo-air") && !data.airQuality)
        || (marineEligible && enabled("open-meteo-marine") && !data.marine))) data.limitations.push("partial-data");
      return [location.id, data];
    }));
    const applicable = added ? [] : Object.entries(state.conditions.health).filter(([id]) => !forecastHealthSources.has(id)
      && enabled(id as Parameters<typeof conditionAttribution>[0])
      && conditionSourceAppliesToCountry(id as Parameters<typeof conditionAttribution>[0], countryCode));
    const sources = [...new Set([...Object.values(entries).flatMap((entry) => conditionRecords(entry).map((item) => item.sourceId)),
      ...applicable.map(([id]) => id as Parameters<typeof conditionAttribution>[0])])];
    return ConditionsV3Schema.parse({
      schemaVersion: 3, catalogVersion: 3, countryCode, generatedAt: now.toISOString(), producerCommitSha,
      sources: Object.fromEntries(sources.map((source) => [source, conditionAttribution(source)])),
      sourceHealth: Object.fromEntries(applicable.map(([id, item]) => [id, {
        status: item!.status, checkedAt: item!.checkedAt, limitationCode: item!.code,
      }])), locations: entries,
    });
  });
  const sizes = files.map((file) => Buffer.byteLength(serializeCatalog3Conditions(file)));
  if (sizes.some((bytes, index) => bytes > catalog3ConditionsCountryLimit(files[index].countryCode)) || sizes.reduce((sum, bytes) => sum + bytes, 0) > CONDITIONS_TOTAL_LIMIT) {
    throw new Error("Conditions exceed catalog publication limits");
  }
  return files;
}
