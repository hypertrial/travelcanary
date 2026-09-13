import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { readCapZipArchive } from "@/lib/ingestion/cap-archive";
import { parseDwdCap } from "@/lib/ingestion/adapters/dwd-cap";
import { fetchNationalWeatherFallback, parseMeteoalarmEdrCaps } from "@/lib/ingestion/adapters/national-weather-fallback";
import {
  fetchEaFloodWarnings,
  fetchMetOffice,
  fetchNrw,
  parseEaFloodWarnings,
  parseMetNorway,
  parseNveWarnings,
} from "@/lib/ingestion/adapters/national-civil-alerts-expanded";
import { createEmptyState } from "@/lib/risk-state";
import { NationalCivilAlertsAdapter } from "@/lib/ingestion/adapters/national-civil-alerts";
import { nationalWarningManifest } from "@/lib/national-warning-sources";
import { CatalogPartitionedSourceResultSchema } from "@/lib/domain/catalog-state";

const now = new Date("2026-09-09T10:00:00Z");
const context = { now, locations: catalogLocationsV3, fetch };
const square = (longitude: number, latitude: number) => ({ type: "Polygon", coordinates: [[
  [longitude - 0.2, latitude - 0.2], [longitude + 0.2, latitude - 0.2],
  [longitude + 0.2, latitude + 0.2], [longitude - 0.2, latitude + 0.2],
  [longitude - 0.2, latitude - 0.2],
]] });

afterEach(() => vi.unstubAllEnvs());

