import { describe, expect, it, vi } from "vitest";
import { publishCommittedCatalog } from "@/lib/catalog-publication";
import { acquireIngestionLease } from "@/lib/ingestion-lease";
import { publicationPointerPath } from "@/lib/domain/publication";
import { createEmptyState } from "@/lib/risk-state";
import { MemoryStateStore } from "@/lib/state-store";
import { readCurrentPublication } from "@/lib/publication-store";
import { verifyProduction } from "../../scripts/verify-production";
import { MemoryPublicationStore } from "../helpers/publication";
import { expandedReceiptLocationIds } from "@/lib/domain/catalog-state";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { requiredLifeSafetyTransportFailures } from "@/lib/public-health";
import type { IngestionState } from "@/lib/domain/catalog-state";
import { expandedProviderApplies } from "@/lib/expanded-coverage";

const origin = "https://travelcanary.test";
const blobOrigin = "https://unit.public.blob.vercel-storage.com";
const pointer = `${blobOrigin}/${publicationPointerPath}`;
const now = new Date("2026-09-18T06:00:00.000Z");
const sha = "a".repeat(40);

async function fixture(healthy = true, mutate?: (state: IngestionState) => void,
  env: Record<string, string | undefined> = { VERCEL_GIT_COMMIT_SHA: sha }) {
  const state = createEmptyState(now);
  const health = { status: "ok" as const, lastAttempt: now.toISOString(), lastSuccess: now.toISOString(),
    sourceUpdatedAt: now.toISOString(), nextExpectedUpdate: now.toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };
  if (healthy) {
    for (const source of Object.values(state.sources)) if (source.status !== "not_monitored") Object.assign(source, health);
    for (const partitions of Object.values(state.sourcePartitions)) {
      for (const partition of Object.values(partitions)) if (partition.status !== "not_monitored") Object.assign(partition, health);
    }
    for (const partitions of Object.values(state.partitionTransports)) {
      for (const transports of Object.values(partitions)) {
        for (const transport of Object.values(transports)) if (transport.status !== "not_monitored") Object.assign(transport, health);
      }
    }
    for (const source of Object.keys(expandedReceiptLocationIds) as Array<keyof typeof expandedReceiptLocationIds>) {
      state.expandedSourceHealth[source] = { health: { ...health }, checkedLocationIds: [...expandedReceiptLocationIds[source]], unavailableLocationIds: [] };
    }
    expect(requiredLifeSafetyTransportFailures(buildCatalog3Snapshot(state, now), catalogLocationsV3, now)).toEqual([]);
  }
  mutate?.(state);
  const stateStore = new MemoryStateStore(state); const publicationStore = new MemoryPublicationStore();
  const lease = await acquireIngestionLease(stateStore, "production-verifier-test", now, 330_000);
  if (!lease) throw new Error("lease unavailable");
  await publishCommittedCatalog({ stateStore, stores: { publicationStore }, collection: { catalogVersion: 3, revision: 1 }, lease,
    now, family: "all", env: { VERCEL_GIT_COMMIT_SHA: sha, ...env } });
  const current = await readCurrentPublication(publicationStore);
  if (!current) throw new Error("publication unavailable");
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.href === `${origin}/api/v1/data`) return new Response(null, { status: 307, headers: { location: pointer } });
    if (url.href === `${origin}/api/healthz`) return Response.json({ status: "ok" });
    if (url.href === `${origin}/api/v1/health`) return Response.json({ schemaVersion: 1, status: "degraded", available: true,
      publication: { manifestSha256: current.pointer.manifestSha256, producerCommitSha: current.pointer.producerCommitSha } });
    if (url.origin === blobOrigin) {
      const object = await publicationStore.read(url.pathname.slice(1), 2_000_000);
      return object ? new Response(object.body, { headers: { etag: object.etag } }) : new Response("missing", { status: 404 });
    }
    return new Response("missing", { status: 404 });
  });
  return { publicationStore, fetch, verify: (options: Parameters<typeof verifyProduction>[0] = {}) => verifyProduction({ origin, now, expectedSha: sha,
    expectedCatalogVersion: 3, fetch, ...options }) };
}

