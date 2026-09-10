import { afterEach, describe, expect, it, vi } from "vitest";
import { publishCommittedCatalog, type CatalogPublicationStores } from "@/lib/catalog-publication";
import { runConditions } from "@/lib/conditions/worker";
import { parseOpenMeteo } from "@/lib/conditions/forecast";
import { conditionSourceIds, emptyConditions, WeatherForecastSchema } from "@/lib/domain/conditions";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import forecastFixture from "../fixtures/conditions/forecast.json";
import { runIngestion, runMaintenance } from "@/lib/ingestion/orchestrator";
import type { ExpandedSourceAdapter } from "@/lib/ingestion/types";
import { handleCron, handleMaintenance, handleConditions } from "@/lib/cron";
import { createEmptyState } from "@/lib/risk-state";
import { projectCatalog2Snapshot } from "@/lib/risk-snapshot";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { MemoryStateStore, MemorySnapshotStore, type StateStore, type Versioned } from "@/lib/storage";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
type SnapshotV11 = ReturnType<typeof buildCatalog3Snapshot>;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const now = new Date("2026-09-09T00:00:00Z");
const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: "c".repeat(40) };
function harness() {
  const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
  state.publicationTransition = { from: 2, to: 3, revision: 1, dualStartedAt: null, dualUntil: null };
  state.conditions.reservations = [{ at: now.toISOString(), weight: 400 }];
  state.fingerprints.retained = now.toISOString();
  const stateStore = new MemoryStateStore(state); const oldTime = new Date(now.getTime() - 60000);
  const snapshotStore = new MemorySnapshotStore(projectCatalog2Snapshot(state, oldTime));
  let expanded: Versioned<SnapshotV11> | undefined;
  const catalog3SnapshotStore = {
    readLatest: vi.fn(async () => expanded && structuredClone(expanded)),
    publish: vi.fn<CatalogPublicationStores["catalog3SnapshotStore"]["publish"]>(async (snapshot) => {
      expanded = { data: structuredClone(snapshot), etag: "expanded" }; return { etag: "expanded", status: "published", url: "https://unit.public.blob.vercel-storage.com/catalogs/3/latest.json" };
    }),
  };
  const legacyPublish = vi.spyOn(snapshotStore, "publish"); const legacyRead = vi.spyOn(snapshotStore, "readLatest");
  const publishLegacyConditions = vi.fn<CatalogPublicationStores["publishLegacyConditions"]>(async (files) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] }));
  const publishCatalog3Conditions = vi.fn<CatalogPublicationStores["publishCatalog3Conditions"]>(async (files) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] }));
  const stores = { snapshotStore, catalog3SnapshotStore, publishLegacyConditions, publishCatalog3Conditions };
  const options = { stateStore: stateStore as StateStore, stores, collection: state.collection, now, family: "all" as const, env, clock: () => now, completedAt: () => new Date(now.getTime() + 45000) };
  return { state, stateStore, stores, options, legacyPublish, legacyRead, seedExpanded(value: SnapshotV11) { expanded = { data: value, etag: "seed" }; } };
}