describe("expanded direct warning transports", () => {
  it("normalizes MET Norway land warnings, excludes marine-only geometry, and retains explicit CAP supersession", () => {
    const result = parseMetNorway({ type: "FeatureCollection", features: [
      { id: "new", geometry: square(10.75, 59.91), properties: { status: "Actual", geographicDomain: "land",
        msgType: "Update", references: "met@met.no,old,2026-09-09T08:00:00Z", event: "wind", severity: "Severe",
        onset: "2026-09-09T09:00:00Z", expires: "2026-09-09T13:00:00Z", sent: "2026-09-09T09:30:00Z", area: "Oslo" } },
      { id: "sea", geometry: square(5, 65), properties: { status: "Actual", geographicDomain: "marine",
        event: "wind", severity: "Extreme", onset: "2026-09-09T09:00:00Z", expires: "2026-09-09T13:00:00Z", sent: "2026-09-09T09:30:00Z" } },
    ] }, context);
    expect(result).toMatchObject({ status: "ok", events: [{ id: "national:met-no:new:0", type: "severe-weather", level: "HIGH" }],
      removedEventPrefixes: ["national:met-no:"] });
    expect(result.events.some(({ id }) => id.includes("sea"))).toBe(false);

    const currentGeoJson = parseMetNorway({ type: "FeatureCollection", features: [
      { id: "current", geometry: square(10.75, 59.91), when: { interval: ["2026-09-09T09:00:00Z", "2026-09-09T13:00:00Z"] },
        properties: { status: "Actual", type: "Alert", geographicDomain: "land", event: "wind",
          severity: "Moderate", eventEndingTime: "2026-09-09T13:00:00Z", area: "Oslo" } },
    ] }, context);
    expect(currentGeoJson).toMatchObject({ status: "ok", events: [{ id: "national:met-no:current:0",
      startsAt: "2026-09-09T09:00:00.000Z", endsAt: "2026-09-09T13:00:00.000Z" }] });

    const partial = parseMetNorway({ type: "FeatureCollection", features: [
      { id: "cancel", geometry: square(10.75, 59.91), properties: { status: "Actual", msgType: "Cancel",
        references: "met@met.no,old,2026-09-09T08:00:00Z" } },
      { id: "broken", geometry: square(10.75, 59.91), properties: { status: "Actual", geographicDomain: "land", event: "wind" } },
    ] }, context);
    expect(partial).toMatchObject({ status: "partial", events: [], checkedLocationIds: [],
      removedEventPrefixes: expect.arrayContaining(["national:met-no:old:", "national:met-no:cancel:"]) });
    expect(partial.removedEventPrefixes).not.toContain("national:met-no:");
  });

  it("selects the newest NVE version, normalizes Norway civil time, and never treats activity zero or unmapped municipalities as all-clear", () => {
    const warning = (activityLevel: number, version: number, lastUpdated: string, municipality = "Oslo") => ({
      Id: `NVE-${version}`, MasterId: "NVE-1", Version: version, CapStatus: "actual", ActivityLevel: activityLevel,
      MunicipalityList: [{ Name: municipality }], PublishTime: "09/09/2026 09:00:00", LastUpdated: lastUpdated,
      ValidFrom: "09/09/2026 09:00:00", ValidTo: "09/09/2026 18:00:00", MainText: "Flood warning",
    });
    const active = parseNveWarnings([warning(3, 2, "09/09/2026 09:20:00"), warning(2, 1, "09/09/2026 09:30:00")], context);
    expect(active).toMatchObject({ status: "ok", events: [{ id: "national:nve:NVE-1", level: "HIGH",
      startsAt: "2026-09-09T07:00:00.000Z", geometry: { kind: "locations", ids: ["no-oslo"] } }] });

    const zero = parseNveWarnings([warning(0, 1, "09/09/2026 09:20:00")], context);
    expect(zero).toMatchObject({ status: "partial", events: [], unavailableLocationIds: ["no-oslo"], limitationCode: "unassessed_activity_level" });
    expect(zero.removedEventPrefixes).toEqual([]);
    const unmapped = parseNveWarnings([warning(3, 1, "09/09/2026 09:20:00", "Unknown municipality")], context);
    expect(unmapped).toMatchObject({ status: "ok", events: [], limitationCode: undefined });
    expect(unmapped.checkedLocationIds).toHaveLength(20);
    const missing = warning(3, 1, "09/09/2026 09:20:00");
    missing.MunicipalityList = [];
    expect(parseNveWarnings([missing], context)).toMatchObject({ status: "partial", events: [], limitationCode: "municipality_mapping_unavailable",
      unavailableLocationIds: expect.arrayContaining(["no-oslo", "no-bergen"]) });

    expect(parseNveWarnings([{ ...warning(4, 3, "09/09/2026 09:40:00"), CapStatus: "test" }], context).events).toEqual([]);
  });

  it("requests the current keyless NVE English warning route", async () => {
    const { fetchNve } = await import("@/lib/ingestion/adapters/national-civil-alerts-expanded");
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json([]));
    await expect(fetchNve({ ...context, fetch: fetchMock })).resolves.toMatchObject({ status: "ok", events: [] });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api01.nve.no/hydrology/forecast/flood/v1.0.10/api/Warning/2/2026-09-09/2026-09-10");
  });

  it("rejects impossible NVE civil timestamps instead of normalizing them into another date", () => {
    expect(() => parseNveWarnings([{
      Id: "NVE-invalid-date", MasterId: "NVE-invalid-date", Version: 1, CapStatus: "actual", ActivityLevel: 3,
      MunicipalityList: [{ Name: "Oslo" }], PublishTime: "31/02/2026 09:00:00", LastUpdated: "31/02/2026 09:20:00",
      ValidFrom: "31/02/2026 09:00:00", ValidTo: "31/02/2026 18:00:00", MainText: "Flood warning",
    }], context)).toThrow(/timestamp is invalid/);
  });

  it("applies Environment Agency withdrawal and reused-ID semantics without broad-clearing retained evidence on a partial geometry refresh", () => {
    const london = catalogLocationsV3.find(({ id }) => id === "gb-london")!;
    const active = { floodAreaID: "area-1", severityLevel: 2, description: "River near London",
      timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" };
    const current = parseEaFloodWarnings({ items: [{ ...active, severityLevel: 4 }, active] }, new Map([["area-1", square(...london.centroid)]]), context);
    expect(current).toMatchObject({ status: "ok", events: [{ id: "national:ea-flood:area-1:0", level: "HIGH" }],
      removedEventPrefixes: ["national:ea-flood:"] });

    const partial = parseEaFloodWarnings({ items: [{ ...active, floodAreaID: "withdrawn", severityLevel: 4 },
      { ...active, floodAreaID: "missing" }] }, new Map(), context);
    expect(partial).toMatchObject({ status: "partial", events: [], limitationCode: "flood_area_geometry_unavailable",
      removedEventPrefixes: ["national:ea-flood:withdrawn:"] });
    expect(partial.removedEventPrefixes).not.toContain("national:ea-flood:");
    expect(partial.unavailableLocationIds).toHaveLength(15);
  });

  it("caches validated stable Environment Agency flood-area geometry across collections", async () => {
    const warning = { floodAreaID: "cache-area-unique", severityLevel: 2, description: "River near London",
      timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" };
    const calls: string[] = [];
    const fetchMock: typeof globalThis.fetch = async (input) => {
      const url = String(input); calls.push(url);
      return url.includes("/polygon") ? Response.json(square(-0.12, 51.5)) : Response.json({ items: [warning] });
    };
    await expect(fetchEaFloodWarnings({ ...context, fetch: fetchMock })).resolves.toMatchObject({ status: "ok", events: [{ type: "flood" }] });
    await expect(fetchEaFloodWarnings({ ...context, fetch: fetchMock })).resolves.toMatchObject({ status: "ok", events: [{ type: "flood" }] });
    expect(calls.filter((url) => url.includes("/polygon"))).toHaveLength(1);
  });

  it("processes more than 100 active Environment Agency flood areas in bounded geometry batches", async () => {
    const warnings = Array.from({ length: 101 }, (_, index) => ({ floodAreaID: `area-${index}`, severityLevel: 2,
      description: "River flooding", timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" }));
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => String(input).includes("/polygon")
      ? Response.json(square(-0.12, 51.5)) : Response.json({ items: warnings }));
    const result = await fetchEaFloodWarnings({ ...context, fetch: fetchMock });
    expect(result).toMatchObject({ status: "ok", events: expect.any(Array) });
    expect(result.events).toHaveLength(101);
    expect(Object.keys(result.frozenEaFloodAreaGeometries || {})).toHaveLength(100);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/polygon"))).toHaveLength(101);
  });

  it("stops scheduling Environment Agency geometry requests after the transport budget aborts", async () => {
    const warnings = Array.from({ length: 101 }, (_, index) => ({ floodAreaID: `slow-${index}`, severityLevel: 2,
      description: "River flooding", timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" }));
    const controller = new AbortController(); let started!: () => void;
    const firstBatch = new Promise<void>((resolve) => { started = resolve; });
    let polygonRequests = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (!String(input).includes("/polygon")) return Response.json({ items: warnings });
      polygonRequests += 1; if (polygonRequests === 8) started();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const request = fetchEaFloodWarnings({ ...context, fetch: fetchMock, signal: controller.signal });
    await firstBatch; controller.abort(new Error("transport budget exceeded"));
    await expect(request).resolves.toMatchObject({ status: "partial", events: [] });
    expect(polygonRequests).toBe(8);
  });

  it("does not retry Environment Agency pagination after the transport budget aborts", async () => {
    const controller = new AbortController(); let started!: () => void;
    const firstRequest = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const request = fetchEaFloodWarnings({ ...context, fetch: fetchMock, signal: controller.signal });
    await firstRequest; controller.abort(new Error("transport budget exceeded"));
    await expect(request).rejects.toThrow("transport budget exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded partial partition instead of failing the national source above the event schema limit", () => {
    const warnings = Array.from({ length: 501 }, (_, index) => ({ floodAreaID: `area-${index}`, severityLevel: 2,
      description: "River flooding", timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" }));
    const geometries = new Map(warnings.map(({ floodAreaID }) => [floodAreaID, square(-0.12, 51.5)]));
    const result = parseEaFloodWarnings({ items: warnings }, geometries, context);
    expect(result).toMatchObject({ status: "partial", limitationCode: "warning_event_limit_reached", events: expect.any(Array),
      checkedLocationIds: [], unavailableLocationIds: expect.arrayContaining(["gb-london"]) });
    expect(result.events).toHaveLength(500);
  });

  it("reuses retained validated flood-area geometry after a process cold start", async () => {
    const warning = { floodAreaID: "durable-area-unique", severityLevel: 2, description: "River near London",
      timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" };
    const retained = parseEaFloodWarnings({ items: [warning] }, new Map([[warning.floodAreaID, square(-0.12, 51.5)]]), context).events[0];
    const state = createEmptyState(now); state.events = [{ ...retained, transportId: "ea-flood", partitionCountryCode: "GB" }];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => String(input).includes("/polygon")
      ? Promise.reject(new Error("polygon endpoint offline")) : Response.json({ items: [warning] }));

    await expect(fetchEaFloodWarnings({ ...context, state, fetch: fetchMock })).resolves.toMatchObject({ status: "ok", events: [{ type: "flood" }] });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/polygon"))).toBe(false);
  });

  it("keeps frozen flood-area geometry after withdrawal for reused-ID reactivation", async () => {
    const warning = { floodAreaID: "reactivated-area-unique", severityLevel: 2, description: "River near London",
      timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" };
    const state = createEmptyState(now);
    state.frozenEaFloodAreaGeometries[warning.floodAreaID] = [{ kind: "polygon", coordinates: square(-0.12, 51.5).coordinates as [number, number][][] }];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => String(input).includes("/polygon")
      ? Promise.reject(new Error("polygon endpoint offline")) : Response.json({ items: [warning] }));

    await expect(fetchEaFloodWarnings({ ...context, state, fetch: fetchMock })).resolves.toMatchObject({ status: "ok", events: [{ type: "flood" }] });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/polygon"))).toBe(false);
  });

  it("rejects aggregate Environment Agency geometry above the ring bound", () => {
    const warning = { floodAreaID: "large", severityLevel: 2, description: "Large area", timeRaised: now.toISOString() };
    const geometry = { type: "MultiPolygon", coordinates: Array.from({ length: 65 }, (_, index) => square(-1 + index / 100, 52).coordinates) };
    expect(() => parseEaFloodWarnings({ items: [warning] }, new Map([["large", geometry]]), context)).toThrow(/aggregate limits/);
  });

  it("makes no authenticated request without optional credentials and sends configured keys only in headers", async () => {
    const none = vi.fn<typeof globalThis.fetch>();
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", ""); vi.stubEnv("MET_OFFICE_API_KEY", "");
    vi.stubEnv("NRW_FLOOD_API_BASE_URL", ""); vi.stubEnv("NRW_FLOOD_API_KEY", "");
    await expect(fetchMetOffice({ ...context, fetch: none })).rejects.toThrow("credential_not_configured");
    await expect(fetchNrw({ ...context, fetch: none })).rejects.toThrow("credential_not_configured");
    expect(none).not.toHaveBeenCalled();

    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    vi.stubEnv("MET_OFFICE_API_KEY", "super-secret-key");
    const related = "https://warnings.api.metoffice.gov.uk/v1.0/objects/issued/current";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? new Response(`<feed><link rel="related" href="${related}"/></feed>`)
        : Response.json({ features: [] });
    };
    await expect(fetchMetOffice({ ...context, fetch: fetchMock })).resolves.toMatchObject({ status: "ok", events: [] });
    expect(calls).toHaveLength(2);
    expect(calls.every(({ url }) => !url.includes("super-secret-key"))).toBe(true);
    expect(calls.every(({ init }) => new Headers(init?.headers).get("x-api-key") === "super-secret-key")).toBe(true);
  });

  it("rejects Met Office linked-document redirects outside the configured origin", async () => {
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    vi.stubEnv("MET_OFFICE_API_KEY", "secret");
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      '<feed><link rel="related" href="https://attacker.example/v1.0/objects/issued/current"/></feed>',
    ));
    await expect(fetchMetOffice({ ...context, fetch: fetchMock })).rejects.toThrow("not allowlisted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses the documented Met Office issued-warning property names", async () => {
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    vi.stubEnv("MET_OFFICE_API_KEY", "secret");
    const related = "https://warnings.api.metoffice.gov.uk/v1.0/objects/issued/current";
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(
      `<feed><link rel="related" href="${related}"/></feed>`,
    )).mockResolvedValueOnce(Response.json({ features: [{ type: "Feature", geometry: square(-0.12, 51.5), properties: {
      warningId: "warning-1", warningStatus: "ISSUED", warningLevel: "AMBER", weatherType: ["RAIN", "SNOW"],
      validFromDate: "2026-09-09T09:00:00Z", validToDate: "2026-09-09T13:00:00Z",
      modifiedDate: "2026-09-09T09:30:00Z", headline: "Rain and snow warning",
    } }] }));
    const result = await fetchMetOffice({ ...context, fetch: fetchMock });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "national:met-office:warning-1:severe-weather:0", level: "HIGH", type: "severe-weather" }),
      expect.objectContaining({ id: "national:met-office:warning-1:snow-ice:0", level: "HIGH", type: "snow-ice" }),
    ]));
  });

  it("bounds Met Office multi-hazard fanout without failing the national transport schema", async () => {
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    vi.stubEnv("MET_OFFICE_API_KEY", "secret");
    const related = "https://warnings.api.metoffice.gov.uk/v1.0/objects/issued/current";
    const features = Array.from({ length: 251 }, (_, index) => ({ type: "Feature", geometry: square(-0.12, 51.5), properties: {
      warningId: `warning-${String(index).padStart(3, "0")}`, warningStatus: "ISSUED", warningLevel: "AMBER", weatherType: ["RAIN", "SNOW"],
      validFromDate: "2026-09-09T09:00:00Z", validToDate: "2026-09-09T13:00:00Z", modifiedDate: "2026-09-09T09:30:00Z",
    } }));
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(
      `<feed><link rel="related" href="${related}"/></feed>`,
    )).mockResolvedValueOnce(Response.json({ features }));
    const result = await fetchMetOffice({ ...context, fetch: fetchMock });
    expect(result).toMatchObject({ status: "partial", limitationCode: "warning_event_limit_reached", checkedLocationIds: [],
      unavailableLocationIds: expect.arrayContaining(["gb-london"]), removedEventPrefixes: [] });
    expect(result.events).toHaveLength(500);
  });

  it("bounds combined national partition events with coverage transports first", async () => {
    vi.stubEnv("NATIONAL_ALERTS_DISABLED_COUNTRIES", Object.keys(nationalWarningManifest.countries).filter((code) => code !== "GB").join(","));
    vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", "nrw-flood");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    vi.stubEnv("MET_OFFICE_API_KEY", "secret");
    const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
    const features = Array.from({ length: 250 }, (_, index) => ({ type: "Feature", geometry: square(-0.12, 51.5), properties: {
      warningId: `warning-${String(index).padStart(3, "0")}`, warningStatus: "ISSUED", warningLevel: "AMBER", weatherType: ["RAIN", "SNOW"],
      validFromDate: "2026-09-09T09:00:00Z", validToDate: "2026-09-09T13:00:00Z", modifiedDate: "2026-09-09T09:30:00Z",
    } }));
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/id/floods?")) return Response.json({ items: [{ floodAreaID: "ea-area", severityLevel: 2,
        description: "River flooding", timeRaised: "2026-09-09T09:00:00Z", timeMessageChanged: "2026-09-09T09:30:00Z" }] });
      if (url.includes("/polygon")) return Response.json(square(-0.12, 51.5));
      if (url.endsWith("/feed")) return new Response("<feed><link rel=\"related\" href=\"https://warnings.api.metoffice.gov.uk/v1.0/objects/issued/current\"/></feed>");
      if (url.includes("/v1.0/objects/issued/")) return Response.json({ features });
      throw new Error(`Unexpected URL ${url}`);
    });
    const result = CatalogPartitionedSourceResultSchema.parse(await new NationalCivilAlertsAdapter()
      .fetch({ now, locations: catalogLocationsV3, state, fetch: fetchMock }));
    expect(result.partitions.GB.events).toHaveLength(500);
    expect(result.partitions.GB.events[0]).toMatchObject({ transportId: "ea-flood", id: "national:ea-flood:ea-area:0" });
    expect(result.partitions.GB.transports?.["ea-flood"].events).toHaveLength(1);
    expect(result.partitions.GB.transports?.["met-office-nswws"].events).toHaveLength(500);
  });
});

