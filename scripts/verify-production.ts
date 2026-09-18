import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogLocationsV3 } from "../src/lib/catalog-data";
import { catalog3CoverageTarget, coverageMeetsCatalog3Target } from "../src/lib/coverage-measurement";
import { ConditionsV3Schema, SnapshotV11Schema } from "../src/lib/domain/catalog-public";
import { mapConcurrent } from "../src/lib/ingestion/fetch";
import { nationalWarningManifest } from "../src/lib/national-warning-sources";
import { HttpPublicationStore, requiredTransportFailures } from "../src/lib/public-health";
import { publicationSha256, readCurrentPublication, readPublishedObject } from "../src/lib/publication-store";
import { measureCoverage } from "./coverage-measurement";

type Finding = { code: string; message: string };
type VerifyProductionOptions = {
  origin?: string;
  publicationUrl?: string;
  snapshotUrl?: string;
  expectedSha?: string;
  expectedCatalogVersion?: 3;
  expectLocalConditions?: boolean;
  fetch?: typeof fetch;
  now?: Date;
};

export type ProductionVerificationReport = {
  status: "ok" | "warning" | "blocked";
  blockers: Finding[];
  warnings: Finding[];
  metrics: {
    origin: string;
    releaseSha: string | null;
    publicationUrl: string | null;
    manifestSha256: string | null;
    catalogVersion: 3 | null;
    generatedAt: string | null;
    locations: number | null;
    conditionsCountries: number | null;
    coverageMeasurement?: ReturnType<typeof measureCoverage>;
  };
};

function normalizeOrigin(value: string) {
  const url = new URL(value); const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Production origin must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("Production origin must not contain credentials, query, or fragment");
  return url.origin;
}

function pointerUrl(value: string, base?: string) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Publication URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/catalogs/3/publication/latest.json")) {
    throw new Error("Publication URL is not a Catalog 3 pointer");
  }
  return url.href;
}

