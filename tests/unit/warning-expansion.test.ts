import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { NormalizedEventSchema } from "@/lib/domain/schemas";
import { readCapArchive } from "@/lib/ingestion/cap-archive";
import { combineDirectWeatherCaps, fetchDirectWeatherCaps, parseDirectWeatherCap } from "@/lib/ingestion/adapters/direct-weather-cap";
import { fetchLvPartition, latviaResources, parseLatvianWarnings, rigaWarningTime, type LatvianTables } from "@/lib/ingestion/adapters/national-civil-alerts-lv";
import { fetchNationalWeatherFallback } from "@/lib/ingestion/adapters/national-weather-fallback";
import { NationalCivilAlertsAdapter } from "@/lib/ingestion/adapters/national-civil-alerts";
import { MeteoAlarmAdapter } from "@/lib/ingestion/adapters/meteoalarm";
import { nationalWarningManifest } from "@/lib/national-warning-sources";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";
import dhmzMapping from "../../data/dhmz-warning-mapping.json";

const fixture = (name: string) => readFileSync(`tests/fixtures/warning-expansion/${name}`);
const now = new Date("2026-09-07T08:00:00Z");
const context = { locations, now, fetch };
const updated = "2026-09-06T04:50:21.969Z";
const archive = fixture("aemet-current.tar.gz");
const realTables = JSON.parse(gunzipSync(fixture("lvgmc-tables.json.gz")).toString()) as LatvianTables;
const localContext = { ...context, locations: locations.filter((l) => ["lv-riga", "lv-liepaja", "lv-jelgava"].includes(l.id)) };
function tables() {
  return {
    warnings: [{ WEATHER_WARNING_EV_ID: 1, PARADIBA_EN: "Water level", INTENSITY_EN: "Yellow", TIME_FROM: "2026-09-07T09:00:00", TIME_TILL: "2026-09-07T15:00:00", REGIONS_EN: "Riga", TEKSTS_EN: "An official flood warning." }],
    polygons: [[23.5, 56.7], [24.5, 56.7], [24.5, 57.2], [23.5, 57.2], [23.5, 56.7]].map(([LON, LAT], i) => ({ WEATHER_WARNING_EV_ID: 1, POLIGON_ID: 1, NPK: i + 1, LAT, LON })),
    warningMunicipalities: [{ WEATHER_WARNING_EV_ID: 1, NOV_ID: 43 }], municipalities: realTables.municipalities,
  };
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Latvian official hydrological warnings", () => {
  it("reconstructs a real 28,412-point polygon and limits the current warning to Liepāja", () => {
    const result = parseLatvianWarnings(realTables, context, updated);
    expect(result.status).toBe("ok");
    expect(result.checkedLocationIds).toHaveLength(7);
    expect(result.events.map((e) => e.geometry)).toEqual([{ kind: "locations", ids: ["lv-liepaja"] }]);
    expect(result.events[0].endsAt).toBe("2026-09-07T10:00:00.000Z");
    result.events.forEach((e) => expect(NormalizedEventSchema.safeParse(e).success).toBe(true));
  });
  it.each([["2026-01-15T12:00:00", "2026-01-15T10:00:00.000Z"], ["2026-07-15T12:00:00", "2026-07-15T09:00:00.000Z"]])("interprets Riga local time %s", (input, expected) => {
    expect(new Date(rigaWarningTime(input)).toISOString()).toBe(expected);
  });
  it.each(["2026-03-29T03:30:00", "2026-10-25T03:30:00", "2026-02-30T12:00:00", "garbage"])("rejects ambiguous/nonexistent local time %s", (value) => {
    expect(() => rigaWarningTime(value)).toThrow();
  });
  it("sorts polygon vertices and retains exact Riga municipality scope", () => {
    const data = tables(); data.polygons.reverse();
    const result = parseLatvianWarnings(data, localContext, updated);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].geometry).toEqual({ kind: "locations", ids: ["lv-riga"] });
    data.warningMunicipalities[0].NOV_ID = 38;
    expect(parseLatvianWarnings(data, localContext, updated).events.every((e) => e.geometry.kind === "locations" && !e.geometry.ids.includes("lv-riga"))).toBe(true);
  });
  it("does not discard a separate Riga warning identity", () => {
    const data = tables();
    data.warnings.push({ ...data.warnings[0], WEATHER_WARNING_EV_ID: 2, TIME_FROM: "2026-09-07T12:00:00", INTENSITY_EN: "Orange" });
    data.polygons.push(...data.polygons.map((p) => ({ ...p, WEATHER_WARNING_EV_ID: 2 })));
    data.warningMunicipalities.push({ WEATHER_WARNING_EV_ID: 2, NOV_ID: 43 });
    expect(parseLatvianWarnings(data, localContext, updated).events.map((e) => [e.timing, e.level])).toEqual([["ACTIVE", "ELEVATED"], ["UPCOMING", "HIGH"]]);
  });
  it("expires warnings, ignores other weather classes and recognizes a complete empty list", () => {
    const data = tables(); data.warnings[0].TIME_TILL = "2026-09-07T10:00:00";
    expect(parseLatvianWarnings(data, localContext, updated).events).toHaveLength(0);
    data.warnings[0].PARADIBA_EN = "Wind";
    expect(parseLatvianWarnings(data, localContext, updated).events).toHaveLength(0);
    expect(parseLatvianWarnings({ ...data, warnings: [], polygons: [], warningMunicipalities: [] }, localContext, updated)).toMatchObject({ status: "ok", events: [] });
  });
  it.each(["missing-join", "missing-vertex", "duplicate-vertex", "open-ring", "unknown-intensity"])("marks %s partial without clearing any destination", (problem) => {
    const data = tables();
    if (problem === "missing-join") data.warningMunicipalities = [];
    if (problem === "missing-vertex") data.polygons.splice(1, 1);
    if (problem === "duplicate-vertex") data.polygons.push(data.polygons[0]);
    if (problem === "open-ring") data.polygons.at(-1)!.LON += 0.1;
    if (problem === "unknown-intensity") data.warnings[0].INTENSITY_EN = "Purple";
    expect(parseLatvianWarnings(data, localContext, updated)).toMatchObject({ status: "partial", checkedLocationIds: [], unavailableLocationIds: expect.arrayContaining(["lv-riga"]) });
  });
  it("rejects orphan joins and municipality ID changes", () => {
    const data = tables(); data.warningMunicipalities[0].NOV_ID = 999;
    expect(() => parseLatvianWarnings(data, localContext, updated)).toThrow(/generation/);
    expect(() => parseLatvianWarnings({ ...tables(), municipalities: [] }, localContext, updated)).toThrow(/mapping/);
  });
  it("checks table generations before and after fetching and rejects pagination truncation", async () => {
    const data = tables(); let packages = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("package_show")) return Response.json({ success: true, result: { resources: Object.values(latviaResources).map((id) => ({ id, last_modified: ++packages > 4 ? "2026-09-06T05:00:00" : "2026-09-06T04:00:00" })) } });
      const key = (Object.keys(latviaResources) as Array<keyof LatvianTables>).find((k) => latviaResources[k] === url.searchParams.get("resource_id"))!;
      return Response.json({ success: true, result: { total: data[key].length, records: data[key] } });
    });
    await expect(fetchLvPartition({ ...context, fetch: fetchMock })).rejects.toThrow(/changed during pagination/);
    const truncated = vi.fn(async (input: RequestInfo | URL) => String(input).includes("package_show")
      ? Response.json({ success: true, result: { resources: Object.values(latviaResources).map((id) => ({ id, last_modified: updated })) } })
      : Response.json({ success: true, result: { total: 3, records: [] } }));
    await expect(fetchLvPartition({ ...context, fetch: truncated })).rejects.toThrow(/pagination/);
  });
});