describe("bounded DWD complete-state CAP ZIP", () => {
  const xml = `<?xml version="1.0"?><alert><identifier>DWD-1</identifier><sent>2026-09-09T09:30:00+00:00</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><category>Met</category><event>Wind</event><severity>Severe</severity><onset>2026-09-09T09:00:00+00:00</onset><expires>2026-09-09T13:00:00+00:00</expires><area><areaDesc>Berlin</areaDesc><polygon>52.3,13.2 52.7,13.2 52.7,13.6 52.3,13.6 52.3,13.2</polygon></area></info></alert>`;

  it("parses bounded official CAP documents and intersects destinations", () => {
    const archive = zipSync({ "warning.xml": new TextEncoder().encode(xml) });
    expect(readCapZipArchive(archive)).toEqual([{ name: "warning.xml", xml }]);
    expect(parseDwdCap(xml, context)).toMatchObject([{ providerId: "meteoalarm", transportId: "dwd-cap", type: "severe-weather", level: "HIGH",
      geometry: { kind: "locations", ids: expect.arrayContaining(["de-berlin"]) } }]);
  });

  it("rejects traversal names, excessive XML, malformed XML, and unclosed polygons", () => {
    expect(() => readCapZipArchive(zipSync({ "../warning.xml": new TextEncoder().encode(xml) }))).toThrow(/Unsafe|exceeds/);
    expect(() => readCapZipArchive(zipSync({ "warning.xml": new Uint8Array(512 * 1024 + 1) }))).toThrow(/Unsafe|exceeds/);
    expect(() => parseDwdCap("<alert>", context)).toThrow(/Invalid/);
    expect(() => parseDwdCap(xml.replace("52.3,13.2</polygon>", "52.4,13.2</polygon>"), context)).toThrow(/closed/);
  });

  it.each(["forged stored size", "ZIP64 sentinel"])("rejects %s metadata before decompression", (mode) => {
    const archive = zipSync({ "warning.xml": new TextEncoder().encode(xml) }, { level: 0 });
    const changed = new Uint8Array(archive);
    let central = -1;
    for (let index = 0; index <= changed.length - 4; index += 1) if (changed[index] === 0x50 && changed[index + 1] === 0x4b
      && changed[index + 2] === 0x01 && changed[index + 3] === 0x02) { central = index; break; }
    expect(central).toBeGreaterThanOrEqual(0);
    new DataView(changed.buffer, changed.byteOffset, changed.byteLength).setUint32(central + 24, mode === "ZIP64 sentinel" ? 0xffffffff : 1, true);
    expect(() => readCapZipArchive(changed)).toThrow(/Unsafe|excessive/);
  });
});

