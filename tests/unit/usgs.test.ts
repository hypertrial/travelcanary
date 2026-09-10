import { describe, expect, it, vi } from "vitest";
import { UsgsAdapter, earthquakeExpiresAt, mmiAtLocation, mmiLevel, parseShakeMapGrid } from "@/lib/ingestion/adapters/usgs";
import type { Location } from "@/lib/domain/schemas";
import { locations } from "@/lib/data";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

describe("USGS ShakeMap parsing", () => {
  it("fails closed when the summary is not a feature collection", async () => {
    const result = await new UsgsAdapter().fetch({
      now: new Date("2026-08-25T12:00:00Z"),
      locations: [],
      fetch: (async () => Response.json({})) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it.each([
    ["stale", -30 * 60_000 - 1],
    ["future-dated", 5 * 60_000 + 1],
  ])("rejects a %s summary update time", async (_label, offset) => {
    const now = new Date("2026-08-25T12:00:00Z");
    const result = await new UsgsAdapter().fetch({
      now, locations: [],
      fetch: (async () => Response.json({ metadata: { generated: now.getTime() + offset }, features: [] })) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "failed", events: [], error: expect.stringMatching(/stale or future-dated/) });
  });

  it("retains earthquake evidence when a later summary is stale", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const feature = {
      id: "retained", geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
      properties: { mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(), detail: "https://earthquake.usgs.gov/detail/retained", status: "automatic", place: "Vienna" },
    };
    const current = await new UsgsAdapter().fetch({
      now, locations: [location],
      fetch: (async (input: string | URL | Request) => String(input).includes("summary/4.5_day.geojson")
        ? Response.json({ metadata: { generated: now.getTime() }, features: [feature] })
        : Response.json({ properties: { products: {} } })) as typeof fetch,
    });
    const state = mergeSourceResults(createEmptyState(now), [current], now);
    const checkedAt = new Date(now.getTime() + 10 * 60_000);
    const stale = await new UsgsAdapter().fetch({
      now: checkedAt, locations: [location],
      fetch: (async () => Response.json({ metadata: { generated: now.getTime() - 31 * 60_000 }, features: [] })) as typeof fetch,
    });
    const merged = mergeSourceResults(state, [stale], checkedAt);

    expect(stale.status).toBe("failed");
    expect(merged.events).toMatchObject([{ id: "usgs:retained:at-vienna" }]);
  });

  it("finds the MMI field and numeric rows", () => {
    const grid = parseShakeMapGrid(`<shakemap_grid><grid_specification lon_min="10" lat_min="40" nominal_lon_spacing="1" nominal_lat_spacing="1" nlon="2" nlat="2"/><grid_field index="1" name="LON"/><grid_field index="2" name="LAT"/><grid_field index="3" name="MMI"/><grid_data>10 40 3.9\n11 40 4.0\n10 41 6.0\n11 41 8.0</grid_data></shakemap_grid>`);
    expect(grid.mmiIndex).toBe(2);
    expect(grid.rows[3][2]).toBe(8);
  });

  it("rejects grids without intensity", () => {
    expect(() => parseShakeMapGrid("<shakemap_grid />")).toThrow();
  });

  it("maps exact MMI boundaries", () => {
    expect(mmiLevel(3.99)).toBeNull();
    expect(mmiLevel(4)).toBe("ELEVATED");
    expect(mmiLevel(6)).toBe("HIGH");
    expect(mmiLevel(8)).toBe("SEVERE");
  });

  it("uses the strongest intensity intersecting a destination, not only its centroid", () => {
    const grid = parseShakeMapGrid(`<shakemap_grid><grid_specification lon_min="0" lat_min="0" nominal_lon_spacing="1" nominal_lat_spacing="1" nlon="2" nlat="2"/><grid_field index="1" name="LON"/><grid_field index="2" name="LAT"/><grid_field index="3" name="MMI"/><grid_data>0 0 3\n1 0 4\n0 1 5\n1 1 8</grid_data></shakemap_grid>`);
    const location: Location = {
      id: "test-region", name: "Test region", aliases: [], country: "Test", countryCode: "DE", type: "mountain",
      centroid: [0, 0], isCoastal: false, airQualitySamplePoints: [[0, 0]], geometry: { kind: "polygon", coordinates: [[[0, 0], [1.4, 0], [1.4, 1.4], [0, 1.4], [0, 0]]] },
      timezone: "Europe/Berlin", sourceRegionCodes: { meteoalarm: ["DE001"], slf: [], euregio: [], nationalCivilAlerts: [] }, provenance: { name: "https://example.com", license: "Test" }, coverageRef: "DE",
    };

    expect(mmiAtLocation(grid, location)).toBe(8);
  });

  it("extends reviewed ShakeMap evidence from its latest official update", () => {
    const feature = {
      id: "reviewed-earthquake",
      geometry: { coordinates: [10, 40, 5] as [number, number, number] },
      properties: {
        mag: 6, time: Date.parse("2026-08-25T02:00:00Z"), updated: Date.parse("2026-08-25T12:00:00Z"),
        detail: "https://earthquake.usgs.gov/detail", status: "reviewed", place: "Test", types: ",shakemap,",
      },
    };
    expect(earthquakeExpiresAt(feature, false)).toBe("2026-08-25T08:00:00.000Z");
    expect(earthquakeExpiresAt(feature, true)).toBe("2026-08-25T18:00:00.000Z");
  });

  it("processes qualifying candidates with deterministic concurrency capped at three", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const features = Array.from({ length: 5 }, (_, index) => ({
      id: `event-${index}`,
      geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
      properties: {
        mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(),
        detail: `https://earthquake.usgs.gov/detail/${index}`, status: "automatic", place: "Vienna",
      },
    }));
    let active = 0;
    let maximum = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("summary/4.5_day.geojson")) {
        return Response.json({ metadata: { generated: now.getTime() }, features });
      }
      active += 1;
      maximum = Math.max(maximum, active);
      const index = Number(url.split("/").at(-1));
      await new Promise((resolve) => setTimeout(resolve, (5 - index) * 2));
      active -= 1;
      return Response.json({ properties: { products: {} } });
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(maximum).toBe(3);
    expect(result.events.map((event) => event.id)).toEqual(features.map((feature) => `usgs:${feature.id}:${location.id}`));
  });

  it("keeps valid summary features when a sibling record is malformed", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const valid = {
      id: "valid", geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
      properties: { mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(), detail: "https://earthquake.usgs.gov/detail/valid", status: "automatic", place: "Vienna" },
    };
    const result = await new UsgsAdapter().fetch({
      now, locations: [location],
      fetch: (async (input: string | URL | Request) => String(input).includes("summary/4.5_day.geojson")
        ? Response.json({ metadata: { generated: now.getTime() }, features: [valid, { id: "broken" }] })
        : Response.json({ properties: { products: {} } })) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "partial", error: "1 USGS records were invalid" });
    expect(result.events).toMatchObject([{ id: "usgs:valid:at-vienna" }]);
  });

  it("isolates detail and grid failures while preserving preliminary evidence", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const features = ["detail-fails", "grid-fails", "detail-succeeds"].map((id) => ({
      id, geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
      properties: { mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(), detail: `https://earthquake.usgs.gov/detail/${id}`, status: "automatic", place: "Vienna" },
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("summary/4.5_day.geojson")) return Response.json({ metadata: { generated: now.getTime() }, features });
      if (url.endsWith("detail-fails") || url.endsWith("grid.xml")) return new Response("unavailable", { status: 503 });
      if (url.endsWith("grid-fails")) return Response.json({ properties: { products: { shakemap: [{ preferredWeight: 1, contents: { "download/grid.xml": { url: "https://earthquake.usgs.gov/grid.xml" } } }] } } });
      return Response.json({ properties: { products: {} } });
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(result.status).toBe("partial");
    expect(result.events.map((event) => event.id)).toEqual(features.map((feature) => `usgs:${feature.id}:${location.id}`));
    expect(result.events.every((event) => event.level === "ELEVATED" && event.confidence === "MEDIUM")).toBe(true);
  });

  it("fetches an allowlisted detail URL and keeps preliminary evidence without ShakeMap", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const detailUrl = "https://earthquake.usgs.gov/detail/on-origin";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("summary/4.5_day.geojson")) {
        return Response.json({
          metadata: { generated: now.getTime() },
          features: [{
            id: "on-origin",
            geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
            properties: {
              mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(),
              detail: detailUrl, status: "automatic", place: "Vienna",
            },
          }],
        });
      }
      if (url === detailUrl) return Response.json({ properties: { products: {} } });
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(result.status).toBe("ok");
    expect(result.events).toMatchObject([{ id: "usgs:on-origin:at-vienna", level: "ELEVATED", confidence: "MEDIUM" }]);
    expect(result.events[0].earthquake).toEqual({ ids: ["on-origin"], coordinates: location.centroid, magnitude: 4.8 });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      detailUrl,
    ]);
  });

  it("does not fetch off-allowlist detail or grid URLs and keeps preliminary evidence", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("summary/4.5_day.geojson")) {
        return Response.json({
          metadata: { generated: now.getTime() },
          features: [{
            id: "off-origin",
            geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
            properties: {
              mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(),
              detail: "https://example.invalid/usgs-detail", status: "automatic", place: "Vienna",
            },
          }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(result.status).toBe("partial");
    expect(result.events).toMatchObject([{ id: "usgs:off-origin:at-vienna", level: "ELEVATED", confidence: "MEDIUM" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch an off-allowlist ShakeMap grid URL and keeps preliminary evidence", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const detailUrl = "https://earthquake.usgs.gov/detail/off-grid";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("summary/4.5_day.geojson")) {
        return Response.json({
          metadata: { generated: now.getTime() },
          features: [{
            id: "off-grid",
            geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
            properties: {
              mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(),
              detail: detailUrl, status: "automatic", place: "Vienna",
            },
          }],
        });
      }
      if (url === detailUrl) {
        return Response.json({
          properties: {
            products: {
              shakemap: [{ preferredWeight: 1, contents: { "download/grid.xml": { url: "https://example.invalid/grid.xml" } } }],
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(result.status).toBe("partial");
    expect(result.events).toMatchObject([{ id: "usgs:off-grid:at-vienna", level: "ELEVATED", confidence: "MEDIUM" }]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      detailUrl,
    ]);
  });

  it("follows USGS detail redirects only while they remain on the allowlist", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("summary/4.5_day.geojson")) {
        return Response.json({
          metadata: { generated: now.getTime() },
          features: [{
            id: "redirected",
            geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] },
            properties: {
              mag: 4.8, time: now.getTime() - 60_000, updated: now.getTime(),
              detail: "https://earthquake.usgs.gov/detail/start", status: "automatic", place: "Vienna",
            },
          }],
        });
      }
      if (url === "https://earthquake.usgs.gov/detail/start") {
        return new Response(null, { status: 302, headers: { location: "https://example.invalid/grid.xml" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(result.events).toMatchObject([{ id: "usgs:redirected:at-vienna", confidence: "MEDIUM" }]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      "https://earthquake.usgs.gov/detail/start",
    ]);
  });

  it("does not queue deleted or geographically irrelevant candidates", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const location = locations.find((candidate) => candidate.id === "at-vienna")!;
    const base = { mag: 5, time: now.getTime() - 60_000, updated: now.getTime(), detail: "https://earthquake.usgs.gov/should-not-load", place: "Test" };
    const features = [
      { id: "deleted", geometry: { coordinates: [location.centroid[0], location.centroid[1], 5] }, properties: { ...base, status: "deleted" } },
      { id: "far", geometry: { coordinates: [-150, -40, 5] }, properties: { ...base, status: "automatic" } },
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (!String(input).includes("summary/4.5_day.geojson")) throw new Error("candidate entered worker queue");
      return Response.json({ metadata: { generated: now.getTime() }, features });
    });
    const result = await new UsgsAdapter().fetch({ now, locations: [location], fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ status: "ok", events: [], removedEventPrefixes: ["usgs:deleted:"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


it.each([1, 7])("retains reviewed shaking after a failed grid refresh %i hours after the quake", async (hours) => {
  const now = new Date("2026-08-25T12:00:00Z");
  const location = locations.find(({ id }) => id === "at-vienna")!;
  const feature = { id: "retained-grid", geometry: { coordinates: [...location.centroid, 5] }, properties: {
    mag: 6, time: now.getTime() - hours * 3600000, updated: now.getTime(),
    detail: "https://earthquake.usgs.gov/detail/retained-grid", status: "reviewed", place: "Vienna",
  } };
  const fetchResult = async (at: Date, mmi: number | null, invalidSibling = false) => new UsgsAdapter().fetch({ now: at, locations: [location], fetch: async (input) => {
    const url = String(input);
    if (url.includes("/summary/")) return Response.json({ metadata: { generated: at.getTime() }, features: [feature, ...(invalidSibling ? [{}] : [])] });
    if (url.includes("/detail/")) return Response.json({ properties: { products: { shakemap: [{ contents: { "download/grid.xml": { url: "https://earthquake.usgs.gov/grid.xml" } } }] } } });
    if (mmi === null) throw new DOMException("Network unavailable", "AbortError");
    return new Response(`<shakemap_grid><grid_specification nominal_lon_spacing="1" nominal_lat_spacing="1"/><grid_field index="3" name="MMI"/><grid_data>${location.centroid.join(" ")} ${mmi}</grid_data></shakemap_grid>`);
  } });
  const initial = await fetchResult(now, 8);
  expect(initial.events[0]).toMatchObject({ level: "SEVERE", confidence: "HIGH" });
  const state = mergeSourceResults(createEmptyState(now), [initial], now);
  const later = new Date(now.getTime() + 600000);
  // The adapter's initial read need not contain the evidence committed before its merge.
  const failed = await fetchResult(later, null);
  expect(failed.status).toBe("partial");
  expect(mergeSourceResults(state, [failed], later).events).toEqual(initial.events);
  const recovered = await fetchResult(later, 6, true);
  expect(recovered.status).toBe("partial");
  expect(mergeSourceResults(state, [recovered], later).events[0].level).toBe("HIGH");
  const clear = await fetchResult(later, 2, true);
  expect(clear.status).toBe("partial");
  expect(mergeSourceResults(state, [clear], later).events).toEqual([]);
});
