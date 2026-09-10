import { describe, expect, it } from "vitest";
import { writeArrayBuffer } from "geotiff";
import { locations } from "@/lib/data";
import { EdoDroughtAdapter, edoEvents, edoProductDate } from "@/lib/ingestion/adapters/edo";
import { EonetAdapter, parseEonet } from "@/lib/ingestion/adapters/eonet";
import { FcdoTravelAdviceAdapter, fcdoEvent } from "@/lib/ingestion/adapters/fcdo";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";

const now = new Date("2026-08-29T12:00:00.000Z");
const vienna = locations.find(({ id }) => id === "at-vienna")!;
const context = { now, locations: [vienna], fetch: globalThis.fetch };

function eonetFeature(id: string, category: "wildfires" | "volcanoes", date: string, coordinates = vienna.centroid) {
  return {
    type: "Feature", id, geometry: { type: "Point", coordinates },
    properties: { id, title: `Example ${category}`, date, categories: [{ id: category, title: category }] },
  };
}

function edoTiff(value = 0, width = 1_824, height = 1_200) {
  const values = new Uint8Array(width * height);
  if (width === 1_824 && height === 1_200) {
    const x = Math.floor(((vienna.centroid[0] + 25) / 76) * width);
    const y = Math.floor(((72 - vienna.centroid[1]) / 50) * height);
    values[y * width + x] = value;
  }
  return new Uint8Array(writeArrayBuffer(values, {
    width, height, GeographicTypeGeoKey: 4326,
    ModelPixelScale: [76 / width, 50 / height, 0],
    ModelTiepoint: [0, 0, 0, -25, 72, 0],
  }));
}

const edoAlertTiff = edoTiff(3);
const edoWatchTiff = edoTiff(2);