describe("atomic Catalog 3 production verification", () => {
  it("validates the exact release, pointer, 679 destinations, 45 conditions files, health, and coverage floors", async () => {
    const f = await fixture(); const report = await f.verify();
    expect(report.blockers).toEqual([]);
    expect(report.status).toBe("warning");
    expect(report.metrics).toMatchObject({ releaseSha: sha, publicationUrl: pointer, catalogVersion: 3, locations: 679, conditionsCountries: 45,
      coverageMeasurement: { totals: { applicable: 11_799, fullyChecked: 2_867, partlyChecked: 2_877, notChecked: 6_055 },
        tiers: { lifeSafety: { applicable: 7_237, fullyChecked: 2_853, partlyChecked: 2_226, notChecked: 2_158 } } } });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "health_degraded" }));
  });

  it("blocks a missing immutable object and an unexpected release SHA", async () => {
    const missing = await fixture();
    const pointerObject = await missing.publicationStore.read(publicationPointerPath, 64_000);
    const pointerValue = JSON.parse(pointerObject!.body);
    const manifestObject = await missing.publicationStore.read(pointerValue.manifestPath, 512_000);
    const manifest = JSON.parse(manifestObject!.body);
    missing.publicationStore.remove(manifest.conditions[0].path);
    expect((await missing.verify()).blockers).toContainEqual(expect.objectContaining({ code: "publication_invalid" }));

    const wrong = await fixture();
    expect((await wrong.verify({ expectedSha: "b".repeat(40) })).blockers).toContainEqual(expect.objectContaining({ code: "release_sha_mismatch" }));

    const unreachable = await fixture();
    const previous = unreachable.fetch.getMockImplementation();
    unreachable.fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input)).origin === blobOrigin) throw new Error("secret-sentinel");
      return previous!(input, init);
    });
    const report = await unreachable.verify();
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "publication_unreachable" }));
    expect(JSON.stringify(report.blockers)).not.toContain("secret-sentinel");
  });

  it("blocks stale condition publications and unavailable public health", async () => {
    const stale = await fixture();
    expect((await stale.verify({ now: new Date(now.getTime() + 76 * 60_000) })).blockers)
      .toContainEqual(expect.objectContaining({ code: "publication_invalid" }));

    const unhealthy = await fixture();
    unhealthy.fetch.mockImplementationOnce(async () => new Response(null, { status: 307, headers: { location: pointer } }));
    const base = unhealthy.fetch.getMockImplementation()!;
    unhealthy.fetch.mockImplementation(async (input, init) => String(input) === `${origin}/api/v1/health`
      ? Response.json({ available: false, status: "degraded" }, { status: 503 }) : base(input, init));
    expect((await unhealthy.verify()).blockers).toContainEqual(expect.objectContaining({ code: "health_failed" }));
  });

  it("blocks delayed required life-safety monitoring while leaving other source degradation as warnings", async () => {
    const delayed = await fixture(false);
    const report = await delayed.verify();
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "life_safety_monitoring_delayed" }));
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "source_degradation" }));
  });

  it("blocks a currently delayed life-safety source even when its last success is recent", async () => {
    const delayed = await fixture(true, (state) => {
      Object.assign(state.sources.usgs, { status: "delayed", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(),
        nextExpectedUpdate: now.toISOString(), consecutiveFailures: 1, error: "timeout" });
    });
    expect((await delayed.verify()).blockers).toContainEqual(expect.objectContaining({ code: "life_safety_monitoring_delayed" }));
  });

  it("warns when a reviewed conditions source is incomplete without blocking a complete publication", async () => {
    const degraded = await fixture(true, (state) => {
      state.conditions.health["awc-metar"] = { checkedAt: now.toISOString(), status: "failed", matched: 0, code: "source_unavailable" };
    }, { VERCEL_GIT_COMMIT_SHA: sha, LOCAL_CONDITIONS_ENABLED: "true" });
    const report = await degraded.verify();
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "conditions_source_degradation", message: expect.stringContaining("awc-metar") }));
  });

  it("blocks a location-scoped Catalog 3 MeteoAlarm receipt gap even when its country partition is fresh", async () => {
    const scope = catalogLocationsV3.filter((location) => expandedProviderApplies("meteoalarm", location)).map(({ id }) => id);
    const unavailableId = scope.find((id) => id.startsWith("is-"))!;
    const partial = await fixture(true, (state) => {
      state.collectionReceipts[3].meteoalarm = { catalogVersion: 3, collectionRevision: 1, checkedAt: now.toISOString(), status: "partial",
        checkedLocationIds: scope.filter((id) => id !== unavailableId), unavailableLocationIds: [unavailableId] };
    });
    expect((await partial.verify()).blockers).toContainEqual(expect.objectContaining({ code: "life_safety_monitoring_delayed" }));
  });
});
