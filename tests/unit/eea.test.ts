import { describe, expect, it } from "vitest";
import { coverageByLocation, locations } from "@/lib/data";
import { EeaAdapter, eeaLevel, eeaTargetTime, parseCanaryFeatureInfo, parseEeaSamples } from "@/lib/ingestion/adapters/eea";
import { createSourceDiagnostics } from "@/lib/ingestion/types";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";

const now = new Date("2026-08-26T18:38:00Z");
const sourceTime = eeaTargetTime(now);
const selected = ["at-vienna", "hu-budapest"].map((id) => locations.find((location) => location.id === id)!);

function eeaFetch(samples: unknown[]): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/getSamples")) return new Response(JSON.stringify({ samples }), { status: 200 });
    if (url.endsWith("/42?f=json")) return new Response(JSON.stringify({ attributes: { StdTime: sourceTime.getTime() } }), { status: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

describe("EEA air-quality adapter", () => {
  it("does not make unsupported Canary destinations unavailable when the continental raster fails", async () => {
    const canary = locations.find(({ id }) => id === "es-las-palmas-de-gran-canaria")!;
    const requested: string[] = [];
    const result = await new EeaAdapter().fetch({ now, locations: [...selected, canary],
      fetch: (async (input) => { requested.push(String(input)); return new Response("upstream failure", { status: 503 }); }) as typeof fetch });
    expect(result.partitions.AT.status).toBe("failed");
    expect(result.partitions.ES).toMatchObject({ status: "ok", events: [], checkedLocationIds: [], unavailableLocationIds: [] });
    expect(result.partitions.ES.transports?.["canary-air"]?.status).toBe("ok");
    expect(requested.some((url) => url.includes("idecan2.grafcan.es"))).toBe(false);
  });
  it("uses exact official AQI category thresholds", () => {
    expect([1, 2, 3, 4, 5, 6].map(eeaLevel)).toEqual([null, null, null, "ELEVATED", "HIGH", "SEVERE"]);
    expect(sourceTime.toISOString()).toBe("2026-08-26T15:00:00.000Z");
  });

  it("rejects malformed and out-of-range samples", () => {
    expect(parseEeaSamples({ samples: [
      { locationId: 0, value: "4.000000", rasterId: 42 },
      { locationId: 2, value: 6, rasterId: 42 },
      { locationId: 1, value: 7, rasterId: 42 },
    ] }, 2)).toEqual([{ pointIndex: 0, category: 4, rasterId: 42 }]);
  });

  it("parses the official Canary feature palette and rejects stale readings", () => {
    expect(parseCanaryFeatureInfo("Feature 0:\n level = '6'\n update_at = '2026-08-26 18:00:00'", now)).toMatchObject({ category: 6 });
    expect(parseCanaryFeatureInfo("Feature 0:\n level = '4'\n update_at = '2026-08-25 18:00:00'", now)).toBeNull();
    expect(() => parseCanaryFeatureInfo("Feature 0:\n level = '0'\n update_at = '2026-08-26 18:00:00'", now)).toThrow(/malformed/);
    expect(() => parseCanaryFeatureInfo("Feature 0:\n level = 'unknown'", now)).toThrow(/malformed/);
    expect(() => parseCanaryFeatureInfo("Feature 0:\n level = '4'\n request_at = '2026-08-26 18:00:00'", now)).toThrow(/malformed/);
    expect(parseCanaryFeatureInfo("Feature 20:\n level = '2'\n request_at = '2026-08-31T19:54'\n update_at = '2026-08-31 19:54:13'", new Date("2026-08-31T18:58:00Z"))).toBeNull();
  });

  it("publishes location-specific risk and checked coverage", async () => {
    const result = await new EeaAdapter().fetch({
      now, locations: selected,
      fetch: eeaFetch([
        { locationId: 0, value: "4.000000000", rasterId: 42 },
        { locationId: 1, value: "6.000000000", rasterId: 42 },
      ]),
    });

    expect(result.partitions.AT).toMatchObject({ status: "ok", checkedLocationIds: ["at-vienna"], unavailableLocationIds: [] });
    expect(result.partitions.HU).toMatchObject({ status: "ok", checkedLocationIds: ["hu-budapest"], unavailableLocationIds: [] });
    expect(result.partitions.AT.events[0]).toMatchObject({ level: "ELEVATED", providerId: "eea-aqi", confidence: "MEDIUM" });
    expect(result.partitions.HU.events[0]).toMatchObject({ level: "SEVERE", expiresAt: "2026-08-26T21:00:00.000Z" });
  });

  it("uses the worst valid sample for a destination", async () => {
    const location = { ...selected[1], airQualitySamplePoints: [selected[1].centroid, [19.04, 47.5] as [number, number]] };
    const diagnostics = createSourceDiagnostics();
    const result = await new EeaAdapter().fetch({
      now, locations: [location],
      fetch: eeaFetch([
        { locationId: 0, value: 3, rasterId: 42 },
        { locationId: 1, value: 5, rasterId: 42 },
      ]),
      diagnostics,
    });
    expect(result.partitions.HU.events[0]).toMatchObject({ level: "HIGH" });
    expect(diagnostics).toMatchObject({
      recordsExamined: 2, targetsScheduled: 2, targetsCompleted: 2, matchedLocations: 1,
    });
  });

  it("bounds multipoint requests to 250 samples", async () => {
    const requestedPointCounts: number[] = [];
    const manyLocations = Array.from({ length: 251 }, (_, index) => ({ ...selected[0], id: `at-test-${index}` }));
    const boundedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getSamples")) {
        const body = new URLSearchParams(String(init?.body));
        const geometry = JSON.parse(body.get("geometry")!) as { points: unknown[] };
        requestedPointCounts.push(geometry.points.length);
        return new Response(JSON.stringify({ samples: geometry.points.map((_, index) => ({ locationId: index, value: 1, rasterId: 42 })) }), { status: 200 });
      }
      if (url.endsWith("/42?f=json")) return new Response(JSON.stringify({ attributes: { StdTime: sourceTime.getTime() } }), { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new EeaAdapter().fetch({ now, locations: manyLocations, fetch: boundedFetch });

    expect(requestedPointCounts).toEqual([250, 1]);
    expect(result.partitions.AT.checkedLocationIds).toHaveLength(251);
  });

  it("marks only destinations without a valid pixel unavailable", async () => {
    const result = await new EeaAdapter().fetch({
      now, locations: selected,
      fetch: eeaFetch([{ locationId: 0, value: "3.000000000", rasterId: 42 }]),
    });
    expect(result.partitions.AT.status).toBe("ok");
    expect(result.partitions.HU).toMatchObject({ status: "partial", unavailableLocationIds: ["hu-budapest"] });
    expect(result.partitions.HU.events).toEqual([]);
  });

  it("excludes permanently unsupported island destinations from EEA requests and health", async () => {
    const canaryIds = ["es-las-palmas-de-gran-canaria", "es-santa-cruz-de-tenerife"];
    const canaries = canaryIds.map((id) => locations.find((location) => location.id === id)!);
    const azores = ["pt-ponta-delgada", "pt-horta", "pt-santa-cruz-das-flores"].map((id) => locations.find((location) => location.id === id)!);
    const vienna = locations.find((location) => location.id === "at-vienna")!;
    const requested: string[] = [];
    const fetchMock = eeaFetch([{ locationId: 0, value: 2, rasterId: 42 }]);
    const result = await new EeaAdapter().fetch({ now, locations: [...canaries, ...azores, vienna], fetch: (async (input, init) => {
      requested.push(String(input)); return fetchMock(input, init);
    }) as typeof fetch });

    expect(result.partitions.ES).toMatchObject({ status: "ok", checkedLocationIds: [], unavailableLocationIds: [], events: [] });
    expect(result.partitions.PT).toMatchObject({ status: "ok", checkedLocationIds: [], unavailableLocationIds: [], events: [] });
    expect(result.partitions.AT).toMatchObject({ status: "ok", checkedLocationIds: ["at-vienna"], unavailableLocationIds: [] });
    expect([...canaryIds, ...azores.map(({ id }) => id)].every((id) => coverageByLocation[id]?.["air-quality"]?.status === "not_monitored")).toBe(true);
    expect(requested.some((url) => url.includes("idecan2.grafcan.es"))).toBe(false);
  });

  it("accepts bounded live-sized batches and exposes a catalog-wide severe snapshot to the hard size guard", async () => {
    const allSevereFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getSamples")) {
        const geometry = JSON.parse(new URLSearchParams(String(init?.body)).get("geometry")!) as { points: unknown[] };
        return new Response(JSON.stringify({
          samples: geometry.points.map((_, index) => ({ locationId: index, value: 6, rasterId: 42 })),
          padding: "x".repeat(50_000),
        }));
      }
      if (url.endsWith("/42?f=json")) return new Response(JSON.stringify({ attributes: { StdTime: sourceTime.getTime() } }));
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const result = await new EeaAdapter().fetch({ now, locations, fetch: allSevereFetch });
    const state = mergeSourceResults(createEmptyState(now), [result], now);
    const bytes = Buffer.byteLength(JSON.stringify(buildSnapshot(state, now)));

    expect(Object.values(result.partitions).flatMap((partition) => partition.events)).toHaveLength(locations.length - 5);
    expect(bytes).toBeGreaterThan(500_000);
    expect(bytes).toBeLessThan(700_000);
  });
});


it.each([1, 4, 6])("marks missing sibling AQI points unavailable while retaining the worst known category (remaining=%i)", async (category) => {
  const location = locations.find(({ id }) => id === "bg-bulgarian-black-sea-coast")!;
  expect(location.airQualitySamplePoints).toHaveLength(2);
  const adapter = new EeaAdapter();
  const initial = await adapter.fetch({ now, locations: [location], fetch: eeaFetch([
    { locationId: 0, value: 1, rasterId: 42 }, { locationId: 1, value: 5, rasterId: 42 },
  ]) });
  const state = mergeSourceResults(createEmptyState(now), [initial], now);
  const partial = await adapter.fetch({ now, locations: [location], fetch: eeaFetch([{ locationId: 0, value: category, rasterId: 42 }]) });
  expect(partial.partitions.BG).toMatchObject({ status: "partial", checkedLocationIds: [], unavailableLocationIds: [location.id],
    transports: { "eea-raster": { status: "partial", checkedLocationIds: [], unavailableLocationIds: [location.id] } } });
  expect(mergeSourceResults(state, [partial], now).events[0].level).toBe(category === 6 ? "SEVERE" : "HIGH");
  const healthy = await adapter.fetch({ now, locations: [location], fetch: eeaFetch([
    { locationId: 0, value: 1, rasterId: 42 }, { locationId: 1, value: 1, rasterId: 42 },
  ]) });
  expect(healthy.partitions.BG).toMatchObject({ status: "ok", checkedLocationIds: [location.id], unavailableLocationIds: [] });
  expect(mergeSourceResults(state, [healthy], now).events).toEqual([]);
});
