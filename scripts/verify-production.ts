import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PublicCatalogV2Schema, PublicCatalogV3Schema, SnapshotV11Schema, ConditionsV3Schema, type PublicCatalogLocation, type CatalogSnapshot } from "../src/lib/domain/catalog-public";
import { catalogLocationsV3 } from "../src/lib/catalog-data";
import { catalogV2CountryCodes } from "../src/lib/domain/contract-identities";
import { catalog3ConditionsCountryLimit } from "../src/lib/conditions/publication-budget";
import { nationalWarningManifest, nationalWarningSources } from "../src/lib/national-warning-sources";
import { providerRegistry } from "../src/lib/provider-registry";
import { CompleteSnapshotSchema } from "../src/lib/snapshot-validation";
import { ConditionsSchema, CONDITIONS_COUNTRY_LIMIT, CONDITIONS_TOTAL_LIMIT, conditionRecords, conditionSourceAppliesToCountry } from "../src/lib/domain/conditions";
import { conditionSources } from "../src/lib/conditions/sources";
import { marineEligibleLocationIds as legacyMarineEligibleLocationIds, catalog3MarineMappingByLocation } from "../src/lib/conditions/marine";
import { locations as legacyLocations } from "../src/lib/data";
import { catalogV2Paths, catalogV2SnapshotUrl, catalogV3Paths, catalogV3SnapshotUrl } from "../src/lib/catalog-paths";
import { measureCoverage } from "./coverage-measurement";
import { mapConcurrent } from "../src/lib/ingestion/fetch";
import { airportMappings } from "../src/lib/conditions/metar";
import { rwsWaterMappings } from "../src/lib/conditions/rws-water";
import { ipmaStationMappings } from "../src/lib/conditions/ipma";
import { opwHydroMappings } from "../src/lib/conditions/opw";
import { arsoHydroMappings } from "../src/lib/conditions/arso-hydro";

const SNAPSHOT_WARNING_BYTES = 300_000;
const SNAPSHOT_HARD_LIMIT_BYTES = 500_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const FRESHNESS_WARNING_MS = 30 * 60_000;
const STALE_BLOCKER_MS = 2 * 60 * 60_000;
const CONDITIONS_PUBLICATION_GRACE_MS = 75 * 60_000;
const steadyStateProviders = ["gfm", "eonet", "edo-drought", "fcdo-travel-advice"] as const;
const requiredInfrastructureHealth = ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"] as const;

type Finding = { code: string; message: string };
type VerifyProductionOptions = {
  origin?: string;
  snapshotUrl?: string;
  expectedSha?: string;
  expectLocalConditions?: boolean;
  fetch?: typeof fetch;
  now?: Date;
};

export type ProductionVerificationReport = {
  status: "ok" | "warning" | "blocked";
  blockers: Finding[];
  warnings: Finding[];
  metrics: {
    coverageMeasurement?: ReturnType<typeof measureCoverage>;
    observationAvailability?: Record<string, { eligible: number; fresh: number; expired: number; absent: number; unknown: number }>;
    origin: string;
    releaseSha: string | null;
    snapshotUrl: string | null;
    schemaVersion: number | null;
    catalogVersion: number | null;
    generatedAt: string | null;
    ageMinutes: number | null;
    dataHealth: string | null;
    snapshotBytes: number | null;
    locations: number | null;
    unknownLocations: number | null;
    pendingLocations: number | null;
    expandedProviderStatuses?: Record<string, { status: string; checkedAt: string; checkedDestinations: number; unavailableDestinations: number }>;
    permanentGapHazards: number | null;
    delayedHazards: number | null;
    visibleIncidents: number | null;
    evidenceLinks: number | null;
    providerStatuses: Record<string, string>;
    conditions?: { countries: number; locations: number; availableDestinations: number; bytes: number; releaseMatches: number; releaseMismatches: number;
      infrastructureIncidents: number; systemConditions: number; pendingExpiryCleanup: number; overdueExpiredRecords: number;
      byProduct: Record<"weather" | "airQuality" | "marine", { eligible: number; available: number; missing: number }>;
      bySource: Record<string, { eligible: number; available: number; health: { ok: number; partial: number; failed: number; healthyEmpty: number } }> };
  };
};

function operationalMeta(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]]));
    if (attributes.name === name) return attributes.content || null;
  }
  return null;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Production origin must use HTTPS");
  if (url.username || url.password) throw new Error("Production origin must not contain credentials");
  return url.origin;
}

