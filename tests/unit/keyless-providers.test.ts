import { describe, expect, it, vi } from "vitest";
import { avalancheLevel, euregioEvents } from "@/lib/ingestion/adapters/avalanche";
import { EmscAdapter } from "@/lib/ingestion/adapters/emsc";
import { GdacsAdapter, parseGdacsCandidates } from "@/lib/ingestion/adapters/gdacs";
import { GfmAdapter, qualifiesGfmFlood, supportedActiveFire } from "@/lib/ingestion/adapters/satellite";
import { readJsonWithLimit } from "@/lib/ingestion/fetch";
import { createEmptyState, mergeSourceResults, buildSnapshot } from "@/lib/risk";
import { locations } from "@/lib/data";
import { NationalCivilAlertsAdapter } from "@/lib/ingestion/adapters/national-civil-alerts";
import { nationalWarningSources } from "@/lib/national-warning-sources";

const now = new Date("2026-01-15T12:00:00Z");
describe("keyless provider safety rules", () => {
  it("keeps GDACS discovery metadata bounded and non-scoring", () => {
    const candidates = parseGdacsCandidates({ features: [{ properties: { eventtype: "FL", eventid: 1, episodeid: 2, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z", url: "https://www.gdacs.org/" }, geometry: { type: "Point", coordinates: [10, 45] } }] }, now);
    expect(candidates).toHaveLength(1);
    const state = mergeSourceResults(createEmptyState(now), [{ sourceId: "gdacs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null }], now);
    expect(Object.values(buildSnapshot(state, now).locations).some((location) => location.level !== "NORMAL" && location.level !== "UNKNOWN")).toBe(false);
  });

  it("runs GDACS on the slow cadence with one bounded transport attempt", async () => {
    const adapter = new GdacsAdapter(); const fetchMock = vi.fn(async () => { throw new Error("unavailable"); });
    const result = await adapter.fetch({ now, locations, fetch: fetchMock as typeof fetch });
    expect(adapter.cadence).toBe("slow");
    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains discovery candidates independently per provider", () => {
    const gdacs = parseGdacsCandidates({ features: [{ properties: { eventtype: "FL", eventid: 1, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z", url: "https://www.gdacs.org/" }, geometry: { type: "Point", coordinates: [10, 45] } }] }, now)[0];
    const gdelt = { ...gdacs, providerId: "gdelt" as const, externalId: "news-1", hazardType: "security" as const, officialUrl: "https://www.reuters.com/example", canonicalUrl: "https://www.reuters.com/example" };
    const first = mergeSourceResults(createEmptyState(now), [{ sourceId: "gdelt", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], candidates: [gdelt], status: "ok", error: null }], now);
    const second = mergeSourceResults(first, [{ sourceId: "gdacs", checkedAt: new Date(now.getTime() + 1_000).toISOString(), sourceUpdatedAt: now.toISOString(), events: [], candidates: [gdacs], status: "ok", error: null }], new Date(now.getTime() + 1_000));
    expect(second.candidates.map(({ providerId }) => providerId).sort()).toEqual(["gdacs", "gdelt"]);
    const newerGdelt = { ...gdelt, externalId: "news-2", officialUrl: "https://www.bbc.com/example", canonicalUrl: "https://www.bbc.com/example" };
    const third = mergeSourceResults(second, [{ sourceId: "gdelt", checkedAt: new Date(now.getTime() + 2_000).toISOString(), sourceUpdatedAt: now.toISOString(), events: [], candidates: [newerGdelt], status: "ok", error: null }], new Date(now.getTime() + 2_000));
    expect(third.candidates.filter(({ providerId }) => providerId === "gdelt").map(({ externalId }) => externalId).sort()).toEqual(["news-1", "news-2"]);
  });

  it("treats timezone-less GDACS timestamps as UTC and ranks current alerts first", () => {
    const candidates = parseGdacsCandidates({ features: [
      { properties: { eventtype: "FL", eventid: 1, fromdate: "2026-01-15T00:00:00", todate: "2026-01-16T00:00:00", datemodified: "2026-01-15T11:30:00", iscurrent: "false", alertscore: 3 }, geometry: { type: "Point", coordinates: [10, 45] } },
      { properties: { eventtype: "WF", eventid: 2, fromdate: "2026-01-15T01:00:00", todate: "2026-01-16T00:00:00", datemodified: "2026-01-15T11:00:00", iscurrent: "true", alertscore: 1 }, geometry: { type: "Point", coordinates: [11, 46] } },
    ] }, now);
    expect(candidates.map((candidate) => candidate.externalId)).toEqual(["WF:2:0", "FL:1:0"]);
    expect(candidates[0].sourceUpdatedAt).toBe("2026-01-15T11:00:00.000Z");
  });

  it("rejects GDACS polygons that cannot affect the destination catalog", () => {
    const properties = { eventtype: "FL", eventid: 1, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z" };
    const australia = [[150, -34], [152, -34], [152, -32], [150, -32], [150, -34]];
    const europe = [[15.9, 47.9], [16.9, 47.9], [16.9, 48.6], [15.9, 48.6], [15.9, 47.9]];
    const candidates = parseGdacsCandidates({ features: [
      { properties, geometry: { type: "Polygon", coordinates: [australia] } },
      { properties: { ...properties, eventid: 2 }, geometry: { type: "MultiPolygon", coordinates: [[europe]] } },
    ] }, now, locations);
    expect(candidates.map((candidate) => candidate.externalId)).toEqual(["FL:2:0"]);
  });

  it("reports GDACS candidate overflow as partial and keeps a bounded set", async () => {
    const features = Array.from({ length: 201 }, (_, index) => ({
      properties: { eventtype: "FL", eventid: index + 1, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z", iscurrent: true },
      geometry: { type: "Point", coordinates: [10, 45] },
    }));
    const fetchMock = (async () => new Response(JSON.stringify({ features }), { status: 200 })) as typeof fetch;
    const result = await new GdacsAdapter().fetch({ now, locations: [], fetch: fetchMock });
    expect(result.status).toBe("partial");
    expect("candidates" in result ? result.candidates : []).toHaveLength(200);
  });

  it("fails a non-empty GDACS response with no parseable records", async () => {
    const fetchMock = (async () => Response.json({ features: [{ properties: {}, geometry: null }] })) as typeof fetch;
    const result = await new GdacsAdapter().fetch({ now, locations, fetch: fetchMock });
    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it("marks mixed-validity GDACS responses partial", async () => {
    const valid = { properties: { eventtype: "FL", eventid: 1, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z" }, geometry: { type: "Point", coordinates: [10, 45] } };
    const result = await new GdacsAdapter().fetch({
      now, locations: [], fetch: (async () => Response.json({ features: [valid, { properties: {}, geometry: null }] })) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "partial", error: "1 GDACS records were invalid" });
    expect("candidates" in result ? result.candidates : []).toHaveLength(1);
  });

  it("accepts instantaneous GDACS events and ignores unsupported event types", async () => {
    const earthquake = { properties: { eventtype: "EQ", eventid: 1, fromdate: "2026-01-15T11:00:00Z", todate: "2026-01-15T11:00:00Z", datemodified: "2026-01-15T11:30:00Z" }, geometry: { type: "Point", coordinates: [10, 45] } };
    const drought = { properties: { eventtype: "DR", eventid: 2, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z" }, geometry: { type: "Point", coordinates: [10, 45] } };
    const result = await new GdacsAdapter().fetch({
      now, locations: [], fetch: (async () => Response.json({ features: [earthquake, drought] })) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "ok", error: null });
    expect("candidates" in result ? result.candidates : []).toMatchObject([{ externalId: "EQ:1:0" }]);
  });

  it("rejects unknown GDACS event types instead of masking a feed change", async () => {
    const result = await new GdacsAdapter().fetch({
      now, locations: [], fetch: (async () => Response.json({ features: [{
        properties: { eventtype: "NEW", eventid: 1, fromdate: "2026-01-15T00:00:00Z", todate: "2026-01-16T00:00:00Z", datemodified: "2026-01-15T11:00:00Z" },
        geometry: { type: "Point", coordinates: [10, 45] },
      }] })) as typeof fetch,
    });

    expect(result.status).toBe("failed");
  });

  it("persists bounded discovery candidates but never serializes them publicly", () => {
    const candidate = { providerId: "gdacs" as const, externalId: "FL:1:2", hazardType: "flood" as const, geometry: { type: "Point" as const, coordinates: [10, 45] as [number, number] }, startsAt: "2026-01-15T00:00:00Z", endsAt: "2026-01-16T00:00:00Z", sourceUpdatedAt: "2026-01-15T11:00:00Z", officialUrl: "https://www.gdacs.org/", expiresAt: "2026-01-16T00:00:00Z" };
    const state = mergeSourceResults(createEmptyState(now), [{ sourceId: "gdacs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], candidates: [candidate], status: "ok", error: null }], now);
    expect(state.candidates).toEqual([candidate]);
    expect(JSON.stringify(buildSnapshot(state, now))).not.toContain("FL:1:2");
  });

  it("keeps valid EMSC evidence when another record is malformed", async () => {
    const vienna = locations.find((location) => location.id === "at-vienna")!;
    const response = { features: [
      { id: "event-1", geometry: { coordinates: vienna.centroid }, properties: { mag: 5, time: "2026-01-15T11:00:00Z", lastupdate: "2026-01-15T11:05:00Z", unid: "canonical-1" } },
      { id: "broken", geometry: {}, properties: { mag: 5, time: "2026-01-15T11:00:00Z" } },
    ] };
    const fetchMock = (async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const result = await new EmscAdapter().fetch({ now, locations: [vienna], fetch: fetchMock });
    expect(result.status).toBe("partial");
    expect("events" in result ? result.events : []).toHaveLength(1);
    expect("events" in result ? result.events[0].id : "").toBe("emsc:canonical-1:at-vienna");
  });

  it("fails a non-empty EMSC response with no parseable records", async () => {
    const fetchMock = (async () => Response.json({ features: [{ id: "broken", geometry: {}, properties: {} }] })) as typeof fetch;
    const result = await new EmscAdapter().fetch({ now, locations, fetch: fetchMock });
    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it("stops reading JSON responses at the configured byte limit", async () => {
    await expect(readJsonWithLimit(new Response('{"ok":true}'), 20)).resolves.toEqual({ ok: true });
    await expect(readJsonWithLimit(new Response('{"payload":"too large"}'), 10)).rejects.toThrow(/exceeds 10 bytes/);
    await expect(readJsonWithLimit(new Response("{}", { headers: { "content-length": "100" } }), 10)).rejects.toThrow(/exceeds 10 bytes/);
  });

  it("uses exact satellite thresholds", () => {
    expect(qualifiesGfmFlood([1, 1, 1, 1], [70, 70, 70, 70], [0, 0, 0, 0], 2)).toBe(true);
    expect(qualifiesGfmFlood([1, 1, 1, 1], [69, 70, 70, 70], [0, 0, 0, 0], 2)).toBe(false);
    expect(qualifiesGfmFlood([1, 1, 1, 1], [70, 70, 70, 70], [0, 0, 1, 0], 2)).toBe(false);
    expect(supportedActiveFire({ id: "v-low", sensor: "VIIRS", longitude: 1, latitude: 1, acquiredAt: now.toISOString(), confidence: "nominal" }, now)).toBe(false);
    expect(supportedActiveFire({ id: "v-high", sensor: "VIIRS", longitude: 1, latitude: 1, acquiredAt: now.toISOString(), confidence: "high" }, now)).toBe(true);
    expect(supportedActiveFire({ id: "m", sensor: "MODIS", longitude: 1, latitude: 1, acquiredAt: now.toISOString(), confidence: 79 }, now)).toBe(false);
  });

  it("maps EAWS levels without publishing levels one and two", () => {
    expect([1, 2, 3, 4, 5].map(avalancheLevel)).toEqual([null, null, "ELEVATED", "HIGH", "SEVERE"]);
    const events = euregioEvents({ bulletins: [{ bulletinID: "b", publicationTime: now.toISOString(), validTime: { startTime: "2026-01-15T00:00:00Z", endTime: "2026-01-16T00:00:00Z" }, dangerRatings: [{ mainValue: "considerable" }], regions: [{ regionID: "IT-32-TN-13" }] }] }, { now, locations, fetch });
    expect(events).toHaveLength(1);
    expect(events.every((event) => event.level === "ELEVATED" && event.providerId === "euregio-avalanche")).toBe(true);
  });

  it("runs approved national-warning partitions independently", async () => {
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.status = "ok";
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = now.toISOString();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("data.public.lu")) return Response.json({ last_update: now.toISOString(), resources: [] });
      if (value.includes("api.krisinformation.se")) return Response.json([]);
      if (value.includes("warnung.at-alert.at")) return Response.json({ json: { totalCount: 0, alerts: [] } });
      if (value.includes("api.hochwasserzentralen.de")) return Response.json({ updated: now.toISOString(), features: [] });
      if (value.includes("analisi.transparenciacatalunya.cat")) return Response.json([]);
      if (init?.method === "HEAD") return new Response(null, { headers: { "Last-Modified": now.toUTCString() } });
      return new Response("<html></html>");
    });
    const result = await new NationalCivilAlertsAdapter().fetch({
      now, locations, state, fetch: fetchMock as typeof fetch,
    });
    expect(Object.keys(nationalWarningSources)).toHaveLength(28);
    expect(Object.entries(result.partitions).filter(([country]) => !["AT", "CZ", "DE", "ES", "FR", "IT", "LU", "LV", "PL", "SE"].includes(country)).every(([, partition]) => partition.status === "disabled" && partition.events.length === 0)).toBe(true);
    expect(result.partitions.FR.status).toBe("failed");
    expect(result.partitions.IT.status).toBe("failed");
    expect(result.partitions.AT).toMatchObject({ status: "ok", events: [] });
    expect(result.partitions.LU.status).toBe("ok");
    expect(result.partitions.SE).toMatchObject({ status: "ok", events: [], checkedLocationIds: expect.any(Array) });
    expect(result.partitions.DE).toMatchObject({ status: "ok", events: [] });
    expect(result.partitions.ES).toMatchObject({ status: "ok", events: [] });
    expect(Object.fromEntries(["AT", "CZ", "DE", "ES", "FR", "IT", "LU", "LV", "PL", "SE"].map((country) => [country, nationalWarningSources[country as "AT" | "CZ" | "DE" | "ES" | "FR" | "IT" | "LU" | "LV" | "PL" | "SE"].enabled]))).toEqual({ AT: true, CZ: true, DE: true, ES: true, FR: true, IT: true, LU: true, LV: true, PL: true, SE: true });
    expect(nationalWarningSources.FR).toMatchObject({
      enabled: true,
      format: "json",
      reuseStatus: "approved",
      severityStatus: "approved",
      lifecycleStatus: "approved",
      limitationCode: null,
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.krisinformation.se"))).toBe(true);
  });

  it("makes no GFM request while the environment gate is disabled", async () => {
    const previous = process.env.GFM_ENABLED;
    delete process.env.GFM_ENABLED;
    let requests = 0;
    const result = await new GfmAdapter().fetch({ now, locations, state: createEmptyState(now), fetch: (async () => { requests += 1; throw new Error("must not fetch"); }) as typeof fetch });
    if (previous === undefined) delete process.env.GFM_ENABLED; else process.env.GFM_ENABLED = previous;
    expect(result).toMatchObject({ status: "disabled", limitationCode: "environment_disabled", events: [] });
    expect(requests).toBe(0);
  });

  it("requires exact true before GloFAS adds a targeting request", async () => {
    vi.stubEnv("GFM_ENABLED", "true");
    vi.stubEnv("GLOFAS_TARGETING_ENABLED", "TRUE");
    try {
      const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
      const result = await new GfmAdapter().fetch({ now, locations, state: createEmptyState(now), fetch: fetchMock as typeof fetch });
      expect(result).toMatchObject({ status: "ok", events: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not start a GFM raster after the shared source deadline", async () => {
    const previous = process.env.GFM_ENABLED;
    process.env.GFM_ENABLED = "true";
    const location = locations[0];
    const state = createEmptyState(now);
    state.candidates = [{
      providerId: "gdacs", externalId: "FL:deadline", hazardType: "flood",
      geometry: { type: "Point", coordinates: location.centroid },
      startsAt: "2026-01-15T00:00:00Z", endsAt: "2026-01-16T00:00:00Z",
      sourceUpdatedAt: "2026-01-15T11:00:00Z", officialUrl: "https://www.gdacs.org/",
      expiresAt: "2026-01-16T00:00:00Z",
    }];
    let requests = 0;
    const result = await new GfmAdapter().fetch({
      now, locations: [location], state, deadlineAt: Date.now() - 1,
      fetch: (async () => { requests += 1; throw new Error("must not fetch"); }) as typeof fetch,
    });
    if (previous === undefined) delete process.env.GFM_ENABLED; else process.env.GFM_ENABLED = previous;

    expect(result).toMatchObject({ status: "failed", checkedLocationIds: [], unavailableLocationIds: [location.id] });
    expect(requests).toBe(0);
  });
});
