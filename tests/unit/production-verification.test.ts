import { describe, expect, it, vi } from "vitest";
import { publishCommittedCatalog } from "@/lib/catalog-publication";
import { acquireIngestionLease } from "@/lib/ingestion-lease";
import { publicationPointerPath } from "@/lib/domain/publication";
import { createEmptyState } from "@/lib/risk-state";
import { MemoryStateStore } from "@/lib/state-store";
import { readCurrentPublication } from "@/lib/publication-store";
import { verifyProduction } from "../../scripts/verify-production";
import { MemoryPublicationStore } from "../helpers/publication";

const origin = "https://travelcanary.test";
const blobOrigin = "https://unit.public.blob.vercel-storage.com";
const pointer = `${blobOrigin}/${publicationPointerPath}`;
const now = new Date("2026-09-18T06:00:00.000Z");
const sha = "a".repeat(40);

async function fixture() {
  const stateStore = new MemoryStateStore(createEmptyState(now)); const publicationStore = new MemoryPublicationStore();
  const lease = await acquireIngestionLease(stateStore, "production-verifier-test", now, 330_000);
  if (!lease) throw new Error("lease unavailable");
  await publishCommittedCatalog({ stateStore, stores: { publicationStore }, collection: { catalogVersion: 3, revision: 1 }, lease,
    now, family: "all", env: { VERCEL_GIT_COMMIT_SHA: sha } });
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
});
