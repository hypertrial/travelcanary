import { catalogLocationsV3 } from "./catalog-data";
import { catalogV2Paths, catalogV2SnapshotUrl, catalogV3Paths, catalogV3SnapshotUrl } from "./catalog-paths";
import { locations as catalogLocationsV2 } from "./data";
import { ConditionsV3Schema, PublicCatalogV2Schema, PublicCatalogV3Schema, SnapshotV11Schema, type CatalogSnapshot, type PublicCatalogLocation } from "./domain/catalog-public";
import { catalogV2CountryCodes, catalogV3CountryCodes } from "./domain/contract-identities";
import { ConditionsSchema } from "./domain/conditions";
import { CompleteSnapshotSchema } from "./snapshot-validation";
import { expandedHazardCoverage, isExpandedDestination } from "./expanded-coverage";
import { expandedCheckIsCurrent } from "./expanded-source-health";
import { hazardAppliesToLocation } from "./risk-policy";
import { mapConcurrent, readBytesWithLimit } from "./ingestion/fetch";
import { nationalWarningManifest } from "./national-warning-sources";
import { CoverageMatrixSchema, type HazardType, type ProviderId } from "./domain/schemas";
import { providerRegistry } from "./provider-registry";
import coverageJson from "../../data/coverage.json";
import { catalog3CoverageTarget, coverageBreakdown, coverageMeetsCatalog3Target, emptyCoverageCounts } from "./coverage-measurement";

const SNAPSHOT_LIMIT = 500_000; const CATALOG_LIMIT = 256_000; const CONDITIONS_LIMIT = 512_000;
type HealthStatus = "ok" | "failed";
type PublicHealthOptions = { env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: Date; deadlineMs?: number };
type PublicPartition = { status: string; lastSuccess: string | null; nextExpectedUpdate: string | null; transports?: Array<{
  id: string; status: string; lastSuccess?: string | null; sourceUpdatedAt?: string | null; nextExpectedUpdate?: string | null;
}> };
const coverageMatrix = CoverageMatrixSchema.parse(coverageJson);

