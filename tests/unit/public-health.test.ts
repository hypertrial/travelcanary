import { afterEach, describe, expect, it, vi } from "vitest";
import catalog from "../../public/catalogs/3/locations.json";
import release2 from "../../data/catalog-releases/2.json";
import { buildCatalog3Conditions, buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { checkPublicHealth } from "@/lib/public-health";
import { createEmptyState } from "@/lib/risk-state";
import type { IngestionStateV15 } from "@/lib/domain/catalog-state";

const now = new Date("2026-09-09T10:00:00Z");
const sha = "a".repeat(40);
const origin = "https://travelcanary.test";
const snapshotUrl = "https://unit.public.blob.vercel-storage.com/catalogs/3/latest.json";
const added = catalog.filter(({ id }) => !release2.locationIds.includes(id)).map(({ id }) => id);
const health = { status: "ok" as const, lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(),
  nextExpectedUpdate: new Date(+now + 60 * 60_000).toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };

function healthyState() {
  const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
  for (const [id, value] of Object.entries(state.sources)) if (value.status !== "not_monitored") {
    state.sources[id as keyof typeof state.sources] = { ...health };
  }
  for (const [id, value] of Object.entries(state.providers)) if (value.status !== "not_monitored") {
    state.providers[id as keyof typeof state.providers] = { ...health };
  }
  for (const partitions of Object.values(state.sourcePartitions)) for (const value of Object.values(partitions)) {
    if (value.status !== "not_monitored") Object.assign(value, health);
  }
  for (const countries of Object.values(state.partitionTransports)) for (const transports of Object.values(countries)) {
    for (const value of Object.values(transports)) if (value.status !== "not_monitored") Object.assign(value, health);
  }
  receipt(state, "usgs", added);
  receipt(state, "slf-avalanche", ["li-malbun"]);
  return state;
}

function receipt(state: IngestionStateV15, source: "usgs" | "slf-avalanche", checked: string[]) {
  const scope = source === "usgs" ? added : ["li-malbun"];
  state.expandedSourceHealth[source] = { health: { ...health, status: checked.length ? checked.length === scope.length ? "ok" : "partial" : "failed",
    lastSuccess: checked.length ? now.toISOString() : null, sourceUpdatedAt: checked.length ? now.toISOString() : null,
    error: checked.length === scope.length ? null : "private upstream failure" },
    checkedLocationIds: checked, unavailableLocationIds: scope.filter((id) => !checked.includes(id)) };
}

function fixture() {
  const state = healthyState();
  const snapshot = buildCatalog3Snapshot(state, now);
  const files = buildCatalog3Conditions(state, now, { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: sha });
  const bodies = new Map<string, string>([
    [snapshotUrl, JSON.stringify(snapshot)],
    [`${origin}/catalogs/3/locations.json`, JSON.stringify(catalog)],
  ]);
  for (const file of files) bodies.set(`https://unit.public.blob.vercel-storage.com/catalogs/3/conditions/v3/${file.countryCode}.json`, JSON.stringify(file));
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const body = bodies.get(String(input));
    return body === undefined ? new Response("missing", { status: 404 })
      : new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
  });
  const env = { NEXT_PUBLIC_CATALOG_VERSION: "3", NEXT_PUBLIC_SNAPSHOT_URL: snapshotUrl, TRAVELCANARY_PUBLIC_ORIGIN: origin, VERCEL_GIT_COMMIT_SHA: sha };
  return { state, snapshot, files, bodies, fetch, env,
    check: () => checkPublicHealth({ env, fetch, now, deadlineMs: 2_000 }) };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("public production health", () => {
  it("validates the exact 679-location, 45-condition publication and viable required transports", async () => {
    const f = fixture(); const result = await f.check();
    expect(result).toMatchObject({ schemaVersion: 1, status: "ok", catalogVersion: 3, checkedAt: now.toISOString(),
      checks: { snapshot: { status: "ok", ageMinutes: 0 }, catalog: { status: "ok", expectedLocations: 679, actualLocations: 679 },
        conditions: { status: "ok", expected: 45, present: 45, overdueCountryCodes: [] }, transports: { status: "ok", failed: [] },
        coverage: { status: "ok" } } });
    expect(result.coverage.fullyChecked + result.coverage.partlyChecked + result.coverage.notChecked).toBe(11_799);
    expect(result.coverage).toMatchObject({ applicable: 11_799, fullyChecked: 2_867, partlyChecked: 2_877, notChecked: 6_055,
      tiers: { lifeSafety: { applicable: 7_237, fullyChecked: 2_853, partlyChecked: 2_226, notChecked: 2_158 } } });
    expect(f.fetch.mock.calls).toHaveLength(47);
  });

  it("degrades when catalog applicability falls below the coverage release floor", async () => {
    const f = fixture(); const changed = structuredClone(catalog);
    changed.find(({ id }) => id === "gb-aberdeen")!.isCoastal = false;
    f.bodies.set(`${origin}/catalogs/3/locations.json`, JSON.stringify(changed));
    expect(await f.check()).toMatchObject({ status: "degraded", checks: { coverage: { status: "failed" } } });
  });

  it("fails stale snapshots and missing or overdue condition partitions", async () => {
    const stale = fixture(); stale.snapshot.generatedAt = new Date(+now - 121 * 60_000).toISOString();
    for (const provider of Object.values(stale.snapshot.providers)) if (provider.expandedCoverage) provider.expandedCoverage.checkedAt = stale.snapshot.generatedAt;
    stale.bodies.set(snapshotUrl, JSON.stringify(stale.snapshot));
    expect(await stale.check()).toMatchObject({ status: "degraded", checks: { snapshot: { status: "failed", ageMinutes: 121 } } });

    const missing = fixture(); missing.bodies.delete("https://unit.public.blob.vercel-storage.com/catalogs/3/conditions/v3/VA.json");
    expect(await missing.check()).toMatchObject({ status: "degraded", checks: { conditions: { status: "failed", expected: 45, present: 44,
      overdueCountryCodes: ["VA"] } } });

    const overdue = fixture(); const va = overdue.files.find(({ countryCode }) => countryCode === "VA")!;
    va.generatedAt = new Date(+now - 76 * 60_000).toISOString();
    overdue.bodies.set("https://unit.public.blob.vercel-storage.com/catalogs/3/conditions/v3/VA.json", JSON.stringify(va));
    expect(await overdue.check()).toMatchObject({ status: "degraded", checks: { conditions: { status: "failed", overdueCountryCodes: ["VA"] } } });
  });

  it("fails catalog membership and producer-release mismatches", async () => {
    const catalogMismatch = fixture(); const duplicate = structuredClone(catalog);
    duplicate[duplicate.length - 1] = duplicate[0];
    catalogMismatch.bodies.set(`${origin}/catalogs/3/locations.json`, JSON.stringify(duplicate));
    expect(await catalogMismatch.check()).toMatchObject({ status: "degraded", checks: { catalog: { status: "failed", expectedLocations: 679, actualLocations: 0 } } });

    const releaseMismatch = fixture(); const va = releaseMismatch.files.find(({ countryCode }) => countryCode === "VA")!;
    va.producerCommitSha = "b".repeat(40);
    releaseMismatch.bodies.set("https://unit.public.blob.vercel-storage.com/catalogs/3/conditions/v3/VA.json", JSON.stringify(va));
    expect(await releaseMismatch.check()).toMatchObject({ status: "degraded", checks: { conditions: { status: "failed" } } });
  });

  it("fails when every required transport for an applicable scope is exhausted without exposing destination details", async () => {
    const f = fixture();
    f.snapshot.providers.usgs.expandedCoverage = { status: "failed", checkedAt: now.toISOString(), checkedLocationIds: [], unavailableLocationIds: added };
    f.bodies.set(snapshotUrl, JSON.stringify(f.snapshot));
    const result = await f.check();
    expect(result).toMatchObject({ status: "degraded", checks: { transports: { status: "failed" } } });
    expect(result.checks.transports.failed).toContain("coverage/AD/earthquake/usgs");
    expect(JSON.stringify(result)).not.toContain("ad-andorra-la-vella");
    expect(JSON.stringify(result)).not.toContain("private upstream failure");
  });

  it("keeps unconfigured credential-gated Met Office and NRW health-neutral", async () => {
    const f = fixture();
    expect(f.snapshot.providers["national-civil-alerts"].partitions?.GB.transports).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "met-office-nswws", role: "fallback", status: "disabled", limitationCode: "credential_not_configured" }),
      expect.objectContaining({ id: "nrw-flood", status: "disabled", limitationCode: "credential_not_configured" }),
    ]));
    expect(await f.check()).toMatchObject({ status: "ok", checks: { transports: { status: "ok", failed: [] } } });
  });

  it("keeps missing, failed, or stale optional Met Office health neutral", async () => {
    const missing = fixture();
    missing.snapshot.providers["national-civil-alerts"].partitions!.GB.transports = missing.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .filter(({ id }) => id !== "met-office-nswws");
    missing.bodies.set(snapshotUrl, JSON.stringify(missing.snapshot));
    expect(await missing.check()).toMatchObject({ status: "ok", checks: { transports: { status: "ok", failed: [] } } });

    const stale = fixture();
    const metOffice = stale.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!.find(({ id }) => id === "met-office-nswws")!;
    Object.assign(metOffice, { status: "failed", lastSuccess: new Date(+now - 60 * 60_000).toISOString(),
      nextExpectedUpdate: new Date(+now - 30 * 60_000).toISOString() });
    stale.bodies.set(snapshotUrl, JSON.stringify(stale.snapshot));
    expect(await stale.check()).toMatchObject({ status: "ok", checks: { transports: { status: "ok", failed: [] } } });

    const failed = fixture();
    const recentlySuccessful = failed.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .find(({ id }) => id === "met-office-nswws")!;
    Object.assign(recentlySuccessful, { status: "failed", lastSuccess: new Date(+now - 5 * 60_000).toISOString(),
      nextExpectedUpdate: new Date(+now + 5 * 60_000).toISOString() });
    failed.bodies.set(snapshotUrl, JSON.stringify(failed.snapshot));
    expect(await failed.check()).toMatchObject({ status: "ok", checks: { transports: { status: "ok", failed: [] } } });
  });

  it("fails when an applicable required transport is absent", async () => {
    const f = fixture();
    f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .filter(({ id }) => id !== "ea-flood");
    f.bodies.set(snapshotUrl, JSON.stringify(f.snapshot));
    expect(await f.check()).toMatchObject({ status: "degraded", checks: { transports: { status: "failed" } } });
  });

  it("rejects a valid condition file served from another country's path", async () => {
    const f = fixture(); const germany = f.files.find(({ countryCode }) => countryCode === "DE")!;
    f.bodies.set("https://unit.public.blob.vercel-storage.com/catalogs/3/conditions/v3/AT.json", JSON.stringify(germany));
    expect(await f.check()).toMatchObject({ status: "degraded", checks: { conditions: {
      status: "failed", present: 44, overdueCountryCodes: ["AT"],
    } } });
  });

  it("keeps a failed required transport viable only while retained success remains fresh", async () => {
    const f = fixture();
    const transport = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .find(({ id }) => id === "ea-flood")!;
    Object.assign(transport, { status: "failed", lastSuccess: new Date(+now - 5 * 60_000).toISOString(),
      nextExpectedUpdate: new Date(+now + 10 * 60_000).toISOString() });
    f.bodies.set(snapshotUrl, JSON.stringify(f.snapshot));
    expect(await f.check()).toMatchObject({ status: "ok", checks: { transports: { status: "ok" } } });
    Object.assign(transport, { lastSuccess: new Date(+now - 60 * 60_000).toISOString(), nextExpectedUpdate: new Date(+now - 30 * 60_000).toISOString() });
    f.bodies.set(snapshotUrl, JSON.stringify(f.snapshot));
    expect(await f.check()).toMatchObject({ status: "degraded", checks: { transports: { status: "failed" } } });
  });

  it("fails an overdue required transport even when its projected status is still ok", async () => {
    const f = fixture();
    const transport = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .find(({ id }) => id === "ea-flood")!;
    Object.assign(transport, { status: "ok", lastSuccess: new Date(+now - 60 * 60_000).toISOString(),
      nextExpectedUpdate: new Date(+now - 30 * 60_000).toISOString() });
    f.bodies.set(snapshotUrl, JSON.stringify(f.snapshot));
    expect(await f.check()).toMatchObject({ status: "degraded", checks: { transports: { status: "failed" } } });
  });

  it("uses only a fixed trusted origin, bounds failures, and never returns upstream bodies or request URLs", async () => {
    const f = fixture(); const secret = "secret-body https://private.example/internal";
    f.env.TRAVELCANARY_PUBLIC_ORIGIN = "http://127.0.0.1:3000";
    f.fetch.mockRejectedValue(new Error(secret));
    const result = await f.check(); const serialized = JSON.stringify(result);
    expect(result.status).toBe("degraded");
    expect(f.fetch.mock.calls.every(([input]) => String(input) !== "http://127.0.0.1:3000/catalogs/3/locations.json")).toBe(true);
    expect(serialized).not.toContain(secret); expect(serialized).not.toContain("private.example");
  });

  it("returns HTTP 503 for degraded production health and enforces 60-second revalidation caching", async () => {
    const f = fixture(); f.bodies.delete("https://unit.public.blob.vercel-storage.com/catalogs/3/conditions/v3/VA.json");
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
    vi.stubEnv("TRAVELCANARY_RUNTIME", ""); vi.stubGlobal("fetch", f.fetch);
    const { GET } = await import("../../src/app/api/v1/health/route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, must-revalidate");
    expect(await response.json()).toMatchObject({ schemaVersion: 1, status: "degraded" });
  });

  it("rejects query-string cache busting before starting any health reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.resetModules(); const f = fixture();
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
    vi.stubEnv("TRAVELCANARY_RUNTIME", ""); vi.stubGlobal("fetch", f.fetch);
    const { GET } = await import("../../src/app/api/v1/health/route");
    const responses = await Promise.all([
      GET(new Request("https://travelcanary.test/api/v1/health?nonce=one")),
      GET(new Request("https://travelcanary.test/api/v1/health?nonce=two")),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 400]);
    expect(f.fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("stream-bounds a chunked health artifact without trusting content-length", async () => {
    const oversized = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(300_000)); controller.enqueue(new Uint8Array(300_000)); controller.close();
    } });
    const result = await checkPublicHealth({ env: fixture().env, now, deadlineMs: 2_000,
      fetch: vi.fn(async () => new Response(oversized)) as typeof fetch });
    expect(result).toMatchObject({ status: "degraded", checks: { snapshot: { status: "failed" } } });
  });
});
