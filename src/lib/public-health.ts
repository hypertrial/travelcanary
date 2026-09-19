import { resolve } from "node:path";
import { catalogLocationsV3 } from "./catalog-data";
import { catalogMembershipHash } from "./catalog-membership";
import { coverageBreakdown, coverageMeetsCatalog3Target, catalog3CoverageTarget, emptyCoverageCounts } from "./coverage-measurement";
import { ConditionsV3Schema, SnapshotV11Schema, type CatalogSnapshot, type PublicCatalogLocation } from "./domain/catalog-public";
import { catalogV3CountryCodes } from "./domain/contract-identities";
import { publicationPointerPath } from "./domain/publication";
import { mapConcurrent, readBytesWithLimit } from "./ingestion/fetch";
import { FilePublicationStore, publicationSha256, readCurrentPublication, readPublishedObject, type PublicationStore } from "./publication-store";
import { expandedHazardCoverage, isExpandedDestination } from "./expanded-coverage";
import { expandedCheckIsCurrent } from "./expanded-source-health";
import { hazardAppliesToLocation, lifeSafetyHazards } from "./risk-policy";
import { nationalWarningManifest } from "./national-warning-sources";
import { CoverageMatrixSchema, type HazardType, type ProviderId } from "./domain/schemas";
import { providerRegistry } from "./provider-registry";
import coverageJson from "../../data/coverage.json";

type PublicPartition = { status: string; lastSuccess: string | null; nextExpectedUpdate: string | null; transports?: Array<{
  id: string; status: string; lastSuccess?: string | null; sourceUpdatedAt?: string | null; nextExpectedUpdate?: string | null;
}> };
const coverageMatrix = CoverageMatrixSchema.parse(coverageJson);

function viable(value: { status: string; lastSuccess?: string | null; sourceUpdatedAt?: string | null; nextExpectedUpdate?: string | null },
  now: Date, cadenceMinutes: number | null, strictCurrentStatus = false) {
  if (!["ok", "partial", "failed", "delayed"].includes(value.status)) return false;
  if (strictCurrentStatus && !["ok", "partial"].includes(value.status)) return false;
  if (!cadenceMinutes) return value.status === "ok" || value.status === "partial";
  if (!value.lastSuccess) return false;
  const expected = Date.parse(value.nextExpectedUpdate || "");
  const observed = Date.parse(value.lastSuccess || value.sourceUpdatedAt || "");
  const freshUntil = Number.isFinite(expected) ? expected + cadenceMinutes * 60_000
    : Number.isFinite(observed) ? observed + 2 * cadenceMinutes * 60_000 : 0;
  return freshUntil >= now.getTime();
}

function providerViable(snapshot: CatalogSnapshot, location: PublicCatalogLocation, hazard: HazardType, providerId: ProviderId, now: Date,
  strictCurrentStatus = false) {
  const definition = providerRegistry[providerId];
  if (!definition || definition.satisfiesCoverage === false || definition.healthScope === "non_blocking"
    || definition.mode === "disabled" || definition.mode === "discovery") return false;
  const provider = snapshot.providers[providerId];
  if (isExpandedDestination(location) && "expandedCoverage" in provider && provider.expandedCoverage) {
    const receipt = provider.expandedCoverage;
    return (!strictCurrentStatus || receipt.status === "ok" || receipt.status === "partial")
      && expandedCheckIsCurrent(receipt, location.id, definition.cadenceMinutes, now);
  }
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
        return Boolean(transport && viable({ ...transport, lastSuccess: transport.lastSuccess ?? partition.lastSuccess,
          nextExpectedUpdate: transport.nextExpectedUpdate ?? partition.nextExpectedUpdate }, now, system.cadenceMinutes, strictCurrentStatus));
      });
    }
    return viable(partition, now, definition.cadenceMinutes, strictCurrentStatus);
  }
  if (isExpandedDestination(location)) {
    const receipt = "expandedCoverage" in provider ? provider.expandedCoverage : undefined;
    return (!strictCurrentStatus || receipt?.status === "ok" || receipt?.status === "partial")
      && expandedCheckIsCurrent(receipt, location.id, definition.cadenceMinutes, now);
  }
  return viable(provider, now, definition.cadenceMinutes, strictCurrentStatus);
}

function providerIsRequired(location: PublicCatalogLocation, hazard: HazardType, providerId: ProviderId) {
  const definition = providerRegistry[providerId];
  if (!definition || definition.satisfiesCoverage === false || definition.healthScope === "non_blocking") return false;
  if (providerId !== "national-civil-alerts") return true;
  return Boolean(nationalWarningManifest.countries[location.countryCode as keyof typeof nationalWarningManifest.countries]?.systems.some((system) => (
    system.status === "active" && system.runtimeTarget === "national-civil-alerts" && system.role === "coverage"
    && system.coverageContribution !== "none" && system.hazards.includes(hazard)
    && (!system.coverageLocationIds || system.coverageLocationIds.includes(location.id))
  )));
}

