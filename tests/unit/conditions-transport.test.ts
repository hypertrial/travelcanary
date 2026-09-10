import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseDigitraffic } from "@/lib/conditions/digitraffic";
import { forecastBatches, runConditions } from "@/lib/conditions/worker";
import { conditionSourceIds, emptyConditions, type Conditions, type LocationConditions } from "@/lib/domain/conditions";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { MemoryStateStore } from "@/lib/storage";
import { locations } from "@/lib/data";
import rwsFixture from "../fixtures/conditions/rws-water.json";
import { parseRwsWater } from "@/lib/conditions/rws-water";
import ipmaObservationFixture from "../fixtures/conditions/ipma-observations.json";
import ipmaSeismicFixture from "../fixtures/conditions/ipma-seismic.json";
import { autobahnRoadIds } from "@/lib/conditions/infrastructure-mapping";
import { parseOpenMeteo } from "@/lib/conditions/forecast";

const now = new Date("2026-08-31T17:45:00Z");
const xml = readFileSync("tests/fixtures/conditions/traffic-datex.xml", "utf8");
const arsoXml = readFileSync("tests/fixtures/conditions/arso-hydrology.xml", "utf8");
const forecast = JSON.parse(readFileSync("tests/fixtures/conditions/forecast.json", "utf8"));
const weather = (at: Date) => parseOpenMeteo(forecast, "weather", at) as NonNullable<LocationConditions["weather"]>;
const metNorway = JSON.parse(readFileSync("tests/fixtures/conditions/met-norway.json", "utf8"));
const helsinki = locations.find(({ id }) => id === "fi-helsinki")!;
const successfulPublish = async (files: Conditions[]) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] });
// Synthetic geometry only, to exercise intersection against a configured destination.
const geo = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: helsinki.centroid }, properties: { situationId: "GUID50469906", version: 1 } }] };
describe("bounded conditions transports", () => {
  it.each([false, true])("aligns successful batches and invokes MET Norway only for a failed location (%s)", async (failOne) => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => !["open-meteo-weather", "met-norway"].includes(id)).join(",") };
    const initial = createEmptyState(now); const attemptedIds = forecastBatches(initial, now, env).flatMap(({ ids }) => ids); const failedId = attemptedIds[0];
    const store = new MemoryStateStore(initial); const publish = vi.fn(successfulPublish);
    let damaged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.met.no") return Response.json(metNorway, { headers: { Expires: "Mon, 31 Aug 2026 19:19:03 GMT" } });
      const latitude = url.searchParams.get("latitude")!.split(",").map(Number);
      const longitude = url.searchParams.get("longitude")!.split(",").map(Number);
      const rows = latitude.map((lat, index) => ({ ...structuredClone(forecast), latitude: lat, longitude: longitude[index] }));
      if (failOne && !damaged) { delete rows[0].hourly.temperature_2m; damaged = true; }
      return Response.json(rows);
    });
    await runConditions({ now, stateStore: store, publish, fetch: fetchMock, env });
    const state = (await store.read()).data;
    expect(Object.keys(state.conditions.locations)).toHaveLength(200);
    expect(state.conditions.health["open-meteo-weather"]).toMatchObject({ status: failOne ? "partial" : "ok", matched: failOne ? 199 : 200 });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("api.met.no"))).toHaveLength(failOne ? 1 : 0);
    expect(Object.values(state.conditions.locations).filter(({ weather }) => weather?.sourceId === "met-norway")).toHaveLength(failOne ? 1 : 0);
    if (failOne) expect(Object.values(state.conditions.cacheUntil)).toContain("2026-08-31T19:19:03.000Z");
    if (failOne) {
      expect(state.conditions.attempts[`weather:${failedId}`]).toBeUndefined();
      const nextIds = forecastBatches(state, new Date(now.getTime() + 60_000), env).flatMap(({ ids }) => ids);
      expect(nextIds).toContain(failedId);
      expect(nextIds.filter((id) => attemptedIds.includes(id))).toEqual([failedId]);
    }
    expect(buildSnapshot(state, now)).toEqual(buildSnapshot(initial, now));
    expect(publish.mock.calls[0][0].flatMap((file: { locations: Record<string, unknown> }) => Object.keys(file.locations))).toHaveLength(503);
  });

  it("recovers one whole failed forecast batch through one quota-accounted split", async () => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") };
    const store = new MemoryStateStore(createEmptyState(now)); let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); const latitude = url.searchParams.get("latitude")!.split(",").map(Number);
      const longitude = url.searchParams.get("longitude")!.split(",").map(Number);
      if (++calls === 1) throw new Error("batch transport failed");
      if (latitude.length === 20) expect((await store.read()).data.conditions.reservations.map(({ weight }) => weight)).toContain(40);
      return Response.json(latitude.map((lat, index) => ({ ...structuredClone(forecast), latitude: lat, longitude: longitude[index] })));
    });
    const result = await runConditions({ now, stateStore: store, publish: successfulPublish, fetch: fetchMock, env });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.diagnostics!.forecasts.weather).toMatchObject({ attempted: 200, matched: 200, failed: 0, splitRetried: 40, recovered: 40, skipped: 0,
      failureCodes: { unknown_failure: 1 }, affectedCountries: [] });
    expect((await store.read()).data.conditions.reservations.map(({ weight }) => weight)).toEqual([200, 40]);
    expect((await store.read()).data.conditions.health["open-meteo-weather"]).toMatchObject({ status: "ok", matched: 200 });
  });

  it("retains only the failed split half as immediately due", async () => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") };
    const initial = createEmptyState(now); const firstBatch = forecastBatches(initial, now, env)[0]; const failedIds = firstBatch.ids.slice(20);
    const store = new MemoryStateStore(initial); let initialFailed = false; let splitCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); const latitude = url.searchParams.get("latitude")!.split(",").map(Number);
      const longitude = url.searchParams.get("longitude")!.split(",").map(Number);
      if (!initialFailed && latitude.length === 40) { initialFailed = true; throw new Error("batch transport failed"); }
      if (latitude.length === 20 && ++splitCalls === 2) throw new Error("second half failed");
      return Response.json(latitude.map((lat, index) => ({ ...structuredClone(forecast), latitude: lat, longitude: longitude[index] })));
    });
    const result = await runConditions({ now, stateStore: store, publish: successfulPublish, fetch: fetchMock, env });
    const state = (await store.read()).data;
    expect(result.diagnostics!.forecasts.weather).toMatchObject({ attempted: 200, matched: 180, failed: 20, splitRetried: 40, recovered: 20 });
    for (const id of firstBatch.ids.slice(0, 20)) expect(state.conditions.attempts[`weather:${id}`]).toBe(now.toISOString());
    for (const id of failedIds) expect(state.conditions.attempts[`weather:${id}`]).toBeUndefined();
    for (const location of locations.filter(({ id }) => !firstBatch.ids.includes(id))) {
      state.conditions.attempts[`weather:${location.id}`] = now.toISOString();
      state.conditions.locations[location.id] = { ...(state.conditions.locations[location.id] || emptyConditions()), weather: weather(now) };
    }
    expect(forecastBatches(state, new Date(now.getTime() + 60_000), env).flatMap(({ ids }) => ids)).toEqual(failedIds);
  });

  it("defers a failed batch when the existing quota ledger cannot reserve its split", async () => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") };
    const initial = createEmptyState(now); initial.conditions.reservations.push({ at: now.toISOString(), weight: 180 });
    const store = new MemoryStateStore(initial); let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); const latitude = url.searchParams.get("latitude")!.split(",").map(Number);
      const longitude = url.searchParams.get("longitude")!.split(",").map(Number);
      if (++calls === 1) throw new Error("batch transport failed");
      return Response.json(latitude.map((lat, index) => ({ ...structuredClone(forecast), latitude: lat, longitude: longitude[index] })));
    });
    const result = await runConditions({ now, stateStore: store, publish: successfulPublish, fetch: fetchMock, env });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.diagnostics!.forecasts.weather).toMatchObject({ splitRetried: 0, skipped: 40, failed: 40 });
    expect((await store.read()).data.conditions.reservations.map(({ weight }) => weight)).toEqual([180, 200]);
  });

  it("accepts a real structured accident closure, joined by ID/version, without publisher text", () => {
    const result = parseDigitraffic(xml, geo, now);
    expect(result.locations[helsinki.id]).toHaveLength(1);
    expect(result.locations[helsinki.id][0]).toMatchObject({ kind: "road-closure", status: "active", endsAt: null, sourceId: "digitraffic" });
    expect(JSON.stringify(result)).not.toMatch(/comment|sender|phone|headline/);
  });
  it("ignores lane closures, works, test, inactive, future and stale reports", () => {
    for (const changed of [xml.replaceAll("roadClosed", "laneClosures"), xml.replace("sit:Accident", "sit:Roadworks"), xml.replace("real", "test"),
      xml.replaceAll(">active<", ">suspended<"), xml.replaceAll("16:50:00", "20:50:00"), xml.replaceAll("2026-08-31", "2026-08-29")]) {
      expect(parseDigitraffic(changed, geo, now).locations[helsinki.id]).toEqual([]);
    }
    expect(parseDigitraffic(xml, { ...geo, features: [{ ...geo.features[0], geometry: { type: "Point", coordinates: [0, 0] } }] }, now).locations[helsinki.id]).toEqual([]);
    expect(() => parseDigitraffic(xml, { ...geo, features: [] }, now)).toThrow(/version/);
    expect(() => parseDigitraffic("<!DOCTYPE evil>" + xml, geo, now)).toThrow();
  });
  it("accounts before HTTP attempts, persists 429 cooldown, and retains reservations on failures", async () => {
    const store = new MemoryStateStore(createEmptyState(now)); const publish = vi.fn(successfulPublish);
    const fetchMock = vi.fn(async () => {
      expect((await store.read()).data.conditions.reservations.length).toBeGreaterThan(0);
      return new Response("rate limited", { status: 429, headers: { "retry-after": "7200" } });
    });
    const result = await runConditions({ now, stateStore: store, publish, fetch: fetchMock, env: { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") } });
    const final = (await store.read()).data;
    expect(final.conditions.cooldownUntil).toBe("2026-08-31T19:45:00.000Z");
    expect(final.conditions.reservations[0].weight).toBe(200);
    expect(Object.keys(final.conditions.attempts)).toHaveLength(0);
    expect(final.conditions.lease).toBeNull();
    expect(final.events).toEqual([]);
    expect(result.diagnostics!.forecasts.weather.splitRetried).toBe(0);
  });
  it("publishes reviewed Rijkswaterstaat observations without changing alert risk", async () => {
    const initial = createEmptyState(new Date("2026-09-01T13:00:00.000Z")); const before = buildSnapshot(initial, new Date("2026-09-01T13:00:00.000Z"));
    const store = new MemoryStateStore(initial);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "POST" });
      return Response.json(rwsFixture);
    });
    await runConditions({ now: new Date("2026-09-01T13:00:00.000Z"), stateStore: store, publish: successfulPublish, fetch: fetchMock, env: {
      LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "rws-water").join(","),
    } });
    const final = (await store.read()).data;
    expect(final.conditions.locations["nl-rotterdam"].rivers).toMatchObject([{ sourceId: "rws-water", datum: "NAP", qualityCode: "00" }]);
    expect(final.conditions.health["rws-water"]).toMatchObject({ status: "ok", matched: 1 });
    expect(buildSnapshot(final, new Date("2026-09-01T13:00:00.000Z"))).toEqual(before);
  });
  it("bounds Autobahn to 24 roads / 48 requests and recovers a partial source on the next run", async () => {
    expect(autobahnRoadIds).toHaveLength(24);
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "autobahn-traffic").join(",") };
    const initial = createEmptyState(now); const before = buildSnapshot(initial, now); const store = new MemoryStateStore(initial);
    let failed = false;
    const firstFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); const key = url.endsWith("/closure") ? "closure" : "warning";
      if (!failed && url.includes("/A100/") && key === "closure") { failed = true; throw new Error("one road failed"); }
      return Response.json({ [key]: [] });
    });
    const first = await runConditions({ now, stateStore: store, publish: successfulPublish, fetch: firstFetch, env });
    expect(firstFetch).toHaveBeenCalledTimes(48);
    expect(first.diagnostics).toMatchObject({ infrastructureRequests: 48, infrastructureSkipped: 0,
      infrastructure: { "autobahn-traffic": { attempted: 48, succeeded: 47, failed: 1, skipped: 0, healthyEmpty: false,
        failureCodes: { unknown_failure: 1 }, targetExamples: [{ target: "A100:closure", code: "unknown_failure" }], omittedTargets: 0 } } });
    expect((await store.read()).data.conditions.health["autobahn-traffic"]).toMatchObject({ status: "partial", matched: 0, code: "partial_transport_failure" });
    expect((await store.read()).data.conditions.attempts["infrastructure:autobahn-traffic:A100:closure"]).toBeUndefined();

    const recoveredAt = new Date(now.getTime() + 61 * 60_000);
    const secondFetch = vi.fn(async (input: RequestInfo | URL) => Response.json({ [String(input).endsWith("/closure") ? "closure" : "warning"]: [] }));
    const second = await runConditions({ now: recoveredAt, stateStore: store, publish: successfulPublish, fetch: secondFetch, env });
    expect(secondFetch).toHaveBeenCalledTimes(48);
    expect(String(secondFetch.mock.calls[0][0])).toContain("/A100/services/closure");
    expect(second.diagnostics!.infrastructure["autobahn-traffic"]).toMatchObject({ attempted: 48, succeeded: 48, failed: 0, healthyEmpty: true });
    const recovered = (await store.read()).data;
    expect(recovered.conditions.health["autobahn-traffic"]).toMatchObject({ status: "ok", matched: 0 });
    expect(recovered.conditions.attempts["infrastructure:autobahn-traffic:A100:closure"]).toBe(recoveredAt.toISOString());
    expect(buildSnapshot(recovered, recoveredAt)).toEqual(buildSnapshot(initial, recoveredAt));
    expect(before.locations).toEqual(buildSnapshot(recovered, now).locations);
  });
  it("caps Autobahn diagnostics after deterministic sorting", async () => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "autobahn-traffic").join(",") };
    const result = await runConditions({ now, stateStore: new MemoryStateStore(createEmptyState(now)), publish: successfulPublish,
      fetch: vi.fn(async () => { throw new Error("raw transport detail must not escape"); }), env });
    const item = result.diagnostics!.infrastructure["autobahn-traffic"];
    expect(item).toMatchObject({ attempted: 48, succeeded: 0, failed: 48, omittedTargets: 40,
      failureCodes: { unknown_failure: 48 } });
    expect(item.targetExamples).toHaveLength(8);
    expect(item.targetExamples).toEqual([...item.targetExamples].sort((a, b) => a.target.localeCompare(b.target)));
    expect(JSON.stringify(result.diagnostics)).not.toContain("raw transport detail");
  });
  it("tolerates small cron jitter without doubling conditions cadences", async () => {
    const runAt = new Date("2026-09-02T15:27:41.232Z");
    const initial = createEmptyState(runAt);
    const currentWeather = { ...weather(now), expiresAt: new Date(runAt.getTime() + 6 * 3_600_000).toISOString() };
    initial.conditions.health["rws-water"] = {
      checkedAt: new Date(runAt.getTime() - 3_600_000 + 1).toISOString(), status: "ok", matched: 7, code: null,
    };
    for (const location of locations) {
      initial.conditions.attempts[`weather:${location.id}`] = new Date(runAt.getTime() - 5 * 3_600_000 + 1).toISOString();
      initial.conditions.attempts[`airQuality:${location.id}`] = runAt.toISOString();
      initial.conditions.attempts[`marine:${location.id}`] = runAt.toISOString();
      initial.conditions.locations[location.id] = { ...(initial.conditions.locations[location.id] || emptyConditions()), weather: currentWeather };
    }
    const forecastEnv = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true" };
    expect(forecastBatches(initial, runAt, forecastEnv).some(({ kind }) => kind === "weather")).toBe(true);
    for (const location of locations) initial.conditions.attempts[`weather:${location.id}`] = new Date(runAt.getTime() - 5 * 3_600_000 + 6 * 60_000).toISOString();
    expect(forecastBatches(initial, runAt, forecastEnv).some(({ kind }) => kind === "weather")).toBe(false);

    const fetchMock = vi.fn(async () => Response.json(rwsFixture));
    await runConditions({ now: runAt, stateStore: new MemoryStateStore(initial), publish: successfulPublish, fetch: fetchMock, env: {
      LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "rws-water").join(","),
    } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("retains an unexpired Rijkswaterstaat observation when its independent refresh fails", async () => {
    const observedNow = new Date("2026-09-01T13:00:00.000Z"); const runNow = new Date("2026-09-01T13:10:00.000Z");
    const initial = createEmptyState(observedNow);
    initial.conditions.locations["nl-rotterdam"] = { observations: [], rivers: [parseRwsWater(rwsFixture, observedNow).get("rotterdam.nieuwemaas.boerengat")!],
      earthquakes: [], infrastructureIncidents: [], systemConditions: [], limitations: [] };
    const store = new MemoryStateStore(initial);
    await runConditions({ now: runNow, stateStore: store, publish: successfulPublish, fetch: vi.fn(async () => { throw new Error("RWS unavailable"); }), env: {
      LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "rws-water").join(","),
    } });
    const final = (await store.read()).data;
    expect(final.conditions.locations["nl-rotterdam"].rivers).toHaveLength(1);
    expect(final.conditions.health["rws-water"]).toMatchObject({ status: "failed", matched: 0 });
  });
  it("does not overwrite completed source health when the source is not due", async () => {
    const initial = createEmptyState(now);
    initial.conditions.health["rws-water"] = { checkedAt: now.toISOString(), status: "ok", matched: 0, code: null };
    const store = new MemoryStateStore(initial); const fetchMock = vi.fn();
    await runConditions({ now: new Date(now.getTime() + 10 * 60_000), stateStore: store, publish: successfulPublish, fetch: fetchMock, env: {
      LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "rws-water").join(","),
    } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await store.read()).data.conditions.health["rws-water"]).toEqual(initial.conditions.health["rws-water"]);
  });
  it("clears expired PSE advisories on the first successful empty refresh", async () => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "pse-energy-compass").join(",") };
    const store = new MemoryStateStore(createEmptyState(now));
    const active = { value: [{ is_active: true, usage_fcst: 2, valid_from_ts_utc: "2026-08-31T17:00:00Z",
      valid_to_ts_utc: "2026-08-31T19:00:00Z", publication_ts_utc: "2026-08-31T16:30:00Z" }] };
    await runConditions({ now, stateStore: store, publish: successfulPublish, fetch: vi.fn(async () => Response.json(active)), env });
    expect((await store.read()).data.conditions.locations["pl-warsaw"].systemConditions).toHaveLength(1);
    const publish = vi.fn(successfulPublish); const refreshAt = new Date("2026-08-31T19:01:00Z");
    await runConditions({ now: refreshAt, stateStore: store, publish, fetch: vi.fn(async () => Response.json({ value: [] })), env });
    expect((await store.read()).data.conditions.locations["pl-warsaw"]).toBeUndefined();
    const polish = (publish.mock.calls[0][0] as Conditions[]).find(({ countryCode }) => countryCode === "PL")!;
    expect(polish.locations["pl-warsaw"].systemConditions).toEqual([]);
  });
  it("replaces only ARSO gauge records, retains them after failure, and never changes alert risk", async () => {
    const observedNow = new Date("2026-09-02T07:30:00.000Z");
    const env = { LOCAL_CONDITIONS_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "arso-hydro").join(",") };
    const store = new MemoryStateStore(createEmptyState(observedNow)); const before = buildSnapshot((await store.read()).data, observedNow);
    await runConditions({ now: observedNow, stateStore: store, publish: successfulPublish,
      fetch: vi.fn(async () => new Response(arsoXml)), env });
    const successful = (await store.read()).data;
    expect(successful.conditions.locations["si-celje"].rivers).toMatchObject([
      { sourceId: "arso-hydro", stationId: "6140" }, { sourceId: "arso-hydro", stationId: "6720" },
    ]);
    expect(successful.conditions.health["arso-hydro"]).toMatchObject({ status: "ok", matched: 3 });
    expect(buildSnapshot(successful, observedNow)).toEqual(before);

    const failedStore = new MemoryStateStore(structuredClone(successful));
    await runConditions({ now: new Date("2026-09-02T08:31:00.000Z"), stateStore: failedStore, publish: successfulPublish,
      fetch: vi.fn(async () => { throw new Error("ARSO unavailable"); }), env });
    const retained = (await failedStore.read()).data;
    expect(retained.conditions.locations["si-celje"].rivers).toHaveLength(2);
    expect(retained.conditions.health["arso-hydro"]).toMatchObject({ status: "failed", matched: 0 });
  });
  it("replaces only IPMA records after healthy responses and retains them after failure", async () => {
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => !["ipma-observations", "ipma-seismic"].includes(id)).join(",") };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("obs-surface")
      ? Response.json(ipmaObservationFixture)
      : Response.json(String(input).endsWith("/3.json") ? { ...ipmaSeismicFixture, idArea: 3, data: [] } : ipmaSeismicFixture));
    const store = new MemoryStateStore(createEmptyState(now)); const before = buildSnapshot((await store.read()).data, now);
    await runConditions({ now, stateStore: store, publish: successfulPublish, fetch: fetchMock, env });
    const successful = (await store.read()).data;
    expect(successful.conditions.locations["pt-lisbon"]).toMatchObject({
      observations: [expect.objectContaining({ sourceId: "ipma-observations" })],
      earthquakes: [expect.objectContaining({ sourceId: "ipma-seismic", id: "pt-test" })],
    });
    expect(successful.conditions.health["ipma-observations"]).toMatchObject({ status: "ok", matched: 1 });
    expect(successful.conditions.health["ipma-seismic"]).toMatchObject({ status: "ok" });
    expect(successful.conditions.health["ipma-seismic"]!.matched).toBeGreaterThan(0);
    expect(buildSnapshot(successful, now)).toEqual(before);

    const refreshAt = new Date(now.getTime() + 61 * 60_000);
    const failedStore = new MemoryStateStore(structuredClone(successful));
    await runConditions({ now: refreshAt, stateStore: failedStore, publish: successfulPublish,
      fetch: vi.fn(async () => { throw new Error("IPMA unavailable"); }), env });
    const retained = (await failedStore.read()).data;
    expect(retained.conditions.locations["pt-lisbon"].observations).toHaveLength(1);
    expect(retained.conditions.locations["pt-lisbon"].earthquakes).toHaveLength(1);
    expect(retained.conditions.health["ipma-observations"]?.status).toBe("failed");
    expect(retained.conditions.health["ipma-seismic"]?.status).toBe("failed");

    const emptyStore = new MemoryStateStore(structuredClone(successful));
    await runConditions({ now: refreshAt, stateStore: emptyStore, publish: successfulPublish,
      fetch: vi.fn(async (input: RequestInfo | URL) => String(input).includes("obs-surface")
        ? Response.json({ type: "FeatureCollection", features: [] })
        : Response.json({ ...ipmaSeismicFixture, idArea: String(input).endsWith("/3.json") ? 3 : 7, updateDate: "2026-08-31T18:45:00", data: [] })), env });
    const cleared = (await emptyStore.read()).data;
    expect(cleared.conditions.locations["pt-lisbon"]).toBeUndefined();
  });
  it("preserves concurrent alert-state changes while committing conditions", async () => {
    const store = new MemoryStateStore(createEmptyState(now));
    const fetchMock = vi.fn(async () => {
      const current = await store.read(); current.data.sources.gdelt.consecutiveFailures = 7;
      await store.write(current.data, current);
      return new Response(null, { status: 204 });
    });
    await runConditions({ now, stateStore: store, publish: vi.fn(successfulPublish), fetch: fetchMock, env: { LOCAL_CONDITIONS_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "awc-metar").join(",") } });
    expect((await store.read()).data.sources.gdelt.consecutiveFailures).toBe(7);
  });
  it("keeps the longest Retry-After across concurrent rate-limit responses", async () => {
    const store = new MemoryStateStore(createEmptyState(now));
    let calls = 0;
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 429, headers: { "retry-after": String(++calls === 1 ? 7200 : 3600) },
    }));
    await runConditions({ now, stateStore: store, publish: vi.fn(successfulPublish), fetch: fetchMock, env: {
      LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(","),
    } });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect((await store.read()).data.conditions.cooldownUntil).toBe("2026-08-31T19:45:00.000Z");
  });
  it("allows only one overlapping worker to reserve and publish", async () => {
    const store = new MemoryStateStore(createEmptyState(now)); const publish = vi.fn(successfulPublish); const fetchMock = vi.fn();
    const results = await Promise.all([1, 2].map(() => runConditions({ now, stateStore: store, publish, fetch: fetchMock, env: {} })));
    expect(results.filter(({ status }) => status === "skipped")).toHaveLength(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("clears the lease after a publisher exception so the next pass can retry immediately", async () => {
    const store = new MemoryStateStore(createEmptyState(now));
    await expect(runConditions({ now, stateStore: store, env: {}, publish: async () => { throw new Error("Blob unavailable"); } })).rejects.toThrow(/Blob unavailable/);
    expect((await store.read()).data.conditions.lease).toBeNull();
    const publish = vi.fn(successfulPublish);
    await runConditions({ now, stateStore: store, env: {}, publish });
    expect(publish).toHaveBeenCalledOnce();
    expect((await store.read()).data.conditions.lease).toBeNull();
  });
  it("returns bounded partial publication diagnostics and retries on the next pass", async () => {
    const store = new MemoryStateStore(createEmptyState(now));
    const failed = locations.map(({ countryCode }) => countryCode).filter((value, index, items) => items.indexOf(value) === index).slice(0, 12)
      .map((countryCode) => ({ countryCode, code: "write_failed" as const }));
    const partial = vi.fn(async (files: Conditions[]) => ({ published: files.slice(12).map(({ countryCode }) => countryCode), unchanged: [], failed }));
    const first = await runConditions({ now, stateStore: store, env: {}, publish: partial });
    expect(first).toMatchObject({ status: "partial", publication: { published: 16, unchanged: 0, failed: 12, omittedFailures: 4 } });
    expect(first.publication?.failures).toHaveLength(8);
    expect((await store.read()).data.conditions.lease).toBeNull();
    await expect(runConditions({ now, stateStore: store, env: {}, publish: successfulPublish })).resolves.toMatchObject({ status: "disabled", publication: { published: 28, failed: 0 } });
  });
});
