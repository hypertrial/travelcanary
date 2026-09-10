import { describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/conditions/opw-hydrology.json";
import { opwHydroEndpoint, opwHydroMappings, parseOpwHydrology } from "@/lib/conditions/opw";
import { runConditions } from "@/lib/conditions/worker";
import { conditionSourceIds, emptyConditions, type Conditions } from "@/lib/domain/conditions";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { MemoryStateStore } from "@/lib/storage";

const now = new Date("2026-09-08T07:30:00Z");
const env = { LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "opw-hydro").join(",") };
const successfulPublish = async (files: Conditions[]) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] });
const single = (properties: Partial<typeof fixture.features[number]["properties"]> = {}) => ({
  type: "FeatureCollection", features: [{ ...structuredClone(fixture.features[0]), properties: { ...fixture.features[0].properties, ...properties } }],
});

describe("OPW observation contract", () => {
  it("maps the six real stations without applying the Malin Head offset or changing UTC", () => {
    const result = parseOpwHydrology(fixture, now);
    expect(result.size).toBe(6);
    for (const mapping of opwHydroMappings) {
      const row = fixture.features.find(({ properties }) => properties.station_ref === mapping.stationId.padStart(10, "0"))!;
      expect(result.get(mapping.stationId)).toMatchObject({ sourceId: "opw-hydro", stationId: mapping.stationId,
        stationName: `${mapping.waterBody} — ${mapping.stationName}`, sourceUrl: mapping.stationUrl,
        datum: "Local staff-gauge zero", qualityCode: "99", qualityStatus: "provisional",
        observedAt: "2026-09-08T07:15:00.000Z", sourceUpdatedAt: "2026-09-08T07:15:00.000Z",
        checkedAt: now.toISOString(), expiresAt: "2026-09-08T09:15:00.000Z",
        measurements: [{ metric: "water-level", value: Number(row.properties.value), unit: "m" }] });
    }
  });
  it.each([0, 1, -1, 100])("does not publish unreviewed quality code %s", (err_code) => {
    expect(parseOpwHydrology(single({ err_code }), now).size).toBe(0);
  });
  it.each(["", " ", "NaN", "1e2", "1,2", "1000.001", "-1000.001"])("rejects invalid level %j", (value) => {
    expect(parseOpwHydrology(single({ value }), now).size).toBe(0);
  });
  it.each(["-0.1", "0", "1000", "-1000"])("accepts finite gauge boundary %s", (value) => {
    expect(parseOpwHydrology(single({ value }), now).get("09369")?.measurements[0].value).toBe(Number(value));
  });
  it.each([
    ["2026-09-08T05:30:00Z", false], ["2026-09-08T05:30:01Z", true],
    ["2026-09-08T07:35:00Z", true], ["2026-09-08T07:35:01Z", false],
    ["2026-09-08T07:15:00", false], ["2026-09-08T08:15:00+01:00", false],
    ["2026-02-30T07:15:00Z", false], ["not-a-date", false],
  ])("enforces UTC and freshness for %s", (datetime, accepted) => {
    expect(parseOpwHydrology(single({ datetime }), now).size).toBe(accepted ? 1 : 0);
  });
  it("fails closed on missing required data and malformed collections", () => {
    const missing = single(); Reflect.deleteProperty(missing.features[0].properties, "value");
    expect(() => parseOpwHydrology(missing, now)).toThrow();
    for (const input of [null, {}, { type: "FeatureCollection", features: null }]) {
      expect(() => parseOpwHydrology(input, now)).toThrow();
    }
  });
  it("ignores unmapped stations and alternate sensors", () => {
    expect(parseOpwHydrology(single({ station_ref: "0000049999" }), now).size).toBe(0);
    expect(parseOpwHydrology(single({ sensor_ref: "0002" }), now).size).toBe(0);
  });
  it("fails the response on mapped station name or coordinate drift", () => {
    expect(() => parseOpwHydrology(single({ station_name: "Different station" }), now)).toThrow(/contract changed/);
    const moved = single(); moved.features[0].geometry.coordinates[0] += 0.01;
    expect(() => parseOpwHydrology(moved, now)).toThrow(/contract changed/);
  });
  it("deduplicates identical readings, selects the newest independent of order, and rejects conflicts", () => {
    const current = single().features[0]; const old = single({ datetime: "2026-09-08T07:00:00Z", value: "0.2" }).features[0];
    for (const features of [[current, old, current], [old, current, current]]) {
      expect(parseOpwHydrology({ type: "FeatureCollection", features }, now).get("09369")?.measurements[0].value).toBe(0.436);
    }
    for (const properties of [{ value: "0.5" }, { err_code: 0 }]) {
      expect(() => parseOpwHydrology({ type: "FeatureCollection", features: [current, single(properties).features[0]] }, now)).toThrow(/Conflicting/);
    }
  });
});

