import { afterEach, describe, expect, it, vi } from "vitest";
import { publishCommittedCatalog } from "@/lib/catalog-publication";
import { publicationPointerPath } from "@/lib/domain/publication";
import { acquireIngestionLease, releaseIngestionLease } from "@/lib/ingestion-lease";
import { checkPublicationHealth } from "@/lib/public-health";
import { readCurrentPublication } from "@/lib/publication-store";
import { createEmptyState } from "@/lib/risk-state";
import { MemoryStateStore } from "@/lib/state-store";
import { MemoryPublicationStore } from "../helpers/publication";

const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const sha = "a".repeat(40);

async function fixture(at = now) {
  const stateStore = new MemoryStateStore(createEmptyState(at));
  const publicationStore = new MemoryPublicationStore();
  const lease = await acquireIngestionLease(stateStore, "health-test-owner", at, 330_000);
  if (!lease) throw new Error("lease unavailable");
  await publishCommittedCatalog({ stateStore, stores: { publicationStore }, collection: { catalogVersion: 3, revision: 1 },
    lease, now: at, family: "all", env: { VERCEL_GIT_COMMIT_SHA: sha } });
  await releaseIngestionLease(stateStore, lease);
  return { stateStore, publicationStore };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("atomic publication health", () => {
  it("serves a complete 679-destination, 45-country generation even when source health is degraded", async () => {
    const { publicationStore } = await fixture();
    const result = await checkPublicationHealth(publicationStore, { now, expectedSha: sha, runtime: "filesystem" });
    expect(result).toMatchObject({ schemaVersion: 1, available: true, status: "degraded", catalogVersion: 3,
      publication: { status: "ok", producerCommitSha: sha },
      checks: { snapshot: { status: "ok" }, catalog: { status: "ok", expectedLocations: 679, actualLocations: 679 },
        conditions: { status: "ok", expected: 45, present: 45 }, coverage: { status: "ok" } },
      coverage: { applicable: 11_799, fullyChecked: 2_867, partlyChecked: 2_877, notChecked: 6_055,
        tiers: { lifeSafety: { applicable: 7_237, fullyChecked: 2_853, partlyChecked: 2_226, notChecked: 2_158 } } } });
  });

  it("returns unavailable for a missing pointer, manifest, object, or producer mismatch", async () => {
    const missingPointer = await fixture(); missingPointer.publicationStore.remove(publicationPointerPath);
    await expect(checkPublicationHealth(missingPointer.publicationStore, { now })).resolves.toMatchObject({ available: false,
      publication: { code: "pointer_missing" } });

    const missingManifest = await fixture(); const current = await readCurrentPublication(missingManifest.publicationStore);
    missingManifest.publicationStore.remove(current!.pointer.manifestPath);
    await expect(checkPublicationHealth(missingManifest.publicationStore, { now })).resolves.toMatchObject({ available: false,
      publication: { code: "publication_invalid" } });

    const missingObject = await fixture(); const published = await readCurrentPublication(missingObject.publicationStore);
    missingObject.publicationStore.remove(published!.manifest.conditions[0].path);
    await expect(checkPublicationHealth(missingObject.publicationStore, { now })).resolves.toMatchObject({ available: false,
      publication: { code: "publication_invalid" } });

    const wrongProducer = await fixture();
    await expect(checkPublicationHealth(wrongProducer.publicationStore, { now, expectedSha: "b".repeat(40) })).resolves.toMatchObject({ available: false,
      publication: { code: "producer_mismatch" } });
  });

  it("returns unavailable when snapshot or any conditions object is stale", async () => {
    const staleNow = new Date(now.getTime() + 121 * 60_000);
    const { publicationStore } = await fixture();
    await expect(checkPublicationHealth(publicationStore, { now: staleNow })).resolves.toMatchObject({ available: false,
      publication: { code: "publication_stale_or_incomplete" } });
  });

  it("maps a valid degraded generation to HTTP 200 and an invalid generation to 503", async () => {
    const valid = await fixture();
    vi.stubEnv("TRAVELCANARY_RUNTIME", "local");
    vi.doMock("@/lib/local-server", () => ({ getLocalPublicationStore: () => valid.publicationStore }));
    let route = await import("../../src/app/api/v1/health/route");
    expect((await route.GET()).status).toBe(200);

    vi.resetModules(); valid.publicationStore.remove(publicationPointerPath);
    vi.doMock("@/lib/local-server", () => ({ getLocalPublicationStore: () => valid.publicationStore }));
    route = await import("../../src/app/api/v1/health/route");
    expect((await route.GET()).status).toBe(503);
  });
});