describe("committed catalog3 publication", () => {
  it("publishes both complete namespaces from committed evidence before starting the exact24-hour dual window", async () => {
    const h = harness(); const before = (await h.stateStore.read()).data;
    const result = await publishCommittedCatalog(h.options);
    expect(result).toMatchObject({ dual: true, acknowledged: true, snapshotsComplete: true, countries: 45 });
    expect(h.stores.publishCatalog3Conditions).toHaveBeenCalledWith(expect.any(Array), true, now);
    expect(h.stores.publishCatalog3Conditions.mock.calls[0][0]).toHaveLength(45);
    expect(h.stores.publishLegacyConditions).toHaveBeenCalledWith(expect.any(Array), true, now);
    expect(h.stores.publishLegacyConditions.mock.calls[0][0]).toHaveLength(28);
    const after = (await h.stateStore.read()).data;
    expect(after.publicationTransition).toMatchObject({ dualStartedAt: "2026-09-09T00:00:45.000Z", dualUntil: "2026-09-10T00:00:45.000Z" });
    expect({ ...after, publicationTransition: before.publicationTransition }).toEqual(before);
  });

  it.each(["snapshots", "conditions"] as const)("does not acknowledge a successful %s-only pass", async (family) => {
    const h = harness(); expect((await publishCommittedCatalog({ ...h.options, family })).acknowledged).toBe(false);
    expect((await h.stateStore.read()).data.publicationTransition!.dualStartedAt).toBeNull();
    if (family === "conditions") expect(h.stores.catalog3SnapshotStore.publish).not.toHaveBeenCalled();
    else expect(h.stores.publishCatalog3Conditions).not.toHaveBeenCalled();
  });

  it.each(["legacy", "expanded"] as const)("recovers a partial %s conditions failure from committed state without changing quota or replaying sources", async (failedFamily) => {
    const h = harness(); const before = (await h.stateStore.read()).data;
    const publisher = failedFamily === "legacy" ? h.stores.publishLegacyConditions : h.stores.publishCatalog3Conditions;
    publisher.mockResolvedValueOnce({ published: [], unchanged: [], failed: [{ countryCode: "AT", code: "write_failed" }] });
    expect((await publishCommittedCatalog(h.options)).acknowledged).toBe(false);
    expect((await h.stateStore.read()).data).toEqual(before);
    expect((await publishCommittedCatalog(h.options)).acknowledged).toBe(true);
    const after = (await h.stateStore.read()).data;
    expect(after.conditions.reservations).toEqual(before.conditions.reservations); expect(after.events).toEqual(before.events); expect(after.sources).toEqual(before.sources);
    expect(h.stores.catalog3SnapshotStore.publish).toHaveBeenCalledOnce(); expect(h.legacyPublish).toHaveBeenCalledOnce();
  });

  it.each(["missing", "duplicate", "wrong country", "overlap"] as const)("does not acknowledge incomplete condition confirmations: %s", async (mode) => {
    const h = harness(); h.stores.publishCatalog3Conditions.mockImplementation(async (files) => {
      const published = files.map(({ countryCode }) => countryCode); const unchanged: typeof published = [];
      if (mode === "missing") published.pop();
      if (mode === "duplicate") published[published.length - 1] = published[0];
      if (mode === "wrong country") Reflect.set(published, published.length - 1, "ZZ");
      if (mode === "overlap") unchanged.push(published[0]);
      return { published, unchanged, failed: [] };
    });
    const result = await publishCommittedCatalog(h.options); expect(result.acknowledged).toBe(false);
    expect((await h.stateStore.read()).data.publicationTransition!.dualStartedAt).toBeNull();
  });

  it.each(["equal different", "newer different"] as const)("does not credit a %s stored snapshot toward dual publication", async (mode) => {
    const h = harness(); const prior = buildCatalog3Snapshot(h.state, now); prior.dataHealth = prior.dataHealth === "stale" ? "delayed" : "stale";
    if (mode === "newer different") prior.generatedAt = new Date(now.getTime() + 1).toISOString();
    h.seedExpanded(prior);
    expect(await publishCommittedCatalog(h.options)).toMatchObject({ snapshotsComplete: false, acknowledged: false });
    expect(h.stores.catalog3SnapshotStore.publish).not.toHaveBeenCalled();
  });

  it("does not acknowledge when a newer different snapshot wins during the attempted publish", async () => {
    const h = harness();
    h.stores.catalog3SnapshotStore.publish.mockImplementation(async () => {
      h.seedExpanded({ ...buildCatalog3Snapshot(h.state, now), generatedAt: new Date(now.getTime() + 1).toISOString() });
      return { etag: "winner", status: "unchanged" };
    });
    expect((await publishCommittedCatalog(h.options)).acknowledged).toBe(false);
    expect((await h.stateStore.read()).data.publicationTransition!.dualStartedAt).toBeNull();
  });

  it("uses one post-read publication clock for evidence committed after collection started", async () => {
    const h = harness(); const current = await h.stateStore.read(); const checked = new Date(now.getTime() + 10000).toISOString();
    current.data.sources.usgs = { ...current.data.sources.usgs, status: "ok", lastAttempt: checked, lastSuccess: checked, sourceUpdatedAt: checked };
    current.data.expandedSourceHealth.usgs = { health: current.data.sources.usgs, checkedLocationIds: release3.locationIds.filter((id) => !release2.locationIds.includes(id)), unavailableLocationIds: [] };
    await h.stateStore.write(current.data, current);
    const clock = new Date(now.getTime() + 15000);
    const result = await publishCommittedCatalog({ ...h.options, clock: () => clock });
    expect(result.snapshot!.generatedAt).toBe(clock.toISOString());
    expect(h.legacyPublish.mock.calls[0][0].generatedAt).toBe(clock.toISOString());
    for (const publish of [h.stores.publishCatalog3Conditions, h.stores.publishLegacyConditions]) {
      expect(publish.mock.calls[0][0].every((file) => file.generatedAt === clock.toISOString())).toBe(true);
      expect(publish.mock.calls[0][2]).toEqual(clock);
    }
  });

  it.each(["initial acknowledgement", "near deadline"] as const)("keeps dual timing on the wall clock with a valid four-minute check skew: %s", async (mode) => {
    const h = harness(); const current = await h.stateStore.read(); const checked = new Date(now.getTime() + 4 * 60000).toISOString();
    current.data.expandedSourceHealth.usgs = { health: { ...current.data.sources.usgs, status: "ok", lastAttempt: checked, lastSuccess: checked, sourceUpdatedAt: checked },
      checkedLocationIds: release3.locationIds.filter((id) => !release2.locationIds.includes(id)), unavailableLocationIds: [] };
    if (mode === "near deadline") current.data.publicationTransition = { ...current.data.publicationTransition!,
      dualStartedAt: new Date(now.getTime() - 24 * 3600000 + 120000).toISOString(), dualUntil: new Date(now.getTime() + 120000).toISOString() };
    await h.stateStore.write(current.data, current); const before = current.data.publicationTransition;
    const result = await publishCommittedCatalog(h.options);
    expect(result.dual).toBe(true); expect(h.legacyPublish).toHaveBeenCalledOnce(); expect(h.stores.publishLegacyConditions).toHaveBeenCalledOnce();
    expect(result.snapshot!.generatedAt).toBe(checked);
    const after = (await h.stateStore.read()).data.publicationTransition;
    if (mode === "initial acknowledgement") { expect(result.acknowledged).toBe(true); expect(after!.dualUntil).toBe("2026-09-10T00:00:45.000Z"); }
    else expect(after).toEqual(before);
  });

  it("rejects genuinely future committed checks before any public traffic or acknowledgement", async () => {
    const h = harness(); const current = await h.stateStore.read(); current.data.sources.usgs.lastAttempt = new Date(now.getTime() + 300001).toISOString();
    await h.stateStore.write(current.data, current);
    await expect(publishCommittedCatalog(h.options)).rejects.toThrow(/future/);
    expect(h.stores.catalog3SnapshotStore.readLatest).not.toHaveBeenCalled(); expect(h.legacyRead).not.toHaveBeenCalled();
    expect(h.stores.publishCatalog3Conditions).not.toHaveBeenCalled(); expect(h.stores.publishLegacyConditions).not.toHaveBeenCalled();
  });

  it("preserves concurrent evidence on acknowledgement CAS retry without replaying publication", async () => {
    const h = harness(); const original = h.stateStore.write.bind(h.stateStore); let intervened = false;
    vi.spyOn(h.stateStore, "write").mockImplementation(async (state, expected) => {
      if (!intervened) {
        intervened = true; const current = await h.stateStore.read(); current.data.fingerprints.concurrent = now.toISOString();
        current.data.conditions.reservations.push({ at: now.toISOString(), weight: 100 });
        await original(current.data, current);
      }
      return original(state, expected);
    });
    expect((await publishCommittedCatalog(h.options)).acknowledged).toBe(true);
    const after = (await h.stateStore.read()).data; expect(after.fingerprints.concurrent).toBe(now.toISOString());
    expect(after.conditions.reservations).toHaveLength(2); expect(after.conditions.reservations.reduce((sum, { weight }) => sum + weight, 0)).toBe(500);
    expect(h.stores.publishCatalog3Conditions).toHaveBeenCalledOnce(); expect(h.stores.publishLegacyConditions).toHaveBeenCalledOnce();
  });

  it("never extends acknowledgement and stops all legacy reads and writes at the exact24-hour deadline", async () => {
    const h = harness(); await publishCommittedCatalog(h.options); const transition = (await h.stateStore.read()).data.publicationTransition;
    await publishCommittedCatalog({ ...h.options, now: new Date(now.getTime() + 60000), completedAt: () => new Date(now.getTime() + 120000) });
    expect((await h.stateStore.read()).data.publicationTransition).toEqual(transition);
    h.legacyRead.mockClear(); h.legacyPublish.mockClear(); h.stores.publishLegacyConditions.mockClear();
    expect((await publishCommittedCatalog({ ...h.options, now: new Date(transition!.dualUntil!), clock: () => new Date(transition!.dualUntil!) })).dual).toBe(false);
    expect(h.legacyRead).not.toHaveBeenCalled(); expect(h.legacyPublish).not.toHaveBeenCalled(); expect(h.stores.publishLegacyConditions).not.toHaveBeenCalled();
  });

  it("fences a revision change before the first public write", async () => {
    const h = harness(); const original = h.stateStore.read.bind(h.stateStore); let changed = false;
    h.stores.catalog3SnapshotStore.readLatest.mockImplementation(async () => { changed = true; return undefined; });
    vi.spyOn(h.stateStore, "read").mockImplementation(async () => { const current = await original(); if (changed) current.data.collection.revision += 1; return current; });
    await expect(publishCommittedCatalog(h.options)).rejects.toThrow();
    expect(h.stores.catalog3SnapshotStore.publish).not.toHaveBeenCalled(); expect(h.legacyPublish).not.toHaveBeenCalled();
    expect(h.stores.publishCatalog3Conditions).not.toHaveBeenCalled(); expect((await original()).data.publicationTransition!.dualStartedAt).toBeNull();
  });
});