describe("direct AEMET and DHMZ CAP", () => {
  it("keeps distinct regions with identical destination matches and different severities", () => {
    const infos = [["Knin region", "Moderate"], ["Split region", "Severe"]].map(([name, severity]) =>
      `<info><language>en</language><category>Met</category><severity>${severity}</severity><onset>2026-09-07T00:00:00+02:00</onset><expires>2026-09-07T23:59:59+02:00</expires><parameter><valueName>awareness_type</valueName><value>5; high-temperature</value></parameter><area><areaDesc>${name}</areaDesc></area></info>`).join("");
    const result = parseDirectWeatherCap(`<alert><identifier>distinct-areas</identifier><sender>https://meteo.hr</sender><sent>2026-09-07T07:00:00Z</sent><status>Actual</status><scope>Public</scope><msgType>Alert</msgType>${infos}</alert>`, "HR", context);
    expect(result.events.map((event) => [event.affectedArea, event.level])).toEqual([["Knin region", "ELEVATED"], ["Split region", "HIGH"]]);
    expect(result.events[0].geometry).toEqual(result.events[1].geometry);
    expect(result.events[0].id).not.toBe(result.events[1].id);
  });
  it("decodes the complete real AEMET archive and publishes valid current/next-day events", () => {
    const records = readCapArchive(archive).map(({ xml }) => parseDirectWeatherCap(xml, "ES", context));
    expect(records).toHaveLength(331);
    const result = combineDirectWeatherCaps(records, "ES", "2026-09-07T06:59:45Z");
    expect(result.events).toHaveLength(19);
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
    result.events.forEach((e) => expect(NormalizedEventSchema.safeParse(e).success).toBe(true));
  });
  it("uses explicit island offsets without mainland conversion", () => {
    const xml = fixture("aemet-1.xml").toString();
    expect(parseDirectWeatherCap(xml, "ES", context).events).toHaveLength(0);
    const result = parseDirectWeatherCap(xml, "ES", { ...context, now: new Date("2026-09-08T12:00:00Z") });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ startsAt: "2026-09-09T09:00:00.000Z", timing: "UPCOMING", geometry: { kind: "locations", ids: ["es-las-palmas-de-gran-canaria"] } });
  });
  it("parses all Croatian areas and deduplicates languages, including coastal warnings", () => {
    const result = parseDirectWeatherCap(fixture("dhmz-today.xml").toString(), "HR", { ...context, now: new Date("2026-09-07T05:00:00Z") });
    expect(result.events.filter((e) => e.type === "extreme-heat")).toHaveLength(3);
    expect(result.events.some((e) => e.type === "coastal")).toBe(true);
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
    result.events.forEach((e) => expect(NormalizedEventSchema.safeParse(e).success).toBe(true));
    expect(dhmzMapping.mappings).toHaveLength(14);
    const mapped = new Set(dhmzMapping.mappings.flatMap((m) => m.locationIds));
    expect([...mapped].sort()).toEqual(locations.filter((l) => l.countryCode === "HR").map((l) => l.id).sort());
    for (const mapping of dhmzMapping.mappings.filter((m) => m.kind === "sea")) for (const id of mapping.locationIds) expect(locations.find((l) => l.id === id)!.isCoastal).toBe(true);
  });
  it("applies cancellation references regardless of archive order", () => {
    const xml = fixture("dhmz-today.xml").toString(); const first = parseDirectWeatherCap(xml, "HR", context);
    const cancellation = `<alert><identifier>cancel</identifier><sender>https://meteo.hr</sender><sent>2026-09-07T07:55:00Z</sent><status>Actual</status><scope>Public</scope><msgType>Cancel</msgType><references>https://meteo.hr,${first.identifier},2026-09-07T07:00:00Z</references></alert>`;
    const cancel = parseDirectWeatherCap(cancellation, "HR", context);
    expect(combineDirectWeatherCaps([cancel, first], "HR", "2026-09-07T07:55:00Z").events).toHaveLength(0);
    const update = parseDirectWeatherCap(xml.replace(first.identifier, "updated").replace("<msgType>Alert</msgType>", `<msgType>Update</msgType><references>https://meteo.hr,${first.identifier},2026-09-07T07:00:00Z</references>`), "HR", context);
    expect(combineDirectWeatherCaps([first, update], "HR", "2026-09-07T07:55:00Z").events.every((e) => e.id.includes(":updated:"))).toBe(true);
  });
  it("rejects malformed XML, unknown active geography, missing offsets and unknown severity", () => {
    const xml = fixture("dhmz-today.xml").toString();
    for (const invalid of ["<alert>", xml.replaceAll("Rijeka region", "Unknown place").replaceAll("Riječka regija", "Unknown translation"), xml.replaceAll("Moderate", "Unknown"), xml.replaceAll("+02:00", ""), xml.replace("<sender>https://meteo.hr</sender>", "<sender>unreviewed</sender>")]) expect(() => parseDirectWeatherCap(invalid, "HR", context)).toThrow();
    expect(parseDirectWeatherCap(xml.replaceAll("Riječka regija", "A new translated label"), "HR", context).events).toEqual(parseDirectWeatherCap(xml, "HR", context).events);
  });
  it("rejects unsupported tar entries, corrupt checksums, truncation and decompression overflow", () => {
    const raw = gunzipSync(archive);
    for (const type of ["2", "5", "x"]) {
      const changed = Buffer.from(raw); changed[156] = type.charCodeAt(0); changed.fill(32, 148, 156);
      const sum = changed.subarray(0, 512).reduce((a, b) => a + b, 0); changed.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      expect(() => readCapArchive(gzipSync(changed))).toThrow(/entry/);
    }
    const corrupt = Buffer.from(raw); corrupt[0] = 0;
    expect(() => readCapArchive(gzipSync(corrupt))).toThrow(/checksum/);
    expect(() => readCapArchive(gzipSync(raw.subarray(0, 1000)))).toThrow(/Truncated/);
    expect(() => readCapArchive(gzipSync(Buffer.alloc(9 * 1024 * 1024)))).toThrow();
  });
  it("fetches only the index and advertised complete archive and rejects unapproved links", async () => {
    const index = '<feed><updated>2026-09-07T06:59:45Z</updated><entry><link href="https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/Z_CAP_C_LEMM_20260907065945_AFAE.tar.gz"/></entry></feed>';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(".xml") ? new Response(index) : new Response(new Uint8Array(archive)));
    expect((await fetchDirectWeatherCaps("ES", { ...context, fetch: fetchMock })).events).toHaveLength(19);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(fetchDirectWeatherCaps("ES", { ...context, fetch: vi.fn(async () => new Response(index.replaceAll("www.aemet.es", "untrusted.example"))) })).rejects.toThrow(/approved/);
  });
  it("makes no fallback request when its transport or country is disabled", async () => {
    const fetchMock = vi.fn(); vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", "aemet-cap");
    expect(await fetchNationalWeatherFallback("ES", { ...context, fetch: fetchMock })).toBeNull();
    vi.stubEnv("NATIONAL_ALERTS_DISABLED_COUNTRIES", "HR");
    expect(await fetchNationalWeatherFallback("HR", { ...context, fetch: fetchMock })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not let a fresh tomorrow document hide a stale DHMZ today document", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const tomorrow = String(input).includes("tomorrow");
      const xml = fixture(tomorrow ? "dhmz-tomorrow.xml" : "dhmz-today.xml").toString();
      return new Response(tomorrow ? xml : xml.replace(/<sent>[^<]+<\/sent>/, "<sent>2026-09-05T15:23:33Z</sent>"));
    };
    await expect(fetchDirectWeatherCaps("HR", { ...context, fetch: fetchMock })).rejects.toThrow(/stale/);
  });
});