async function discoverPointer(origin: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${origin}/api/v1/data`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Data endpoint redirect is missing a location");
    return pointerUrl(location, origin);
  }
  if (!response.ok) throw new Error(`Data endpoint returned HTTP ${response.status}`);
  return pointerUrl(response.url || `${origin}/api/v1/data`);
}

function activeUnauthorizedTransports(snapshot: ReturnType<typeof SnapshotV11Schema.parse>) {
  const failures: string[] = [];
  for (const [providerId, provider] of Object.entries(snapshot.providers)) {
    if (!provider.partitions) continue;
    for (const [country, partition] of Object.entries(provider.partitions)) {
      for (const transport of partition.transports || []) {
        if (!["ok", "partial", "failed", "delayed"].includes(transport.status)) continue;
        const systems = nationalWarningManifest.countries[country as keyof typeof nationalWarningManifest.countries]?.systems || [];
        const allowedTargets = providerId === "meteoalarm" ? ["meteoalarm-primary", "meteoalarm-fallback"] : ["national-civil-alerts"];
        const allowed = systems.some((system) => system.id === transport.id
          && ["active", "credential_gated"].includes(system.status)
          && allowedTargets.includes(system.runtimeTarget));
        if (!allowed) failures.push(`${country}/${transport.id}`);
      }
    }
  }
  return failures.sort();
}

const ordered = (items: Finding[]) => items.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));

export async function verifyProduction(options: VerifyProductionOptions = {}): Promise<ProductionVerificationReport> {
  const blockers: Finding[] = []; const warnings: Finding[] = []; const fetchImpl = options.fetch || fetch; const now = options.now || new Date();
  let origin = options.origin || "https://travelcanary.org";
  try { origin = normalizeOrigin(origin); } catch (error) {
    blockers.push({ code: "origin_invalid", message: error instanceof Error ? error.message : "Production origin is invalid" });
  }
  const metrics: ProductionVerificationReport["metrics"] = { origin, releaseSha: null, publicationUrl: null,
    manifestSha256: null, catalogVersion: null, generatedAt: null, locations: null, conditionsCountries: null };
  if (options.expectedCatalogVersion !== undefined && options.expectedCatalogVersion !== 3) {
    blockers.push({ code: "catalog_version_unexpected", message: "Only Catalog 3 is supported" });
  }
  const expectedSha = options.expectedSha?.trim().toLowerCase();
  if (expectedSha && !/^[a-f0-9]{7,40}$/.test(expectedSha)) blockers.push({ code: "expected_sha_invalid", message: "Expected SHA must contain 7 to 40 hexadecimal characters" });
  if (blockers.length) return { status: "blocked", blockers: ordered(blockers), warnings, metrics };

  let publicationUrl: string;
  try {
    publicationUrl = pointerUrl(options.publicationUrl || options.snapshotUrl || await discoverPointer(origin, fetchImpl), origin);
    metrics.publicationUrl = publicationUrl;
  } catch (error) {
    blockers.push({ code: "publication_discovery_failed", message: error instanceof Error ? error.message : "Publication discovery failed" });
    return { status: "blocked", blockers, warnings, metrics };
  }

  try {
    const store = new HttpPublicationStore(publicationUrl, fetchImpl);
    const current = await readCurrentPublication(store);
    if (!current) throw new Error("Publication pointer is missing");
    metrics.releaseSha = current.pointer.producerCommitSha;
    metrics.manifestSha256 = current.pointer.manifestSha256;
    metrics.catalogVersion = 3;
    metrics.generatedAt = current.manifest.generatedAt;
    if (current.manifest.coverageContractHash !== publicationSha256(JSON.stringify(catalog3CoverageTarget))) {
      blockers.push({ code: "coverage_contract_mismatch", message: "Publication coverage contract does not match this release" });
    }
    if (expectedSha && (!current.pointer.producerCommitSha || !current.pointer.producerCommitSha.startsWith(expectedSha))) {
      blockers.push({ code: "release_sha_mismatch", message: "Publication producer does not match the expected release" });
    }
    const snapshot = SnapshotV11Schema.parse(JSON.parse(await readPublishedObject(store, current.manifest.snapshot)));
    const expectedIds = catalogLocationsV3.map(({ id }) => id).sort(); const actualIds = Object.keys(snapshot.locations).sort();
    metrics.locations = actualIds.length;
    if (actualIds.length !== 679 || actualIds.join("\0") !== expectedIds.join("\0")) blockers.push({ code: "catalog_membership_mismatch", message: `Snapshot contains ${actualIds.length}/679 expected destinations` });
    const conditions = await mapConcurrent(current.manifest.conditions, 8, async (reference) => {
      const file = ConditionsV3Schema.parse(JSON.parse(await readPublishedObject(store, reference)));
      const expected = catalogLocationsV3.filter(({ countryCode }) => countryCode === reference.countryCode).map(({ id }) => id).sort();
      if (file.countryCode !== reference.countryCode || Object.keys(file.locations).sort().join("\0") !== expected.join("\0")) throw new Error(`${reference.countryCode} membership mismatch`);
      if (file.producerCommitSha !== current.manifest.producerCommitSha) throw new Error(`${reference.countryCode} producer mismatch`);
      if (now.getTime() - Date.parse(file.generatedAt) > 75 * 60_000 || Date.parse(file.generatedAt) > now.getTime() + 5 * 60_000) throw new Error(`${reference.countryCode} publication is stale`);
      return file;
    });
    metrics.conditionsCountries = conditions.length;
    if (conditions.length !== 45) blockers.push({ code: "conditions_incomplete", message: `Manifest contains ${conditions.length}/45 country payloads` });
    const age = now.getTime() - Date.parse(snapshot.generatedAt);
    if (age > 120 * 60_000 || age < -5 * 60_000) blockers.push({ code: "snapshot_stale", message: "Snapshot freshness is outside the release contract" });
    metrics.coverageMeasurement = measureCoverage(snapshot, catalogLocationsV3, now);
    if (!coverageMeetsCatalog3Target(metrics.coverageMeasurement)) blockers.push({ code: "coverage_capability_regression", message: "Catalog 3 coverage is below the release floors" });
    const transports = requiredTransportFailures(snapshot, catalogLocationsV3, now);
    if (transports.length) warnings.push({ code: "source_degradation", message: `${transports.length} reviewed coverage paths are currently degraded` });
    const unauthorized = activeUnauthorizedTransports(snapshot);
    if (unauthorized.length) blockers.push({ code: "unauthorized_transport_active", message: `Unauthorized runtime transports: ${unauthorized.slice(0, 8).join(", ")}` });
  } catch (error) {
    blockers.push({ code: "publication_invalid", message: error instanceof Error ? error.message.slice(0, 240) : "Publication validation failed" });
  }

  for (const [path, code] of [["/api/healthz", "liveness_failed"], ["/api/v1/health", "health_failed"]] as const) {
    try {
      const response = await fetchImpl(`${origin}${path}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) blockers.push({ code, message: `${path} returned HTTP ${response.status}` });
      else if (path.endsWith("/health")) {
        const body = await response.json() as { status?: unknown; available?: unknown; publication?: { manifestSha256?: unknown; producerCommitSha?: unknown } };
        if (body.available !== true) blockers.push({ code, message: "Public health does not report an available generation" });
        else if (body.publication?.manifestSha256 !== metrics.manifestSha256 || body.publication?.producerCommitSha !== metrics.releaseSha) {
          blockers.push({ code, message: "Public health reports a different publication generation" });
        }
        else if (body.status === "degraded") warnings.push({ code: "health_degraded", message: "Public health is degraded but the generation remains servable" });
      }
    } catch { blockers.push({ code, message: `${path} could not be verified` }); }
  }

  ordered(blockers); ordered(warnings);
  return { status: blockers.length ? "blocked" : warnings.length ? "warning" : "ok", blockers, warnings, metrics };
}

function option(args: string[], name: string) {
  const index = args.indexOf(name); if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2); const known = new Set(["--origin", "--publication-url", "--snapshot-url", "--expected-sha", "--expected-catalog-version"]);
  for (let index = 0; index < args.length; index += 2) if (!known.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${args[index]}`);
  const expected = option(args, "--expected-catalog-version") || process.env.EXPECTED_CATALOG_VERSION;
  if (expected && expected !== "3") throw new Error("Expected catalog version must be 3");
  const report = await verifyProduction({ origin: option(args, "--origin") || process.env.PRODUCTION_ORIGIN,
    publicationUrl: option(args, "--publication-url") || option(args, "--snapshot-url") || process.env.PRODUCTION_PUBLICATION_URL || process.env.PRODUCTION_SNAPSHOT_URL,
    expectedSha: option(args, "--expected-sha") || process.env.EXPECTED_COMMIT_SHA,
    expectedCatalogVersion: expected ? 3 : undefined });
  console.log(JSON.stringify(report, null, 2)); if (report.status === "blocked") process.exitCode = 1;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
