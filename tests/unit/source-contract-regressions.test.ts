import { describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { EmscAdapter } from "@/lib/ingestion/adapters/emsc";
import { EonetAdapter } from "@/lib/ingestion/adapters/eonet";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

const now = new Date("2026-09-08T12:00:00Z");
const vienna = locations.find(({ id }) => id === "at-vienna")!;
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
// Synthetic distinct earthquakes isolate feed completeness from malformed records.
const feature = (id: string, occurred = new Date(now.getTime() - 3_600_000)) => ({
  id, geometry: { type: "Point", coordinates: [...vienna.centroid, 10] },
  properties: { mag: 4.5, time: occurred.toISOString(), lastupdate: occurred.toISOString(), unid: id },
});
async function emsc(features: ReturnType<typeof feature>[], at = now) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: "FeatureCollection", features }));
  const result = await new EmscAdapter().fetch({ now: at, locations: [vienna], fetch: fetchMock });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.searchParams.get("limit")).toBe("200");
  expect(url.searchParams.get("orderby")).toBe("time");
  return result;
}

describe("EMSC capped response completeness", () => {
  it.each([199, 200, 201])("treats %i valid records according to the requested page boundary", async (count) => {
    const result = await emsc(Array.from({ length: count }, (_, index) => feature(`page-${index}`)));
    expect(result.events).toHaveLength(Math.min(count, 200));
    expect(new Set(result.events.map(({ id }) => id)).size).toBe(result.events.length);
    expect(result.status).toBe(count < 200 ? "ok" : "partial");
    expect(result.error).toEqual(count < 200 ? null : expect.stringContaining("event limit reached"));
    if (count > 200) expect(result.events.some(({ id }) => id === "emsc:page-200:at-vienna")).toBe(false);
  });

  it("retains omitted evidence through capped refresh and replay, then clears it on complete recovery", async () => {
    const first = await emsc([feature("prior")]);
    let state = mergeSourceResults(createEmptyState(now), [first], now);
    const prior = structuredClone(state.events[0]);
    expect(prior.id).toBe("emsc:prior:at-vienna");
    // Distinct external identity AND occurrence time avoid legitimate cross-provider deduplication.
    const unrelated = { ...prior, id: "usgs:independent:at-vienna", sourceId: "usgs" as const, providerId: "usgs" as const,
      startsAt: "2026-09-08T11:10:00Z", earthquake: { ...prior.earthquake!, ids: ["independent"] },
      sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/independent",
    };
    state.events.push(unrelated);
    const page = Array.from({ length: 200 }, (_, index) => feature(`page-${index}`));
    const capped = await emsc(page, later(1));
    state = mergeSourceResults(state, [capped], later(1));
    expect(state.events.find(({ id }) => id === prior.id)).toEqual(prior);
    expect(state.events.filter(({ sourceId }) => sourceId === "emsc")).toHaveLength(201);
    expect(state.events.find(({ id }) => id === unrelated.id)).toEqual(unrelated);

    state = mergeSourceResults(state, [await emsc(page, later(2))], later(2));
    expect(state.events.find(({ id }) => id === prior.id)).toEqual(prior);
    expect(new Set(state.events.map(({ id }) => id)).size).toBe(state.events.length);
    expect(state.events.filter(({ sourceId }) => sourceId === "emsc")).toHaveLength(201);

    const recovered = await emsc(page.slice(0, 199), later(3));
    expect(recovered.status).toBe("ok");
    state = mergeSourceResults(state, [recovered], later(3));
    expect(state.events.filter(({ sourceId }) => sourceId === "emsc").map(({ id }) => id).sort()).toEqual(recovered.events.map(({ id }) => id).sort());
    expect(state.events.some(({ id }) => id === prior.id || id === "emsc:page-199:at-vienna")).toBe(false);
    expect(state.events.find(({ id }) => id === unrelated.id)).toEqual(unrelated);
    expect(state.sources.emsc.status).toBe("ok");
  });

  it("does not extend retained evidence beyond its original expiry during a capped refresh", async () => {
    const first = await emsc([feature("expiring", new Date(now.getTime() - 6 * 3_600_000 + 60_000))]);
    const state = mergeSourceResults(createEmptyState(now), [first], now);
    expect(state.events).toHaveLength(1);
    const expiredId = state.events[0].id;
    const capped = await emsc(Array.from({ length: 200 }, (_, index) => feature(`fresh-${index}`)), later(1));
    expect(capped.status).toBe("partial");
    const merged = mergeSourceResults(state, [capped], later(1));
    expect(merged.events.some(({ id }) => id === expiredId)).toBe(false);
    expect(merged.events).toHaveLength(200);
  });
});

describe("EONET geographic request contract", () => {
  it("requests the documented west,north,east,south bounding box", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: "FeatureCollection", features: [] }));
    const result = await new EonetAdapter(true).fetch({ now, locations: [vienna], fetch: fetchMock });
    expect(result).toMatchObject({ status: "ok", events: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe("https://eonet.gsfc.nasa.gov");
    expect(url.pathname).toBe("/api/v3/events/geojson");
    expect(url.searchParams.get("bbox")).toBe("-36,72,45,27");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("category")).toBe("volcanoes,wildfires");
    expect(url.searchParams.get("limit")).toBe("200");
  });

  it("makes no requests while context feeds are disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await new EonetAdapter(false).fetch({ now, locations: [vienna], fetch: fetchMock });
    expect(result).toMatchObject({ status: "disabled", limitationCode: "context_feeds_disabled", events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