describe("warning expansion lifecycle integration", () => {
  it.each(["ES", "HR"] as const)("applies %s direct cancellations to retained primary warnings without clearing unrelated warnings", async (country) => {
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "false");
    const direct = country === "HR" ? parseDirectWeatherCap(fixture("dhmz-today.xml").toString(), country, context)
      : readCapArchive(archive).map(({ xml }) => parseDirectWeatherCap(xml, country, context)).find((record) => record.events.length)!;
    const state = createEmptyState(now);
    const original = direct.events[0];
    expect(original).toBeDefined();
    state.events = [
      { ...original, id: `meteoalarm:${direct.identifier}:old`, transportId: "meteoalarm-primary" },
      { ...original, id: "meteoalarm:unrelated:keep", transportId: "meteoalarm-primary" },
    ];
    const result = await new MeteoAlarmAdapter().fetch({ ...context, fetch: async () => new Response('<feed><updated>2026-09-07T08:00:00Z</updated></feed>') });
    const prefix = country === "ES" ? "meteoalarm:aemet:" : "meteoalarm:dhmz:";
    const transport = country === "ES" ? "aemet-cap" : "dhmz-cap";
    result.partitions[country] = {
      status: "partial", sourceUpdatedAt: now.toISOString(), error: "Primary failed", events: [],
      transports: {
        "meteoalarm-primary": { status: "failed", sourceUpdatedAt: null, error: "offline", events: [] },
        [transport]: { status: "ok", sourceUpdatedAt: now.toISOString(), error: null, events: [], removedEventPrefixes: [prefix, `${prefix}${direct.identifier}:`] },
      },
    };
    const merged = mergeSourceResults(state, [result], now);
    expect(merged.events.map((event) => event.id)).toEqual(["meteoalarm:unrelated:keep"]);
  });
  const disableExceptLatvia = () => vi.stubEnv("NATIONAL_ALERTS_DISABLED_COUNTRIES", Object.keys(nationalWarningManifest.countries).filter((c) => c !== "LV").join(","));
  const latvianFetch = (data: LatvianTables): typeof fetch => async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("package_show")) return Response.json({ success: true, result: { resources: Object.values(latviaResources).map((id) => ({ id, last_modified: updated })) } });
    const key = (Object.keys(latviaResources) as Array<keyof LatvianTables>).find((k) => latviaResources[k] === url.searchParams.get("resource_id"))!;
    return Response.json({ success: true, result: { total: data[key].length, records: data[key] } });
  };
  it("rolls back Latvia independently with zero requests and removes its own retained warnings", async () => {
    disableExceptLatvia();
    const adapter = new NationalCivilAlertsAdapter();
    const first = await adapter.fetch({ ...context, fetch: latvianFetch(tables()) });
    const state = mergeSourceResults(createEmptyState(now), [first], now);
    vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", "lvgmc-flood");
    const fetchMock = vi.fn();
    const disabled = await adapter.fetch({ ...context, state, fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(disabled.partitions.LV.transports!["lvgmc-flood"].status).toBe("disabled");
    expect(mergeSourceResults(state, [disabled], now).events.some((e) => e.transportId === "lvgmc-flood")).toBe(false);
  });
  it("retains valid warnings on partial joins and network failure, replaces changed areas, and clears complete cancellations", async () => {
    disableExceptLatvia(); const adapter = new NationalCivilAlertsAdapter();
    const first = await adapter.fetch({ ...context, fetch: latvianFetch(tables()) });
    let state = mergeSourceResults(createEmptyState(now), [first], now);
    const prior = state.events.filter((e) => e.transportId === "lvgmc-flood"); expect(prior.length).toBeGreaterThan(0);
    const incomplete = tables(); incomplete.polygons = [];
    const later = new Date(now.getTime() + 11 * 60_000);
    const partial = await adapter.fetch({ ...context, now: later, state, fetch: latvianFetch(incomplete) });
    state = mergeSourceResults(state, [partial], later);
    expect(state.events.filter((e) => e.transportId === "lvgmc-flood")).toEqual(prior);
    const failed = await adapter.fetch({ ...context, now: new Date(later.getTime() + 11 * 60_000), fetch: async () => { throw new Error("offline"); } });
    expect(mergeSourceResults(state, [failed], later).events).toEqual(state.events);
    const changed = tables(); changed.polygons.forEach((p) => { p.LON -= 3; }); changed.warningMunicipalities[0].NOV_ID = 40;
    const replacement = await adapter.fetch({ ...context, now: new Date(later.getTime() + 22 * 60_000), fetch: latvianFetch(changed) });
    state = mergeSourceResults(state, [replacement], later);
    expect(state.events.some((e) => e.id === "lv:hydrology:1:lv-riga")).toBe(false);
    const empty = { ...tables(), warnings: [], polygons: [], warningMunicipalities: [] };
    const cleared = await adapter.fetch({ ...context, now: new Date(later.getTime() + 33 * 60_000), fetch: latvianFetch(empty) });
    expect(mergeSourceResults(state, [cleared], later).events.filter((e) => e.transportId === "lvgmc-flood")).toHaveLength(0);
  });
  it("runs DHMZ only after primary failure and removes its records on rollback even if the primary still fails", async () => {
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "false");
    const empty = '<feed><updated>2026-09-07T08:00:00Z</updated></feed>';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("meteo.hr/")) return new Response(fixture(url.includes("tomorrow") ? "dhmz-tomorrow.xml" : "dhmz-today.xml").toString());
      if (url.endsWith("-croatia")) return new Response("invalid");
      return new Response(empty);
    });
    const result = await new MeteoAlarmAdapter().fetch({ ...context, fetch: fetchMock });
    expect(result.partitions.HR).toMatchObject({ limitationCode: "national_authority_fallback", transports: { "dhmz-cap": { status: "ok" } } });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("meteo.hr/"))).toHaveLength(2);
    const state = mergeSourceResults(createEmptyState(now), [result], now);
    expect(state.events.some((e) => e.transportId === "dhmz-cap")).toBe(true);
    const unavailable = await new MeteoAlarmAdapter().fetch({ ...context, state, fetch: async () => { throw new Error("offline"); } });
    expect(mergeSourceResults(state, [unavailable], now).events).toEqual(state.events);
    const healthyPrimary = await new MeteoAlarmAdapter().fetch({ ...context, state, fetch: async () => new Response(empty) });
    expect(mergeSourceResults(state, [healthyPrimary], now).events.some((e) => e.transportId === "dhmz-cap")).toBe(false);
    const cancelled = structuredClone(unavailable);
    const authorityId = parseDirectWeatherCap(fixture("dhmz-today.xml").toString(), "HR", context).identifier;
    cancelled.partitions.HR.transports!["meteoalarm-primary"] = {
      status: "partial", sourceUpdatedAt: now.toISOString(), error: "One unrelated entry was invalid", events: [], removedEventPrefixes: [`meteoalarm:${authorityId}:`],
    };
    expect(mergeSourceResults(state, [cancelled], now).events.some((e) => e.id.startsWith(`meteoalarm:dhmz:${authorityId}:`))).toBe(false);
    fetchMock.mockClear(); vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", "dhmz-cap");
    const rollback = await new MeteoAlarmAdapter().fetch({ ...context, state, fetch: fetchMock });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("meteo.hr/"))).toBe(false);
    expect(mergeSourceResults(state, [rollback], now).events.some((e) => e.transportId === "dhmz-cap")).toBe(false);
  });
});