function discoveredSnapshotUrl(html: string): string | null {
  const meta = operationalMeta(html, "travelcanary-snapshot");
  if (meta) return meta;
  return html.match(/https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^"]*?latest\.json/i)?.[0]?.replaceAll("\\", "") || null;
}

async function boundedText(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<{ text: string; bytes: number }> {
  const response = await fetchImpl(url, {
    cache: "no-store",
    headers: { "User-Agent": "TravelCanary production verifier (+https://travelcanary.org/)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(body), bytes };
}

function ordered(findings: Finding[]) {
  return findings.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

function boundedExamples(values: string[], limit = 8) {
  const sorted = [...values].sort();
  return `${sorted.slice(0, limit).join(", ")}${sorted.length > limit ? ` (+${sorted.length - limit} more)` : ""}`;
}

const locationCountry = new Map(catalogLocationsV3.map(({ id, countryCode }) => [id, countryCode]));
function boundedCountryExamples(values: string[], limit = 8) {
  const groups = new Map<string, string[]>();
  for (const id of [...values].sort()) {
    const country = locationCountry.get(id) || "??";
    groups.set(country, [...(groups.get(country) || []), id]);
  }
  let remaining = limit;
  const output: string[] = [];
  for (const [country, ids] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!remaining) break;
    const shown = ids.slice(0, remaining); remaining -= shown.length;
    output.push(`${country}: ${shown.join(", ")}`);
  }
  const omitted = values.length - Math.min(values.length, limit);
  return `${output.join("; ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

export async function verifyProduction(options: VerifyProductionOptions = {}): Promise<ProductionVerificationReport> {
  const blockers: Finding[] = [];
  const warnings: Finding[] = [];
  const now = options.now || new Date();
  let origin = options.origin || "https://travelcanary.org";
  try { origin = normalizeOrigin(origin); } catch (error) {
    blockers.push({ code: "origin_invalid", message: error instanceof Error ? error.message : "Production origin is invalid" });
  }
  const metrics: ProductionVerificationReport["metrics"] = {
    origin, releaseSha: null, snapshotUrl: null, schemaVersion: null, catalogVersion: null, generatedAt: null, ageMinutes: null,
    dataHealth: null, snapshotBytes: null, locations: null, unknownLocations: null, pendingLocations: null, visibleIncidents: null,
    permanentGapHazards: null, delayedHazards: null, evidenceLinks: null, providerStatuses: {},
  };

  if (blockers.length) return { status: "blocked", blockers, warnings, metrics };
  let html: string;
  try { html = (await boundedText(options.fetch || fetch, `${origin}/`, 1_000_000)).text; } catch (error) {
    blockers.push({ code: "page_fetch_failed", message: `Could not read the production page: ${error instanceof Error ? error.message : String(error)}` });
    return { status: "blocked", blockers, warnings, metrics };
  }

  const mode = operationalMeta(html, "travelcanary-data-mode")
    || (/\\?"mode\\?"\s*:\s*\\?"live\\?"/.test(html) ? "live" : null);
  if (mode !== "live") blockers.push({ code: "live_mode_missing", message: `Production reports ${mode || "no"} data mode instead of live` });
  const releaseSha = operationalMeta(html, "travelcanary-release")?.toLowerCase() || null;
  metrics.releaseSha = releaseSha;
  const expectedSha = options.expectedSha?.trim().toLowerCase();
  if (expectedSha && !/^[a-f0-9]{7,40}$/.test(expectedSha)) {
    blockers.push({ code: "expected_sha_invalid", message: "Expected commit SHA must contain 7 to 40 hexadecimal characters" });
  } else if (expectedSha && !releaseSha) {
    blockers.push({ code: "release_sha_missing", message: "The deployment does not expose a release commit SHA" });
  } else if (expectedSha && releaseSha && !releaseSha.startsWith(expectedSha)) {
    blockers.push({ code: "release_sha_mismatch", message: `Expected ${expectedSha}, received ${releaseSha}` });
  }

  const catalogMeta = operationalMeta(html, "travelcanary-catalog-version") || "2";
  if (!["2", "3"].includes(catalogMeta)) {
    blockers.push({ code: "catalog_version_invalid", message: "Production reports an unsupported catalog release" });
    return { status: "blocked", blockers: ordered(blockers), warnings, metrics };
  }
  const catalogVersion = catalogMeta === "3" ? 3 : 2;
  const paths = catalogVersion === 3 ? catalogV3Paths : catalogV2Paths;
  const locations = catalogVersion === 3 ? catalogLocationsV3 : legacyLocations;
  const countryCount = new Set(locations.map(({ countryCode }) => countryCode)).size;
  const marineEligibleLocationIds = catalogVersion === 3 ? new Set(catalog3MarineMappingByLocation.keys()) : legacyMarineEligibleLocationIds;
  const legacyCountries = new Set<string>(catalogV2CountryCodes);
  const sourceApplies = (id: keyof typeof conditionSources, country: string) => conditionSourceAppliesToCountry(id, country)
    && (legacyCountries.has(country) || ["open-meteo-weather", "open-meteo-air", "open-meteo-marine"].includes(id));
  const snapshotUrl = (catalogVersion === 3 ? catalogV3SnapshotUrl : catalogV2SnapshotUrl)(options.snapshotUrl || discoveredSnapshotUrl(html))?.href ?? null;
  metrics.snapshotUrl = snapshotUrl;
  if (!snapshotUrl) {
    blockers.push({ code: "snapshot_url_missing", message: "The production page does not expose a valid public latest.json URL" });
    return { status: "blocked", blockers: ordered(blockers), warnings, metrics };
  }

  let snapshot: CatalogSnapshot | null = null;
  let catalog: PublicCatalogLocation[] | null = null;
  const [snapshotResult, catalogResult] = await Promise.allSettled([
    boundedText(options.fetch || fetch, snapshotUrl, SNAPSHOT_HARD_LIMIT_BYTES + 1),
    boundedText(options.fetch || fetch, `${origin}${paths.catalog}`, 150_000),
  ]);
  if (snapshotResult.status === "rejected") {
    blockers.push({ code: "snapshot_fetch_failed", message: `Could not read the production snapshot: ${String(snapshotResult.reason)}` });
  } else {
    metrics.snapshotBytes = snapshotResult.value.bytes;
    if (snapshotResult.value.bytes > SNAPSHOT_HARD_LIMIT_BYTES) {
      blockers.push({ code: "snapshot_size_hard_limit", message: `Snapshot is ${snapshotResult.value.bytes} bytes; maximum is ${SNAPSHOT_HARD_LIMIT_BYTES}` });
    } else if (snapshotResult.value.bytes >= SNAPSHOT_WARNING_BYTES) {
      warnings.push({ code: "snapshot_size_warning", message: `Snapshot is ${snapshotResult.value.bytes} bytes; warning starts at ${SNAPSHOT_WARNING_BYTES}` });
    }
    try { snapshot = (catalogVersion === 3 ? SnapshotV11Schema : CompleteSnapshotSchema).parse(JSON.parse(snapshotResult.value.text)); } catch (error) {
      blockers.push({ code: "snapshot_invalid", message: `Snapshot catalog ${catalogVersion} validation failed: ${error instanceof Error ? error.message.slice(0, 240) : String(error)}` });
    }
  }
  if (catalogResult.status === "rejected") {
    blockers.push({ code: "catalog_fetch_failed", message: `Could not read the public catalog: ${String(catalogResult.reason)}` });
  } else {
    try { catalog = (catalogVersion === 3 ? PublicCatalogV3Schema : PublicCatalogV2Schema).parse(JSON.parse(catalogResult.value.text)); } catch (error) {
      blockers.push({ code: "catalog_invalid", message: `Public catalog validation failed: ${error instanceof Error ? error.message.slice(0, 240) : String(error)}` });
    }
  }

  if (snapshot) {
    metrics.schemaVersion = snapshot.schemaVersion;
    metrics.catalogVersion = snapshot.catalogVersion;
    metrics.generatedAt = snapshot.generatedAt;
    metrics.dataHealth = snapshot.dataHealth;
    metrics.locations = Object.keys(snapshot.locations).length;
    metrics.pendingLocations = Object.values(snapshot.locations).filter((state) => "updatePending" in state && state.updatePending).length;
    metrics.unknownLocations = Object.values(snapshot.locations).filter(({ level }) => level === "UNKNOWN").length;
    metrics.permanentGapHazards = Object.values(snapshot.locations).reduce((total, location) => total + location.coverageGaps.length, 0);
    metrics.delayedHazards = Object.values(snapshot.locations).reduce((total, location) => total + location.delayedHazards.length, 0);
    metrics.visibleIncidents = Object.values(snapshot.locations).reduce((total, location) => total + location.hazards.length, 0);
    metrics.evidenceLinks = Object.values(snapshot.locations).reduce((total, location) => total + location.hazards.reduce((sum, hazard) => sum + hazard.evidence.length, 0), 0);
    metrics.providerStatuses = Object.fromEntries(Object.entries(snapshot.providers).map(([id, state]) => [id, state.status]));
    const ageMs = now.getTime() - Date.parse(snapshot.generatedAt);
    metrics.ageMinutes = Math.round(ageMs / 60_000);
    if (ageMs < -MAX_FUTURE_SKEW_MS) blockers.push({ code: "snapshot_future_dated", message: `Snapshot is ${Math.abs(metrics.ageMinutes)} minutes in the future` });
    else if (ageMs > STALE_BLOCKER_MS) blockers.push({ code: "snapshot_stale", message: `Snapshot is ${metrics.ageMinutes} minutes old` });
    else if (ageMs > FRESHNESS_WARNING_MS) warnings.push({ code: "snapshot_age_warning", message: `Snapshot is ${metrics.ageMinutes} minutes old` });
    if (snapshot.dataHealth === "stale") blockers.push({ code: "data_health_stale", message: "Snapshot data health is stale" });
    else if (snapshot.dataHealth !== "complete") warnings.push({ code: "data_health_delayed", message: `Snapshot data health is ${snapshot.dataHealth}` });
    if (metrics.unknownLocations) warnings.push({ code: "unknown_locations", message: `${metrics.unknownLocations} destinations have unknown risk results; ${metrics.pendingLocations} await initial monitoring updates` });
    if (snapshot.catalogVersion === 3) {
      metrics.expandedProviderStatuses = {};
      for (const [id, provider] of Object.entries(snapshot.providers)) {
        if (provider.expandedCoverage) {
          const receipt = provider.expandedCoverage;
          metrics.expandedProviderStatuses[id] = { status: receipt.status, checkedAt: receipt.checkedAt,
            checkedDestinations: receipt.checkedLocationIds.length, unavailableDestinations: receipt.unavailableLocationIds.length };
          if (receipt.status !== "ok") warnings.push({ code: "expanded_provider_health", message: `${id}: ${receipt.status}; ${receipt.checkedLocationIds.length} checked, ${receipt.unavailableLocationIds.length} unavailable destinations` });
        }
        for (const [country, partition] of Object.entries(provider.partitions || {})) if (!legacyCountries.has(country) && partition.status !== "disabled") {
          blockers.push({ code: "expanded_partition_unauthorized", message: `${country}/${id} has no approved expanded country transport but reports ${partition.status}` });
        }
      }
    }
    const unhealthy = Object.entries(snapshot.providers).filter(([, state]) => state.status !== "ok" && state.status !== "disabled")
      .map(([id, state]) => `${id}:${state.status}`).sort();
    if (unhealthy.length) warnings.push({ code: "provider_health", message: unhealthy.join(", ") });
    const disabledSteadyState = steadyStateProviders.filter((id) => snapshot!.providers[id].status === "disabled");
    if (snapshot.providers.gdelt.status === "disabled") warnings.push({ code: "gdelt_reliability_gate", message: "GDELT is disabled pending its reliability gate; context only, no monitoring coverage lost" });
    if (disabledSteadyState.length) blockers.push({ code: "steady_state_provider_disabled", message: `Expected enabled providers are disabled: ${disabledSteadyState.join(", ")}` });
    const national = snapshot.providers["national-civil-alerts"].partitions;
    const disabledNational = Object.entries(nationalWarningSources).filter(([, source]) => source.enabled)
      .filter(([countryCode]) => national?.[countryCode as keyof typeof national]?.status === "disabled").map(([countryCode]) => countryCode).sort();
    if (disabledNational.length) blockers.push({ code: "national_partition_disabled", message: `Enabled national partitions are disabled: ${disabledNational.join(", ")}` });
    for (const [countryCode, country] of Object.entries(nationalWarningManifest.countries)) for (const system of country.systems) {
      if (system.runtimeTarget === "none") continue;
      const providerId = system.runtimeTarget === "meteoalarm-fallback" ? "meteoalarm" : "national-civil-alerts";
      const transport = snapshot.providers[providerId].partitions?.[countryCode as keyof typeof nationalWarningManifest.countries]
        ?.transports?.find(({ id }) => id === system.id);
      if (system.status === "active" && (!transport || transport.status === "disabled")) {
        blockers.push({ code: "active_transport_missing", message: `${countryCode}/${system.id} is approved but not exposed as enabled transport health` });
      }
      if (system.status !== "active" && transport && transport.status !== "disabled") {
        blockers.push({ code: "unauthorized_transport_active", message: `${countryCode}/${system.id} is gated but reports active runtime health` });
      }
    }
    for (const id of Object.keys(providerRegistry)) {
      if (!(id in snapshot.providers)) blockers.push({ code: "provider_missing", message: `Snapshot is missing provider ${id}` });
    }
  }
  if (snapshot && catalog) {
    const catalogIds = catalog.map(({ id }) => id).sort();
    const snapshotIds = Object.keys(snapshot.locations).sort();
    if (catalogIds.length !== snapshotIds.length || catalogIds.some((id, index) => id !== snapshotIds[index])) {
      blockers.push({ code: "catalog_snapshot_mismatch", message: "Public catalog and snapshot location IDs differ" });
    }
    if (catalog.length !== locations.length) blockers.push({ code: "catalog_version_mismatch", message: `Catalog version ${catalogVersion} requires ${locations.length} destinations; received ${catalog.length}` });
  }

  if (snapshot && catalog && catalog.length === locations.length
    && new Set(catalog.map(({ id }) => id)).size === catalog.length
    && catalog.map(({ id }) => id).sort().join(",") === Object.keys(snapshot.locations).sort().join(",")) metrics.coverageMeasurement = measureCoverage(snapshot, catalog, now);

  const conditionsEnabled = operationalMeta(html, "travelcanary-local-conditions") === "enabled";
  const noncommercialEnabled = operationalMeta(html, "travelcanary-noncommercial") === "enabled";
  if (options.expectLocalConditions && !conditionsEnabled) {
    blockers.push({ code: "local_conditions_disabled", message: "Local Conditions are required for this release but Production reports them disabled" });
  }
  if (options.expectLocalConditions && !noncommercialEnabled) {
    blockers.push({ code: "noncommercial_conditions_disabled", message: "The reviewed noncommercial conditions sources are required for this release but Production reports them disabled" });
  }
  if (conditionsEnabled) {
    const conditionsMetrics = { countries: 0, locations: 0, availableDestinations: 0, bytes: 0, releaseMatches: 0, releaseMismatches: 0,
      infrastructureIncidents: 0, systemConditions: 0, pendingExpiryCleanup: 0, overdueExpiredRecords: 0,
      byProduct: {
        weather: { eligible: locations.length, available: 0, missing: locations.length },
        airQuality: { eligible: locations.length, available: 0, missing: locations.length },
        marine: { eligible: marineEligibleLocationIds.size, available: 0, missing: marineEligibleLocationIds.size },
      },
      bySource: {} as Record<string, { eligible: number; available: number; health: { ok: number; partial: number; failed: number; healthyEmpty: number } }> };
    metrics.conditions = conditionsMetrics;
    const seen = new Set<string>();
    const releaseMismatches: string[] = [];
    const invalidConditions: string[] = [];
    const incompleteAvailability: string[] = [];
    const failedConditionSources: string[] = [];
    const persistentConditionSources: string[] = [];
    const staleInfrastructure: string[] = [];
    const pendingInfrastructureCleanup: string[] = [];
    const invalidInfrastructureExpiry: string[] = [];
    const overduePublications: string[] = [];
    const noncommercial = noncommercialEnabled;
    const observationMappings: Record<string, string[]> = {
      "awc-metar": airportMappings.map(({ locationId }) => locationId),
      "ipma-observations": ipmaStationMappings.map(({ locationId }) => locationId),
      "arso-hydro": arsoHydroMappings.map(({ locationId }) => locationId),
      "opw-hydro": opwHydroMappings.map(({ locationId }) => locationId),
      "rws-water": rwsWaterMappings.map(({ locationId }) => locationId),
    };
    const observationAvailability = Object.fromEntries(Object.entries(observationMappings).map(([source, ids]) => [source,
      { eligible: new Set(ids).size, fresh: 0, expired: 0, absent: 0, unknown: new Set(ids).size }]));
    metrics.observationAvailability = observationAvailability;
    const productLocations = { weather: new Set<string>(), airQuality: new Set<string>(), marine: new Set<string>() };
    const expiredProductLocations = { weather: new Set<string>(), airQuality: new Set<string>(), marine: new Set<string>() };
    for (const [id, source] of Object.entries(conditionSources)) if (source.enabled) conditionsMetrics.bySource[id] = {
      eligible: id === "awc-metar" ? new Set(airportMappings.map(({ locationId }) => locationId)).size
        : id === "rws-water" ? new Set(rwsWaterMappings.map(({ locationId }) => locationId)).size
        : id === "opw-hydro" ? new Set(opwHydroMappings.map(({ locationId }) => locationId)).size
        : id === "arso-hydro" ? new Set(arsoHydroMappings.map(({ locationId }) => locationId)).size
        : id === "ipma-observations" ? new Set(ipmaStationMappings.map(({ locationId }) => locationId)).size
        : id === "ipma-seismic" ? locations.filter(({ countryCode }) => countryCode === "PT").length
        : ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "eac-power", "enemalta-power", "pse-energy-compass"].includes(id)
          ? locations.filter(({ countryCode }) => sourceApplies(id as keyof typeof conditionSources, countryCode)).length
        : id === "open-meteo-marine" ? marineEligibleLocationIds.size : id === "met-norway" ? legacyLocations.length : locations.length, available: 0,
      health: { ok: 0, partial: 0, failed: 0, healthyEmpty: 0 },
    };
    await mapConcurrent([...new Set(locations.map(({ countryCode }) => countryCode))], 4, async (country) => {
      try {
        const response = await boundedText(options.fetch || fetch, new URL(`${paths.conditions}${country}.json`, catalogVersion === 3 ? new URL("/", snapshotUrl) : snapshotUrl).href, catalogVersion === 3 ? catalog3ConditionsCountryLimit(country) : CONDITIONS_COUNTRY_LIMIT);
        const file = (catalogVersion === 3 ? ConditionsV3Schema : ConditionsSchema).parse(JSON.parse(response.text));
        const expected = locations.filter(({ countryCode }) => countryCode === country).map(({ id }) => id).sort();
        if (file.countryCode !== country || Object.keys(file.locations).sort().join(",") !== expected.join(",")) throw new Error("Country catalog mismatch");
        if (Date.parse(file.generatedAt) > now.getTime() + MAX_FUTURE_SKEW_MS) throw new Error("Future publication time");
        if (now.getTime() - Date.parse(file.generatedAt) > CONDITIONS_PUBLICATION_GRACE_MS) overduePublications.push(country);
        const missingHealth = requiredInfrastructureHealth.filter((id) => sourceApplies(id, country) && !file.sourceHealth[id]);
        if (missingHealth.length) blockers.push({ code: "conditions_source_health_missing", message: `${country} is missing enabled infrastructure health: ${missingHealth.join(", ")}` });
        if (expectedSha) {
          if (file.producerCommitSha?.startsWith(expectedSha)) conditionsMetrics.releaseMatches += 1;
          else { conditionsMetrics.releaseMismatches += 1; releaseMismatches.push(country); }
        }
        conditionsMetrics.countries += 1; conditionsMetrics.locations += expected.length; conditionsMetrics.bytes += response.bytes;
        const countrySourceHealth = Object.entries(file.sourceHealth);
        for (const [sourceId, health] of countrySourceHealth) {
          const source = conditionSources[sourceId as keyof typeof conditionSources];
          if (!source.enabled || source.noncommercial && !noncommercial || !sourceApplies(sourceId as keyof typeof conditionSources, country)) {
            blockers.push({ code: "conditions_unauthorized_source", message: `${country}/${sourceId} exposes unauthorized source health` });
          } else if (health?.status === "failed" || health?.status === "partial") {
            const label = `${country}/${sourceId}:${health.status}`; failedConditionSources.push(label);
            if (now.getTime() - Date.parse(health.checkedAt) > CONDITIONS_PUBLICATION_GRACE_MS) persistentConditionSources.push(label);
          }
        }
        let available = 0;
        const unauthorized = new Set<string>();
        const reportedSources = new Set<string>();
        for (const [id, entry] of Object.entries(file.locations)) {
          if (seen.has(id)) throw new Error("Duplicate destination across countries"); seen.add(id);
          const records = conditionRecords(entry);
          for (const record of records) reportedSources.add(record.sourceId);
          for (const [source, mapped] of Object.entries(observationMappings)) if (mapped.includes(id)) {
            const matching = records.filter(({ sourceId }) => sourceId === source);
            const key = matching.some(({ expiresAt }) => Date.parse(expiresAt) > now.getTime()) ? "fresh" : matching.length ? "expired" : "absent";
            observationAvailability[source][key] += 1;
            observationAvailability[source].unknown -= 1;
          }
          conditionsMetrics.infrastructureIncidents += entry.infrastructureIncidents.length;
          conditionsMetrics.systemConditions += entry.systemConditions.length;
          for (const record of [...entry.infrastructureIncidents, ...entry.systemConditions]) {
            const expiry = Date.parse(record.expiresAt); const generated = Date.parse(file.generatedAt);
            if (expiry <= generated) invalidInfrastructureExpiry.push(`${country}/${id}/${record.id}`);
            else if (expiry <= now.getTime()) {
              const target = `${country}/${id}/${record.id}`;
              if (now.getTime() - generated <= CONDITIONS_PUBLICATION_GRACE_MS) pendingInfrastructureCleanup.push(target);
              else staleInfrastructure.push(target);
            }
          }
          const fresh = records.filter((record) => Date.parse(record.expiresAt) > now.getTime());
          if (fresh.length) available += 1;
          if (entry.weather && Date.parse(entry.weather.expiresAt) > now.getTime()) productLocations.weather.add(id);
          else if (entry.weather) expiredProductLocations.weather.add(id);
          if (entry.airQuality && Date.parse(entry.airQuality.expiresAt) > now.getTime()) productLocations.airQuality.add(id);
          else if (entry.airQuality) expiredProductLocations.airQuality.add(id);
          if (entry.marine && Date.parse(entry.marine.expiresAt) > now.getTime()) productLocations.marine.add(id);
          else if (entry.marine) expiredProductLocations.marine.add(id);
          for (const sourceId of new Set(fresh.map((record) => record.sourceId))) {
            const item = conditionsMetrics.bySource[sourceId] ||= { eligible: sourceId === "open-meteo-marine" ? marineEligibleLocationIds.size : sourceId.startsWith("open-meteo-") ? locations.length : 0,
              available: 0, health: { ok: 0, partial: 0, failed: 0, healthyEmpty: 0 } };
            item.available += 1;
          }
          for (const record of records) {
            const source = conditionSources[record.sourceId];
            if (!source.enabled || (source.noncommercial && !noncommercial) || !sourceApplies(record.sourceId, country)) unauthorized.add(record.sourceId);
          }
        }
        for (const [sourceId, health] of countrySourceHealth) {
          const item = conditionsMetrics.bySource[sourceId] ||= { eligible: 0, available: 0,
            health: { ok: 0, partial: 0, failed: 0, healthyEmpty: 0 } };
          if (health!.status === "ok") { item.health.ok += 1; if (!observationMappings[sourceId] && !["open-meteo-weather", "open-meteo-air", "open-meteo-marine", "met-norway"].includes(sourceId) && !reportedSources.has(sourceId)
            && now.getTime() - Date.parse(health!.checkedAt) <= CONDITIONS_PUBLICATION_GRACE_MS
            && now.getTime() - Date.parse(file.generatedAt) <= CONDITIONS_PUBLICATION_GRACE_MS) item.health.healthyEmpty += 1; }
          else if (health!.status === "partial") item.health.partial += 1;
          else if (health!.status === "failed") item.health.failed += 1;
        }
        conditionsMetrics.availableDestinations += available;
        for (const id of unauthorized) blockers.push({ code: "conditions_unauthorized_source", message: `${country}/${id} is not authorized for this deployment` });
        if (available < expected.length) incompleteAvailability.push(`${country} ${available}/${expected.length}`);
      } catch (error) {
        invalidConditions.push(`${country}: ${String(error).slice(0, 180)}`);
      }
    });
    if (invalidConditions.length) blockers.push({ code: "conditions_publication_invalid",
      message: `${invalidConditions.length}/${countryCount} conditions files are missing or invalid: ${boundedExamples(invalidConditions)}` });
    if (releaseMismatches.length) blockers.push({ code: "conditions_sha_mismatch",
      message: `${releaseMismatches.length}/${countryCount} conditions files do not match expected release ${expectedSha}: ${boundedExamples(releaseMismatches)}` });
    for (const [source, availability] of Object.entries(observationAvailability)) {
      if (availability.expired || availability.absent || availability.unknown) warnings.push({ code: "conditions_observation_gaps",
        message: `${source}: ${availability.fresh}/${availability.eligible} mapped destinations have fresh observations; ${availability.expired} expired, ${availability.absent} absent, ${availability.unknown} unknown (publication unavailable). Absence is not a healthy-empty incident feed.` });
    }
    if (incompleteAvailability.length) warnings.push({ code: "conditions_availability",
      message: `${conditionsMetrics.availableDestinations}/${locations.length} destinations have fresh local data; incomplete countries: ${boundedExamples(incompleteAvailability)}` });
    if (overduePublications.length) warnings.push({ code: "conditions_publication_overdue",
      message: `${overduePublications.length}/${countryCount} conditions files are older than the 75-minute publication grace: ${boundedExamples(overduePublications)}` });
    if (failedConditionSources.length) warnings.push({ code: "conditions_source_health",
      message: `${failedConditionSources.length} country/source updates are incomplete: ${boundedExamples(failedConditionSources)}` });
    if (persistentConditionSources.length) warnings.push({ code: "conditions_source_health_persistent",
      message: `${persistentConditionSources.length} country/source updates remain incomplete beyond the cadence grace: ${boundedExamples(persistentConditionSources)}` });
    conditionsMetrics.pendingExpiryCleanup = pendingInfrastructureCleanup.length;
    conditionsMetrics.overdueExpiredRecords = staleInfrastructure.length;
    if (invalidInfrastructureExpiry.length) blockers.push({ code: "conditions_record_expired_at_publication",
      message: `${invalidInfrastructureExpiry.length} infrastructure records were already expired when published: ${boundedExamples(invalidInfrastructureExpiry)}` });
    if (staleInfrastructure.length) warnings.push({ code: "conditions_stale_infrastructure",
      message: `${staleInfrastructure.length} expired infrastructure records remain published: ${boundedExamples(staleInfrastructure)}` });
    const productDefinitions = [
      { key: "weather" as const, label: "Weather", code: "conditions_weather_incomplete", eligible: locations.map(({ id }) => id) },
      { key: "airQuality" as const, label: "Modeled air quality", code: "conditions_air_quality_incomplete", eligible: locations.map(({ id }) => id) },
      { key: "marine" as const, label: "Marine forecast", code: "conditions_marine_incomplete", eligible: [...marineEligibleLocationIds] },
    ];
    for (const product of productDefinitions) {
      const missing = product.eligible.filter((id) => !productLocations[product.key].has(id));
      Object.assign(conditionsMetrics.byProduct[product.key], { available: product.eligible.length - missing.length, missing: missing.length });
      if (missing.length) {
        const expired = missing.filter((id) => expiredProductLocations[product.key].has(id));
        const absent = missing.filter((id) => !expiredProductLocations[product.key].has(id));
        warnings.push({ code: product.code,
          message: `${product.label} is fresh for ${product.eligible.length - missing.length}/${product.eligible.length} eligible destinations; ${expired.length} expired${expired.length ? ` (${boundedCountryExamples(expired)})` : ""}; ${absent.length} absent${absent.length ? ` (${boundedCountryExamples(absent)})` : ""}` });
      }
    }
    if (seen.size !== locations.length) blockers.push({ code: "conditions_catalog_incomplete", message: `Conditions union contains ${seen.size}/${locations.length} IDs` });
    if (conditionsMetrics.bytes > CONDITIONS_TOTAL_LIMIT) blockers.push({ code: "conditions_total_size", message: `Conditions total ${conditionsMetrics.bytes} bytes exceeds limit` });
  }

  ordered(blockers); ordered(warnings);
  return { status: blockers.length ? "blocked" : warnings.length ? "warning" : "ok", blockers, warnings, metrics };
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(["--origin", "--snapshot-url", "--expected-sha"]);
  for (let index = 0; index < args.length; index += 1) {
    if (!known.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    index += 1;
  }
  const report = await verifyProduction({
    origin: option(args, "--origin") || process.env.PRODUCTION_ORIGIN,
    snapshotUrl: option(args, "--snapshot-url") || process.env.PRODUCTION_SNAPSHOT_URL,
    expectedSha: option(args, "--expected-sha") || process.env.EXPECTED_COMMIT_SHA,
    expectLocalConditions: process.env.EXPECTED_LOCAL_CONDITIONS === "true",
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "blocked") process.exitCode = 1;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