export function requiredTransportFailures(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date,
  includedHazards?: ReadonlySet<HazardType>, strictCurrentStatus = false) {
  const failed = new Set<string>();
  const national = snapshot.providers["national-civil-alerts"].partitions as Record<string, PublicPartition> | undefined;
  for (const [countryCode, country] of Object.entries(nationalWarningManifest.countries)) {
    const locations = catalog.filter((location) => location.countryCode === countryCode);
    if (!locations.length) continue;
    for (const system of country.systems.filter((candidate) => candidate.status === "active"
      && candidate.runtimeTarget === "national-civil-alerts" && candidate.role === "coverage" && candidate.coverageContribution !== "none")) {
      const applicable = locations.some((location) => (!system.coverageLocationIds || system.coverageLocationIds.includes(location.id))
        && system.hazards.some((hazard) => (!includedHazards || includedHazards.has(hazard)) && hazardAppliesToLocation(hazard, location)));
      if (!applicable) continue;
      const partition = national?.[countryCode];
      const transport = partition?.transports?.find(({ id }) => id === system.id);
      if (!strictCurrentStatus && (!transport || !viable({ ...transport, lastSuccess: transport.lastSuccess ?? partition?.lastSuccess ?? null,
        nextExpectedUpdate: transport.nextExpectedUpdate ?? partition?.nextExpectedUpdate ?? null }, now, system.cadenceMinutes))) {
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
      if (!entry || entry.status === "not_monitored" || (includedHazards && !includedHazards.has(hazard))
        || !hazardAppliesToLocation(hazard, location)) continue;
      const providers = entry.providerIds.filter((providerId) => providerIsRequired(location, hazard, providerId));
      if (!providers.length) continue;
      if (!providers.some((providerId) => providerViable(snapshot, location, hazard, providerId, now, strictCurrentStatus))) {
        failed.add(`coverage/${location.countryCode}/${hazard}/${providers.slice().sort().join("+") || "no-viable-transport"}`);
      }
    }
  }
  return [...failed].sort();
}

export function requiredLifeSafetyTransportFailures(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  return requiredTransportFailures(snapshot, catalog, now, lifeSafetyHazards, true);
}

export function coverageCounts(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  const measurement = coverageBreakdown(snapshot, catalog, now);
  return { ...measurement.totals, tiers: measurement.tiers };
}

export class HttpPublicationStore implements PublicationStore {
  private readonly root: URL;
  constructor(pointerUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    const pointer = new URL(pointerUrl);
    if (pointer.protocol !== "https:" || pointer.username || pointer.password || pointer.search || pointer.hash
      || !pointer.pathname.endsWith(`/${publicationPointerPath}`)) throw new Error("Invalid publication pointer URL");
    pointer.pathname = pointer.pathname.slice(0, -publicationPointerPath.length); pointer.search = "";
    this.root = pointer;
  }
  async read(pathname: string, maxBytes: number) {
    if (!/^catalogs\/3\/(?:publication\/latest\.json|generations\/[a-f0-9]{64}\/manifest\.json|objects\/sha256\/[a-f0-9]{64}\.json)$/.test(pathname)) {
      throw new Error("Publication object path is invalid");
    }
    const url = new URL(pathname, this.root);
    const response = await this.fetchImpl(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(4_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Publication object is unavailable");
    const body = new TextDecoder().decode(await readBytesWithLimit(response, maxBytes));
    return { body, etag: response.headers.get("etag")?.replace(/^W\//, "") || "", url: url.href };
  }
  putImmutable(): Promise<never> { throw new Error("HTTP publication store is read-only"); }
  replacePointer(): Promise<never> { throw new Error("HTTP publication store is read-only"); }
  list(): Promise<never> { throw new Error("HTTP publication store cannot list"); }
  deleteMany(): Promise<never> { throw new Error("HTTP publication store is read-only"); }
}

export function unavailablePublicationHealth(now = new Date(), runtime: "vercel" | "filesystem" = "vercel", code = "publication_invalid") {
  const empty = emptyCoverageCounts();
  return {
    schemaVersion: 1 as const, status: "degraded" as const, available: false, runtime,
    catalogVersion: 3 as const, checkedAt: now.toISOString(), publication: { status: "failed" as const, code },
    checks: { snapshot: { status: "failed" as const, ageMinutes: 0 }, catalog: { status: "failed" as const, expectedLocations: 679, actualLocations: 0 },
      conditions: { status: "failed" as const, expected: 45, present: 0, overdueCountryCodes: [...catalogV3CountryCodes] },
      transports: { status: "failed" as const, failed: ["publication/unavailable"] }, coverage: { status: "failed" as const, minimums: catalog3CoverageTarget } },
    coverage: { ...empty, tiers: { lifeSafety: { ...empty } } },
  };
}

export async function checkPublicationHealth(store: PublicationStore, options: {
  now?: Date; expectedSha?: string; runtime?: "vercel" | "filesystem"; allowStale?: boolean;
} = {}) {
  const now = options.now || new Date();
  const unavailable = (code: string) => unavailablePublicationHealth(now, options.runtime || "vercel", code);
  try {
    const current = await readCurrentPublication(store);
    if (!current) return unavailable("pointer_missing");
    const snapshotBody = await readPublishedObject(store, current.manifest.snapshot);
    const snapshot = SnapshotV11Schema.parse(JSON.parse(snapshotBody));
    const snapshotIds = Object.keys(snapshot.locations).sort();
    const expectedIds = catalogLocationsV3.map(({ id }) => id).sort();
    if (snapshotIds.length !== expectedIds.length || snapshotIds.join("\0") !== expectedIds.join("\0")
      || catalogMembershipHash(snapshotIds) !== current.manifest.membershipHash) return unavailable("membership_mismatch");
    if (current.manifest.coverageContractHash !== publicationSha256(JSON.stringify(catalog3CoverageTarget))) return unavailable("coverage_contract_mismatch");
    const producer = options.expectedSha?.trim().toLowerCase();
    if (producer && (!current.manifest.producerCommitSha || !current.manifest.producerCommitSha.startsWith(producer))) return unavailable("producer_mismatch");
    const overdueCountryCodes: string[] = []; let present = 0;
    await mapConcurrent(current.manifest.conditions, 8, async (reference) => {
      const body = await readPublishedObject(store, reference);
      const file = ConditionsV3Schema.parse(JSON.parse(body));
      if (file.countryCode !== reference.countryCode || file.producerCommitSha !== current.manifest.producerCommitSha) throw new Error("Conditions identity mismatch");
      const expected = catalogLocationsV3.filter(({ countryCode }) => countryCode === reference.countryCode).map(({ id }) => id).sort();
      if (Object.keys(file.locations).sort().join("\0") !== expected.join("\0")) throw new Error("Conditions membership mismatch");
      present += 1;
      const generated = Date.parse(file.generatedAt);
      if (!options.allowStale && (now.getTime() - generated > 75 * 60_000 || generated > now.getTime() + 5 * 60_000)) {
        overdueCountryCodes.push(file.countryCode);
      }
    });
    const snapshotAgeMinutes = Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.generatedAt)) / 60_000));
    if ((!options.allowStale && (snapshotAgeMinutes > 120 || Date.parse(snapshot.generatedAt) > now.getTime() + 5 * 60_000))
      || present !== catalogV3CountryCodes.length || overdueCountryCodes.length) return unavailable("publication_stale_or_incomplete");
    const failedTransports = requiredTransportFailures(snapshot, catalogLocationsV3, now);
    const measurement = coverageBreakdown(snapshot, catalogLocationsV3, now);
    const coverageOk = coverageMeetsCatalog3Target(measurement);
    const collectorDelayed = current.manifest.status.collectorLastSuccess
      ? now.getTime() - Date.parse(current.manifest.status.collectorLastSuccess) > 75 * 60_000 : true;
    const degraded = current.manifest.status.state === "degraded" || failedTransports.length > 0 || !coverageOk || collectorDelayed;
    return {
      schemaVersion: 1 as const, status: degraded ? "degraded" as const : "ok" as const, available: true,
      runtime: options.runtime || "vercel" as const, catalogVersion: 3 as const, checkedAt: now.toISOString(),
      publication: { status: "ok" as const, manifestSha256: current.pointer.manifestSha256, publishedAt: current.pointer.publishedAt,
        producerCommitSha: current.pointer.producerCommitSha, stateRevision: current.pointer.stateRevision,
        collectionRevision: current.pointer.collectionRevision, ingestionFence: current.pointer.ingestionFence },
      checks: {
        snapshot: { status: "ok" as const, ageMinutes: snapshotAgeMinutes },
        catalog: { status: "ok" as const, expectedLocations: 679, actualLocations: snapshotIds.length },
        conditions: { status: "ok" as const, expected: 45, present, overdueCountryCodes },
        transports: { status: failedTransports.length ? "failed" as const : "ok" as const, failed: failedTransports },
        coverage: { status: coverageOk ? "ok" as const : "failed" as const, minimums: catalog3CoverageTarget },
      },
      coverage: { ...measurement.totals, tiers: measurement.tiers },
    };
  } catch { return unavailable("publication_invalid"); }
}

export async function checkPublicHealth(options: { env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: Date } = {}) {
  const env = options.env || process.env;
  if (env.VERCEL_ENV !== "production") {
    return checkPublicationHealth(new FilePublicationStore(resolve(process.cwd(), "public")), {
      now: options.now, runtime: "filesystem", allowStale: true,
    });
  }
  const url = env.TRAVELCANARY_PUBLICATION_URL;
  if (!url) return checkPublicationHealth({ read: async () => null } as unknown as PublicationStore, { now: options.now });
  try {
    return await checkPublicationHealth(new HttpPublicationStore(url, options.fetch), { now: options.now,
      expectedSha: env.TRAVELCANARY_RELEASE_SHA || env.VERCEL_GIT_COMMIT_SHA, runtime: "vercel" });
  } catch {
    return checkPublicationHealth({ read: async () => null } as unknown as PublicationStore, { now: options.now });
  }
}