describe("operational publication transport controls", () => {
  it("runs the real expanded orchestrator over679 inputs and maintenance repairs publication without collecting again", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now.getTime() + 45000));
    const h = harness(); const fetchSource = vi.fn<ExpandedSourceAdapter["fetch"]>().mockResolvedValue({ sourceId: "usgs", status: "ok", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], error: null });
    const adapter: ExpandedSourceAdapter = { id: "usgs", cadence: "fast", catalogVersion: 3, fetch: fetchSource };
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("No network expected"));
    const result = await runIngestion({ cadence: "fast", adapters: [adapter], stateStore: h.stateStore, snapshotStore: h.stores.snapshotStore, catalogPublication: h.stores, now, fetch });
    expect(result.locations).toBe(679); expect(fetchSource.mock.calls[0][0].locations).toHaveLength(679);
    expect((await h.stateStore.read()).data.expandedSourceHealth.usgs!.checkedLocationIds).toHaveLength(176);
    expect((await h.stateStore.read()).data.publicationTransition!.dualStartedAt).toBeNull();
    const quota = (await h.stateStore.read()).data.conditions.reservations;
    h.stores.publishLegacyConditions.mockResolvedValueOnce({ published: [], unchanged: [], failed: [{ countryCode: "AT", code: "write_failed" }] });
    const options = { stateStore: h.stateStore, snapshotStore: h.stores.snapshotStore, catalogPublication: h.stores, now };
    await runMaintenance(options); expect((await h.stateStore.read()).data.publicationTransition!.dualStartedAt).toBeNull();
    await runMaintenance(options); expect((await h.stateStore.read()).data.publicationTransition!.dualStartedAt).not.toBeNull();
    expect(fetchSource).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect((await h.stateStore.read()).data.conditions.reservations).toEqual(quota);
  });

  it("collects only176 due expanded weather destinations, publishes45 files, and surfaces legacy publication failure", async () => {
    const h = harness(); const current = await h.stateStore.read(); current.data.conditions.reservations = [];
    const fixture = structuredClone(forecastFixture); fixture.hourly.time = fixture.hourly.time.map((_, index) => now.getTime() / 1000 + index * 3600);
    const weather = WeatherForecastSchema.parse(parseOpenMeteo(fixture, "weather", now));
    for (const id of release2.locationIds) { current.data.conditions.locations[id] = { ...emptyConditions(), weather }; current.data.conditions.attempts[`weather:${id}`] = now.toISOString(); }
    await h.stateStore.write(current.data, current);
    const queried: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input)); expect(url.hostname).toBe("api.open-meteo.com");
      const latitudes = url.searchParams.get("latitude")!.split(","); const longitudes = url.searchParams.get("longitude")!.split(",");
      queried.push(...latitudes.map((lat, index) => `${longitudes[index]},${lat}`));
      return Response.json(latitudes.map((lat, index) => ({ ...fixture, latitude: Number(lat), longitude: Number(longitudes[index]) })));
    });
    const legacyFallback = vi.fn(); h.stores.publishLegacyConditions.mockResolvedValueOnce({ published: [], unchanged: [], failed: [{ countryCode: "AT", code: "write_failed" }] });
    const result = await runConditions({ stateStore: h.stateStore, catalogPublication: h.stores, now, fetch, publish: legacyFallback,
      env: { ...env, CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") } });
    expect(result).toMatchObject({ status: "partial", locations: 679, countries: 45, publication: { failed: 1 } });
    const expanded = catalogLocationsV3.filter(({ id }) => !release2.locationIds.includes(id));
    expect(queried.sort()).toEqual(expanded.map(({ centroid }) => `${centroid[0].toFixed(4)},${centroid[1].toFixed(4)}`).sort());
    expect(fetch).toHaveBeenCalledTimes(5); expect(legacyFallback).not.toHaveBeenCalled();
    expect(h.stores.publishCatalog3Conditions.mock.calls[0][0]).toHaveLength(45);
    const after = (await h.stateStore.read()).data; expect(after.conditions.lease).toBeNull();
    expect(after.conditions.reservations.reduce((sum, { weight }) => sum + weight, 0)).toBe(176);
    for (const { id } of expanded) expect(after.conditions.locations[id].weather?.checkedAt).toBe(now.toISOString());
    expect(after.publicationTransition!.dualStartedAt).toBeNull();
  });

  it("disables a known source with zero requests while retaining prior unexpired expanded evidence", async () => {
    vi.stubEnv("INGESTION_DISABLED_SOURCES", "usgs"); const h = harness(); const current = await h.stateStore.read();
    current.data.events = [{ id: "usgs:prior:gb-london", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
      geometry: { kind: "locations", ids: ["gb-london"] }, headline: "Earthquake nearby.", explanation: "Official evidence.", action: "Follow official advice.", affectedArea: "London",
      startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 3600000).toISOString(), checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(), sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM" }];
    await h.stateStore.write(current.data, current); const original = structuredClone(current.data.events);
    const fetchSource = vi.fn<ExpandedSourceAdapter["fetch"]>().mockRejectedValue(new Error("Disabled adapter called"));
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Disabled transport called"));
    await runIngestion({ cadence: "fast", adapters: [{ id: "usgs", cadence: "fast", catalogVersion: 3, fetch: fetchSource }], stateStore: h.stateStore,
      snapshotStore: h.stores.snapshotStore, catalogPublication: h.stores, now, fetch });
    expect(fetchSource).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    const after = (await h.stateStore.read()).data; expect(after.events).toEqual(original); expect(after.expandedSourceHealth.usgs!.health.status).toBe("failed");
  });

  it("fails closed for an unknown transport control before state reads, writes, or source requests", async () => {
    vi.stubEnv("INGESTION_DISABLED_SOURCES", "usgs-typo"); const h = harness(); const read = vi.spyOn(h.stateStore, "read"); const write = vi.spyOn(h.stateStore, "write");
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(runIngestion({ cadence: "fast", adapters: [], stateStore: h.stateStore, snapshotStore: h.stores.snapshotStore, catalogPublication: h.stores, now, fetch })).rejects.toThrow(/Unknown/);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(h.stores.catalog3SnapshotStore.readLatest).not.toHaveBeenCalled();
  });

  it("authenticates pause responses and returns503 before configuring stores or making requests", async () => {
    vi.stubEnv("INGESTION_PAUSED", "true"); vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN", ""); vi.stubEnv("PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN", "");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Paused transport called")); vi.stubGlobal("fetch", fetch);
    for (const handler of [(request: Request) => handleCron(request, "fast"), handleMaintenance, handleConditions]) {
      const denied = await handler(new Request("https://example.test", { headers: { authorization: "Bearer wrong" } })); expect(denied.status).toBe(401);
      const response = await handler(new Request("https://example.test", { headers: { authorization: "Bearer test-secret" } }));
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ status: "paused" }); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