async function boundedJson(fetchImpl: typeof fetch, url: string, maxBytes: number, deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 100) throw new Error("deadline");
  const response = await fetchImpl(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(remaining) });
  if (!response.ok) throw new Error("unavailable");
  const bytes = await readBytesWithLimit(response, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function viable(
  value: { status: string; lastSuccess?: string | null; sourceUpdatedAt?: string | null; nextExpectedUpdate?: string | null },
  now: Date,
  cadenceMinutes: number | null,
) {
  if (!["ok", "partial", "failed", "delayed"].includes(value.status)) return false;
  if (!cadenceMinutes) return value.status === "ok" || value.status === "partial";
  if (!value.lastSuccess) return false;
  const expected = Date.parse(value.nextExpectedUpdate || "");
  const observed = Date.parse(value.lastSuccess || value.sourceUpdatedAt || "");
  const freshUntil = Number.isFinite(expected) ? expected + cadenceMinutes * 60_000
    : Number.isFinite(observed) ? observed + 2 * cadenceMinutes * 60_000 : 0;
  return freshUntil >= now.getTime();
}

function providerViable(snapshot: CatalogSnapshot, location: PublicCatalogLocation, hazard: HazardType, providerId: ProviderId, now: Date) {
  const definition = providerRegistry[providerId];
  if (!definition || definition.satisfiesCoverage === false || definition.mode === "disabled" || definition.mode === "discovery") return false;
  const provider = snapshot.providers[providerId];
  if (provider.partitions) {
    const partition = (provider.partitions as Record<string, PublicPartition>)[location.countryCode];
    if (!partition) return false;
    if (providerId === "national-civil-alerts") {
      const systems = nationalWarningManifest.countries[location.countryCode as keyof typeof nationalWarningManifest.countries]?.systems.filter((system) => (
        system.status === "active" && system.role === "coverage" && system.coverageContribution !== "none"
        && system.hazards.includes(hazard) && (!system.coverageLocationIds || system.coverageLocationIds.includes(location.id))
      )) || [];
      if (systems.length) return systems.some((system) => {
        const transport = partition.transports?.find(({ id }) => id === system.id);
        return Boolean(transport && viable({ ...transport,
          lastSuccess: transport.lastSuccess ?? partition.lastSuccess,
          nextExpectedUpdate: transport.nextExpectedUpdate ?? partition.nextExpectedUpdate,
        }, now, system.cadenceMinutes));
      });
    }
    return viable(partition, now, definition.cadenceMinutes);
  }
  if (isExpandedDestination(location)) {
    const receipt = "expandedCoverage" in provider ? provider.expandedCoverage : undefined;
    return expandedCheckIsCurrent(receipt, location.id, definition.cadenceMinutes, now);
  }
  return viable(provider, now, definition.cadenceMinutes);
}

export function requiredTransportFailures(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  const failed = new Set<string>();
  const national = snapshot.providers["national-civil-alerts"].partitions as Record<string, PublicPartition> | undefined;
  for (const [countryCode, country] of Object.entries(nationalWarningManifest.countries)) {
    const locations = catalog.filter((location) => location.countryCode === countryCode);
    if (!locations.length) continue;
    for (const system of country.systems.filter((candidate) => candidate.status === "active"
      && candidate.runtimeTarget === "national-civil-alerts" && candidate.role === "coverage" && candidate.coverageContribution !== "none")) {
      const applicable = locations.some((location) => (!system.coverageLocationIds || system.coverageLocationIds.includes(location.id))
        && system.hazards.some((hazard) => hazardAppliesToLocation(hazard, location)));
      if (!applicable) continue;
      const partition = national?.[countryCode];
      const transport = partition?.transports?.find(({ id }) => id === system.id);
      if (!transport || !viable({ ...transport, lastSuccess: transport.lastSuccess ?? partition?.lastSuccess ?? null,
        nextExpectedUpdate: transport.nextExpectedUpdate ?? partition?.nextExpectedUpdate ?? null }, now, system.cadenceMinutes)) {
        failed.add(`transport/${countryCode}/${system.id}`);
      }
    }
  }
  for (const location of catalog) {
    const country = (coverageMatrix.countries as Record<string, { hazards: Record<HazardType, { status: string; providerIds: ProviderId[] }> }>)[location.countryCode];
    const entries = isExpandedDestination(location) ? expandedHazardCoverage(location)
      : { ...country?.hazards, ...(coverageMatrix.locationOverrides[location.id] || {}) };
    for (const hazard of Object.keys(entries) as HazardType[]) {
      const entry = entries[hazard];
      if (!entry || entry.status === "not_monitored" || !hazardAppliesToLocation(hazard, location)) continue;
      const providers = entry.providerIds.filter((providerId) => providerRegistry[providerId]?.satisfiesCoverage !== false);
      if (!providers.length || !providers.some((providerId) => providerViable(snapshot, location, hazard, providerId, now))) {
        failed.add(`coverage/${location.countryCode}/${hazard}/${providers.slice().sort().join("+") || "no-viable-transport"}`);
      }
    }
  }
  return [...failed].sort();
}

function fixedPublicOrigin(env: Record<string, string | undefined>) {
  const configured = env.TRAVELCANARY_PUBLIC_ORIGIN || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  if (!configured) return "https://travelcanary.org";
  const url = new URL(/^https?:\/\//.test(configured) ? configured : `https://${configured}`);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid public origin");
  return url.origin;
}

export function coverageCounts(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  const measurement = coverageBreakdown(snapshot, catalog, now);
  return { ...measurement.totals, tiers: measurement.tiers };
}

export async function checkPublicHealth(options: PublicHealthOptions) {
  const env = options.env || process.env; const now = options.now || new Date(); const fetchImpl = options.fetch || fetch;
  const catalogVersion = env.NEXT_PUBLIC_CATALOG_VERSION === "3" ? 3 : 2;
  const paths = catalogVersion === 3 ? catalogV3Paths : catalogV2Paths;
  const expectedLocations = catalogVersion === 3 ? catalogLocationsV3.length : catalogLocationsV2.length;
  const countryCodes = catalogVersion === 3 ? catalogV3CountryCodes : catalogV2CountryCodes;
  const snapshotUrl = (catalogVersion === 3 ? catalogV3SnapshotUrl : catalogV2SnapshotUrl)(env.NEXT_PUBLIC_SNAPSHOT_URL);
  let publicOrigin = "";
  try { publicOrigin = fixedPublicOrigin(env); } catch { publicOrigin = ""; }
  const deadlineAt = Date.now() + (options.deadlineMs || 4_000);
  let snapshot: CatalogSnapshot | null = null; let catalog: PublicCatalogLocation[] | null = null;
  let snapshotStatus: HealthStatus = "failed"; let catalogStatus: HealthStatus = "failed"; let snapshotAgeMinutes = 0;
  if (snapshotUrl) {
    try {
      const value = await boundedJson(fetchImpl, snapshotUrl.href, SNAPSHOT_LIMIT, deadlineAt);
      snapshot = (catalogVersion === 3 ? SnapshotV11Schema : CompleteSnapshotSchema).parse(value);
      snapshotAgeMinutes = Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.generatedAt)) / 60_000));
      snapshotStatus = now.getTime() - Date.parse(snapshot.generatedAt) <= 120 * 60_000 && Date.parse(snapshot.generatedAt) <= now.getTime() + 5 * 60_000 ? "ok" : "failed";
    } catch { snapshotStatus = "failed"; }
  }
  try {
    if (!publicOrigin) throw new Error("invalid public origin");
    const value = await boundedJson(fetchImpl, new URL(paths.catalog, publicOrigin).href, CATALOG_LIMIT, deadlineAt);
    catalog = (catalogVersion === 3 ? PublicCatalogV3Schema : PublicCatalogV2Schema).parse(value);
    const snapshotIds = snapshot && Object.keys(snapshot.locations).sort(); const catalogIds = catalog.map(({ id }) => id).sort();
    catalogStatus = catalog.length === expectedLocations && (!snapshotIds || snapshotIds.join("\0") === catalogIds.join("\0")) ? "ok" : "failed";
  } catch { catalogStatus = "failed"; }

  const overdueCountryCodes: string[] = []; let present = 0; let releaseMismatch = false;
  if (snapshotUrl) await mapConcurrent([...countryCodes], 8, async (countryCode) => {
    try {
      const base = catalogVersion === 3 ? new URL("/", snapshotUrl) : snapshotUrl;
      const url = new URL(`${paths.conditions}${countryCode}.json`, base).href;
      const value = await boundedJson(fetchImpl, url, CONDITIONS_LIMIT, deadlineAt);
      const file = (catalogVersion === 3 ? ConditionsV3Schema : ConditionsSchema).parse(value);
      if (file.countryCode !== countryCode) throw new Error("conditions country mismatch");
      present += 1;
      if (now.getTime() - Date.parse(file.generatedAt) > 75 * 60_000 || Date.parse(file.generatedAt) > now.getTime() + 5 * 60_000) overdueCountryCodes.push(countryCode);
      const releaseSha = env.VERCEL_GIT_COMMIT_SHA || env.TRAVELCANARY_RELEASE_SHA;
      if (releaseSha && (!file.producerCommitSha || !file.producerCommitSha.startsWith(releaseSha.toLowerCase()))) releaseMismatch = true;
    } catch { overdueCountryCodes.push(countryCode); }
  });
  overdueCountryCodes.sort();
  const conditionsStatus: HealthStatus = present === countryCodes.length && !overdueCountryCodes.length && !releaseMismatch ? "ok" : "failed";
  const failed = snapshot && catalog ? requiredTransportFailures(snapshot, catalog, now) : ["snapshot/unavailable"];
  const transportStatus: HealthStatus = failed.length ? "failed" : "ok";
  const measurement = snapshot && catalog ? coverageBreakdown(snapshot, catalog, now) : null;
  const coverageStatus: HealthStatus = measurement && (catalogVersion !== 3 || coverageMeetsCatalog3Target(measurement)) ? "ok" : "failed";
  const status = [snapshotStatus, catalogStatus, conditionsStatus, transportStatus, coverageStatus].every((item) => item === "ok") ? "ok" : "degraded";
  const empty = emptyCoverageCounts();
  return {
    schemaVersion: 1 as const, status, runtime: "vercel" as const, catalogVersion, checkedAt: now.toISOString(),
    checks: {
      snapshot: { status: snapshotStatus, ageMinutes: snapshotAgeMinutes },
      catalog: { status: catalogStatus, expectedLocations, actualLocations: catalog?.length || 0 },
      conditions: { status: conditionsStatus, expected: countryCodes.length, present, overdueCountryCodes },
      transports: { status: transportStatus, failed },
      coverage: { status: coverageStatus, minimums: catalogVersion === 3 ? catalog3CoverageTarget : null },
    },
    coverage: measurement ? { ...measurement.totals, tiers: measurement.tiers } : { ...empty, tiers: { lifeSafety: { ...empty } } },
  };
}