describe("optional MeteoAlarm EDR recovery", () => {
  const ad = catalogLocationsV3.find(({ id }) => id === "ad-andorra-la-vella")!;
  const [longitude, latitude] = ad.centroid;
  const cap = `<?xml version="1.0"?><alert><identifier>EDR-1</identifier><sent>2026-09-09T09:30:00Z</sent><status>Actual</status><msgType>Update</msgType><scope>Public</scope><references>sender,OLD-1,2026-09-09T08:00:00Z</references><info><language>en</language><category>Met</category><event>Wind</event><severity>Severe</severity><onset>2026-09-09T09:00:00Z</onset><expires>2026-09-09T13:00:00Z</expires><area><areaDesc>Andorra la Vella</areaDesc><polygon>${latitude - 0.2},${longitude - 0.2} ${latitude + 0.2},${longitude - 0.2} ${latitude + 0.2},${longitude + 0.2} ${latitude - 0.2},${longitude + 0.2} ${latitude - 0.2},${longitude - 0.2}</polygon></area></info></alert>`;

  it("uses bearer authentication only on bounded EDR requests and follows only signed MeteoAlarm CAP links", async () => {
    vi.stubEnv("METEOALARM_API_TOKEN", "edr-secret");
    const signed = "https://storage.meteoalarm.org/api/warnings/EDR-1.xml?Expires=1780000000&Signature=signed";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1 ? Response.json({ type: "FeatureCollection", numberMatched: 1, numberReturned: 1,
        features: [{ type: "Feature", geometry: square(longitude, latitude), properties: {}, links: [{ rel: "xml", type: "application/xml", href: signed }] }] })
        : new Response(cap);
    };
    const result = await fetchNationalWeatherFallback("AD", { ...context, fetch: fetchMock });
    expect(result).toMatchObject({ transportId: "meteoalarm-edr", events: [{ type: "severe-weather", level: "HIGH",
      geometry: { kind: "locations", ids: expect.arrayContaining(["ad-andorra-la-vella"]) } }],
      removedEventPrefixes: expect.arrayContaining(["meteoalarm:edr:OLD-1:"]) });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/locations/AD?"); expect(calls[0].url).not.toContain("edr-secret");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer edr-secret");
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBeNull();
  });

  it("makes no request without a token and fails closed on malformed or non-MeteoAlarm linked CAP data", async () => {
    vi.stubEnv("METEOALARM_API_TOKEN", ""); const none = vi.fn<typeof globalThis.fetch>();
    await expect(fetchNationalWeatherFallback("AD", { ...context, fetch: none })).rejects.toThrow("credential_not_configured");
    expect(none).not.toHaveBeenCalled();
    expect(() => parseMeteoalarmEdrCaps([cap.replace("</polygon>", "</polygon><!ENTITY x 'bad'>")], "AD", context)).toThrow(/invalid/);

    vi.stubEnv("METEOALARM_API_TOKEN", "secret");
    const escaped = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ type: "FeatureCollection", numberMatched: 1, numberReturned: 1,
      features: [{ type: "Feature", geometry: square(longitude, latitude), properties: {}, links: [{ rel: "xml", type: "application/xml", href: "https://attacker.example/api/warnings/EDR.xml" }] }] }));
    await expect(fetchNationalWeatherFallback("AD", { ...context, fetch: escaped })).rejects.toThrow("not allowlisted");
    expect(escaped).toHaveBeenCalledTimes(1);
  });
});