describe("OPW worker publication and recovery", () => {
  it("fetches the official endpoint and publishes six observations without altering warning risk or coverage", async () => {
    const initial = createEmptyState(now); const before = buildSnapshot(initial, now);
    const store = new MemoryStateStore(initial); const publish = vi.fn(successfulPublish);
    const fetchMock = vi.fn(async () => Response.json(fixture));
    await runConditions({ now, env, stateStore: store, publish, fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(opwHydroEndpoint, expect.objectContaining({ redirect: "error" }));
    const state = (await store.read()).data;
    expect(state.conditions.health["opw-hydro"]).toMatchObject({ status: "ok", matched: 6 });
    const ireland = publish.mock.calls[0][0].find(({ countryCode }) => countryCode === "IE")!;
    for (const mapping of opwHydroMappings) {
      expect(ireland.locations[mapping.locationId].rivers).toMatchObject([{ sourceId: "opw-hydro", stationId: mapping.stationId }]);
    }
    expect(buildSnapshot(state, now)).toEqual(before);
  });
  it.each(["empty", "network", "contract"])("handles %s refresh without removing another source's readings", async (kind) => {
    const initial = createEmptyState(now); const opw = parseOpwHydrology(fixture, now).get("09369")!;
    const other = { ...opw, sourceId: "rws-water" as const, stationId: "other-source" };
    initial.conditions.locations["ie-dublin"] = { ...emptyConditions(), rivers: [other, opw] };
    const store = new MemoryStateStore(initial);
    const fetchMock = vi.fn(async () => {
      if (kind === "network") throw new Error("upstream unavailable");
      return Response.json(kind === "empty" ? { type: "FeatureCollection", features: [] } : single({ station_name: "Drift" }));
    });
    await runConditions({ now, env, stateStore: store, publish: successfulPublish, fetch: fetchMock });
    const state = (await store.read()).data;
    expect(state.conditions.locations["ie-dublin"].rivers).toEqual(kind === "empty" ? [other] : [other, opw]);
    expect(state.conditions.health["opw-hydro"]).toMatchObject({ status: kind === "empty" ? "ok" : "failed", matched: 0 });
  });
  it("disabling OPW suppresses fetching and cached publication without changing warning coverage", async () => {
    const initial = createEmptyState(now);
    initial.conditions.locations["ie-dublin"] = { ...emptyConditions(), rivers: [parseOpwHydrology(fixture, now).get("09369")!] };
    const before = buildSnapshot(initial, now); const store = new MemoryStateStore(initial);
    const publish = vi.fn(successfulPublish); const fetchMock = vi.fn();
    await runConditions({ now, env: { ...env, CONDITIONS_DISABLED_SOURCES: conditionSourceIds.join(",") }, stateStore: store, publish, fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    for (const file of publish.mock.calls[0][0]) for (const location of Object.values(file.locations)) {
      expect(location.rivers.some(({ sourceId }) => sourceId === "opw-hydro")).toBe(false);
    }
    expect(buildSnapshot((await store.read()).data, now)).toEqual(before);
  });
});
