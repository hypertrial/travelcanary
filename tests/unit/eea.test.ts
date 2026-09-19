import { describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import {
  EeaAdapter, eeaLevel, eeaTargetTime, observationBackedEeaDetail, parseCanaryFeatureInfo, parseEeaHourlyMap,
  parseEeaSamples, parseEeaStationIndex, selectEeaDetailStations,
} from "@/lib/ingestion/adapters/eea";
import { createSourceDiagnostics } from "@/lib/ingestion/types";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

const now = new Date("2026-08-26T18:38:00Z");
const sourceTime = eeaTargetTime(now);
const vienna = locations.find(({ id }) => id === "at-vienna")!;
const revision = "raw_stations.json.26091100";
const stations = [
  { code: "AT9STEF", operational: 1, lon: 16.373254, lat: 48.20815 },
  { code: "AT90TAB", operational: 1, lon: 16.380918, lat: 48.216739 },
];

function stationFetch(options: { category?: number; detailCategory?: number; modelled?: boolean; omitMap?: boolean; detailFailure?: boolean } = {}): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.endsWith("/content/index.json")) return Response.json({ contents: [revision] });
    if (url.endsWith(`/content/${revision}`)) return Response.json(stations);
    if (url.includes("/map/")) return Response.json(options.omitMap ? {} : {
      AT9STEF: options.category ?? 4, AT9STEF_cp: 1, AT90TAB: 2, AT90TAB_cp: 1,
    });
    if (url.endsWith("/current/AT9STEF.json")) {
      if (options.detailFailure) throw new Error("station detail offline");
      return Response.json({ [sourceTime.toISOString()]: {
      aqi: options.detailCategory ?? options.category ?? 4, culprit: "PM10", val_PM10: 55, modelled_PM10: options.modelled ? 1 : 0,
      } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

describe("EEA observation-backed air-quality adapter", () => {
  it("uses exact official AQI thresholds and a lagged bounded hourly artifact", () => {
    expect([1, 2, 3, 4, 5, 6].map(eeaLevel)).toEqual([null, null, null, "ELEVATED", "HIGH", "SEVERE"]);
    expect(sourceTime.toISOString()).toBe("2026-08-26T15:00:00.000Z");
  });

  it("validates station metadata, hourly maps, and observation provenance", () => {
    expect(parseEeaStationIndex([...stations, { code: "ATBAD", operational: 0, lon: 16, lat: 48 }]).size).toBe(2);
    expect([...parseEeaHourlyMap({ AT9STEF: 4.2, AT9STEF_cp: 1, bad: 6 }).entries()]).toEqual([["AT9STEF", 4.2]]);
    expect([...parseEeaHourlyMap({ AT9STEF: 0, AT9STEF_cp: 1, AT90TAB: null, AT90TAB_cp: 1 }).entries()]).toEqual([]);
    const observed = { [sourceTime.toISOString()]: { aqi: 4.2, culprit: "PM10", val_PM10: 55, modelled_PM10: 0 } };
    expect(observationBackedEeaDetail(observed, sourceTime)).toEqual({ category: 4.2, pollutant: "PM10" });
    expect(observationBackedEeaDetail({ [sourceTime.toISOString()]: { ...observed[sourceTime.toISOString()], modelled_PM10: 1 } }, sourceTime)).toBeNull();
    expect(observationBackedEeaDetail({ [sourceTime.toISOString()]: { aqi: 6, culprit: "PM10", val_PM10: null, modelled_PM10: null } }, sourceTime)).toBeNull();
    expect(observationBackedEeaDetail({ [sourceTime.toISOString()]: { aqi: 999, culprit: "PM10", val_PM10: 55, modelled_PM10: 0 } }, sourceTime)).toBeNull();
  });

  it("emits partial monitoring only for an observation-backed poor-or-worse culprit", async () => {
    const diagnostics = createSourceDiagnostics();
    const result = await new EeaAdapter().fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5 }), diagnostics });
    expect(result.partitions.AT).toMatchObject({ status: "partial", checkedLocationIds: ["at-vienna"], unavailableLocationIds: [],
      limitationCode: "observation_only_partial_coverage" });
    expect(result.partitions.AT.events[0]).toMatchObject({ level: "HIGH", providerId: "eea-aqi", confidence: "HIGH", transportId: "eea-stations" });
    expect(result.partitions.AT.events[0].explanation).toMatch(/observation-backed PM10/);
    expect(diagnostics).toMatchObject({ targetsScheduled: 1, targetsCompleted: 1, matchedLocations: 1 });
  });

  it("keeps modeled poor values as context and never turns them into monitoring evidence", async () => {
    const result = await new EeaAdapter().fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5, modelled: true }) });
    expect(result.partitions.AT).toMatchObject({ status: "partial", checkedLocationIds: [], unavailableLocationIds: ["at-vienna"], events: [] });
  });

  it("retains poor-air evidence when the next map is missing or its detail contradicts the poor category", async () => {
    const adapter = new EeaAdapter();
    const initial = await adapter.fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5 }) });
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    for (const next of [stationFetch({ category: 0 }), stationFetch({ category: 5, detailCategory: 2 })]) {
      const later = new Date(now.getTime() + 60 * 60_000);
      const result = await adapter.fetch({ now: later, locations: [vienna], fetch: next });
      expect(result.partitions.AT).toMatchObject({ checkedLocationIds: [], unavailableLocationIds: ["at-vienna"], events: [] });
      expect(mergeSourceResults(state, [result], later).events).toEqual(state.events);
    }
  });

  it.each([1, 2, 3])("refreshes partial coverage for normal or low category %i without inferring a destination-wide all-clear", async (category) => {
    const fetchMock = stationFetch({ category });
    const result = await new EeaAdapter().fetch({ now, locations: [vienna], fetch: fetchMock });
    expect(result.partitions.AT).toMatchObject({ status: "partial", checkedLocationIds: ["at-vienna"], unavailableLocationIds: [], events: [],
      limitationCode: "observation_only_partial_coverage" });
    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input).includes("/current/"))).toBe(false);
  });

  it("clears an earlier poor-air event after a current fair observation", async () => {
    const adapter = new EeaAdapter();
    const initial = await adapter.fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5 }) });
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    const later = new Date(now.getTime() + 60 * 60_000);
    const fair = await adapter.fetch({ now: later, locations: [vienna], fetch: stationFetch({ category: 2 }) });

    expect(mergeSourceResults(state, [fair], later).events).toEqual([]);
  });

  it("keeps expected station partial coverage current across consecutive healthy polls", async () => {
    const adapter = new EeaAdapter();
    let state = createEmptyState(now);
    state = mergeSourceResults(state, [await adapter.fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5 }) })], now);
    state = mergeSourceResults(state, [await adapter.fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5 }) })], now);

    expect(state.sourcePartitions.eea.AT.status).toBe("partial");
    expect(state.partitionTransports.eea.AT["eea-stations"].status).toBe("partial");
  });

  it("fails closed when the reviewed metadata revision or hourly station value is unavailable", async () => {
    const missingRevision = vi.fn(async (input) => String(input).endsWith("index.json") ? Response.json({ contents: [] }) : Response.json([])) as typeof fetch;
    expect((await new EeaAdapter().fetch({ now, locations: [vienna], fetch: missingRevision })).partitions.AT).toMatchObject({ status: "failed", checkedLocationIds: [], unavailableLocationIds: ["at-vienna"] });
    expect((await new EeaAdapter().fetch({ now, locations: [vienna], fetch: stationFetch({ omitMap: true }) })).partitions.AT).toMatchObject({ status: "partial", checkedLocationIds: [], unavailableLocationIds: ["at-vienna"] });
    expect((await new EeaAdapter().fetch({ now, locations: [vienna], fetch: stationFetch({ category: 5, detailFailure: true }) })).partitions.AT)
      .toMatchObject({ status: "partial", checkedLocationIds: [], unavailableLocationIds: ["at-vienna"], events: [] });
  });

  it("bounds poor-station detail work deterministically without failing unrelated candidates", () => {
    const codes = Array.from({ length: 40 }, (_, index) => `AT${String(index).padStart(5, "0")}`);
    const result = selectEeaDetailStations(codes.reverse());
    expect(result.selected).toEqual([...codes].sort().slice(0, 32));
    expect(result.unavailable).toEqual([...codes].sort().slice(32));
  });

  it("keeps deprecated raster and Canary parsers deterministic without using either transport", () => {
    expect(parseEeaSamples({ samples: [{ locationId: 0, value: "4.000000", rasterId: 42 }, { locationId: 2, value: 6, rasterId: 42 }] }, 1))
      .toEqual([{ pointIndex: 0, category: 4, rasterId: 42 }]);
    expect(parseCanaryFeatureInfo("Feature 0:\n level = '6'\n update_at = '2026-08-26 18:00:00'", now)).toMatchObject({ category: 6 });
  });

  it("rejects malformed and unbounded station artifacts", () => {
    expect(() => parseEeaStationIndex({})).toThrow(/malformed/);
    expect(() => parseEeaHourlyMap([])).toThrow(/malformed/);
    expect(() => observationBackedEeaDetail(Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [String(index), {}])), sourceTime)).toThrow(/unbounded/);
  });
});