describe("context-only feeds", () => {
  it("maps current EONET wildfire and volcano geometry but rejects stale regression records", () => {
    const parsed = parseEonet({ features: [
      eonetFeature("fire-current", "wildfires", "2026-08-29T10:00:00Z"),
      eonetFeature("volcano-current", "volcanoes", "2026-08-29T09:00:00Z"),
      eonetFeature("old-kansas-regression", "wildfires", "2020-08-29T10:00:00Z"),
      eonetFeature("far-away", "wildfires", "2026-08-29T10:00:00Z", [-100, 38]),
    ] }, context);

    expect(parsed.events.map(({ type }) => type)).toEqual(["wildfire", "volcano"]);
    expect(parsed.events.every((event) => event.level === "ELEVATED" && event.confidence === "MEDIUM")).toBe(true);
    expect(parsed.invalid).toBe(1);
  });

  it("retains unexpired EONET context when a refresh is only partially parseable", async () => {
    const prior = parseEonet({ features: [eonetFeature("fire-current", "wildfires", "2026-08-29T10:00:00Z")] }, context).events[0];
    const adapter = new EonetAdapter(true);
    const result = await adapter.fetch({ ...context, fetch: (async () => Response.json({ features: [
      eonetFeature("invalid", "wildfires", "2020-08-29T10:00:00Z"),
      eonetFeature("another-current-fire", "wildfires", "2026-08-29T10:00:00Z"),
    ] })) as typeof fetch });
    const state = createEmptyState(now);
    state.events = [prior];
    expect(result).toMatchObject({ status: "partial", removedEventPrefixes: [] });
    expect(mergeSourceResults(state, [result], now).events.map(({ id }) => id)).toContain(prior.id);
  });

  it("accepts only reviewed EDO CDI class 3 on the exact grid and rejects stale or changed rasters", async () => {
    expect(edoProductDate({ products: [{ code: "cdiad", latestDate: "2026-08-20" }] })).toBe("2026-08-20");
    await expect(edoEvents(edoAlertTiff, "2026-08-20", context)).resolves.toMatchObject([
      { type: "drought", level: "ELEVATED", geometry: { kind: "locations", ids: ["at-vienna"] } },
    ]);
    await expect(edoEvents(edoWatchTiff, "2026-08-20", context)).resolves.toEqual([]);
    await expect(edoEvents(edoAlertTiff, "2026-07-01", context)).rejects.toThrow(/stale/);
    await expect(edoEvents(edoTiff(3, 100, 100), "2026-08-20", context)).rejects.toThrow(/grid/);
  });
  it("uses one bounded EDO WCS attempt instead of retrying a slow multi-megabyte raster", async () => {
    let requests = 0;
    const result = await new EdoDroughtAdapter(true).fetch({ ...context, fetch: (async (input: RequestInfo | URL) => {
      requests += 1;
      if (String(input).includes("/services/config")) return Response.json({ products: [{ code: "cdiad", latestDate: "2026-08-20" }] });
      throw new Error("slow WCS");
    }) as typeof fetch });
    expect(result.status).toBe("failed");
    expect(requests).toBe(2);
  });

  it("uses only whole-country FCDO statuses and renews evidence for two hours", () => {
    const whole = fcdoEvent({ title: "Austria travel advice", updated_at: "2026-08-29T10:00:00Z", details: { alert_status: ["avoid_all_but_essential_travel_to_whole_country"] } }, "AT", context);
    const partial = fcdoEvent({ title: "Austria travel advice", updated_at: "2026-08-29T10:00:00Z", details: { alert_status: ["avoid_all_travel_to_parts"] } }, "AT", context);
    expect(whole).toMatchObject({ type: "security", level: "ELEVATED", expiresAt: "2026-08-29T14:00:00.000Z" });
    expect(partial).toBeNull();
  });

  it("replaces successful FCDO countries without clearing evidence for failed countries", () => {
    const berlin = locations.find(({ id }) => id === "de-berlin")!;
    const fullContext = { ...context, locations: [vienna, berlin] };
    const oldAt = fcdoEvent({ title: "Austria travel advice", updated_at: "2026-08-29T09:00:00Z", details: { alert_status: ["avoid_all_travel_to_whole_country"] } }, "AT", fullContext)!;
    const oldDe = fcdoEvent({ title: "Germany travel advice", updated_at: "2026-08-29T09:00:00Z", details: { alert_status: ["avoid_all_travel_to_whole_country"] } }, "DE", fullContext)!;
    const renewedAt = { ...oldAt, sourceUpdatedAt: "2026-08-29T11:00:00.000Z" };
    const state = createEmptyState(now);
    state.events = [oldAt, oldDe];
    const merged = mergeSourceResults(state, [{
      sourceId: "fcdo-travel-advice", checkedAt: now.toISOString(), sourceUpdatedAt: renewedAt.sourceUpdatedAt,
      events: [renewedAt], status: "partial", error: "1 FCDO country page failed",
      checkedLocationIds: [vienna.id], unavailableLocationIds: [berlin.id], removedEventPrefixes: ["fcdo:"],
    }], now);
    expect(merged.events.filter(({ sourceId }) => sourceId === "fcdo-travel-advice").map(({ id }) => id).sort()).toEqual(["fcdo:AT", "fcdo:DE"]);
  });

  it("makes no requests when the shared context-feed kill switch is disabled", async () => {
    let requests = 0;
    const disabledContext = { ...context, fetch: (async () => { requests += 1; throw new Error("must not fetch"); }) as typeof fetch };
    const results = await Promise.all([
      new EonetAdapter(false).fetch(disabledContext),
      new EdoDroughtAdapter(false).fetch(disabledContext),
      new FcdoTravelAdviceAdapter(false).fetch(disabledContext),
    ]);
    expect(results.every((result) => result.status === "disabled" && result.events.length === 0)).toBe(true);
    expect(requests).toBe(0);
  });

  it("does not let a fresh context-only source mask a stale global snapshot", () => {
    const state = createEmptyState(new Date("2026-08-29T08:00:00.000Z"));
    state.sources.eonet.lastSuccess = now.toISOString();
    expect(buildSnapshot(state, now).dataHealth).toBe("stale");
  });
});
