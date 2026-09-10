import { describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { countryCodes, PartitionedSourceResultSchema, type DiscoveryCandidate, type NormalizedEvent } from "@/lib/domain/schemas";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";
import chmiMapping from "../../data/chmi-hydrology-mapping.json";
import chmiNonempty from "../fixtures/providers/chmi-flash-flood-nonempty.json";
import { fetchCzPartition, parseChmiFlashFlood, parseChmiStation } from "@/lib/ingestion/adapters/national-civil-alerts-cz";
import { currentImgwBulletinNames, fetchPlPartition, parseImgwBulletin, parseImgwMeasurements } from "@/lib/ingestion/adapters/national-civil-alerts-pl";
import { effisCandidatePixels, effisPerimeterNearLocation, parseEffisPerimeterGml, parseEffisPerimeters } from "@/lib/ingestion/adapters/firms";
import { GdeltAdapter, parseGdeltGeo, corroboratedGdeltEvents } from "@/lib/ingestion/adapters/gdelt";
import { ifrcFallbackQuery, parseIfrcMeteoAlarm } from "@/lib/ingestion/adapters/ifrc-meteoalarm";
import { glofasRiskMask, selectGlofasLocations } from "@/lib/ingestion/adapters/satellite";
import { clusterPublicHazards } from "@/lib/risk-snapshot";
import { withFetchDiagnostics } from "@/lib/ingestion/fetch";
import { createSourceDiagnostics } from "@/lib/ingestion/types";

const now = new Date("2026-08-29T19:00:00Z");
const context = { now, locations, fetch };

function event(id: string, sourceUrl: string, confidence: "HIGH" | "MEDIUM" = "MEDIUM"): NormalizedEvent {
  return { id, sourceId: "gdelt", providerId: "gdelt", type: "security", level: "ELEVATED", timing: "ACTIVE",
    headline: "Multiple independent reports indicate a security incident near Vienna.", explanation: "Fixed TravelCanary context.",
    action: "Check official local information.", affectedArea: "Vienna", geometry: { kind: "locations", ids: ["at-vienna"] },
    startsAt: "2026-08-29T18:00:00Z", endsAt: "2026-08-30T00:00:00Z", sourceUpdatedAt: "2026-08-29T18:30:00Z",
    checkedAt: now.toISOString(), expiresAt: "2026-08-30T00:00:00Z", sourceName: id, sourceUrl, confidence };
}

describe("Snapshot V8 clustering", () => {
  it("chooses the authoritative primary and caps deduplicated evidence", () => {
    const events = [event("primary", "https://bbc.com/a", "HIGH"), ...Array.from({ length: 7 }, (_, index) => event(`source-${index}`, `https://example.com/${index}`))];
    const result = clusterPublicHazards(events, now);
    expect(result.hazards).toHaveLength(1);
    expect(result.hazards[0]).toMatchObject({ id: "primary", confidence: "HIGH" });
    expect(result.hazards[0].evidence).toHaveLength(5);
    expect(result.evidenceOverflow).toBe(3);
  });

  it("keeps the incident ID and evidence order stable across input order", () => {
    const values = [event("older", "https://bbc.com/older"), { ...event("newer", "https://apnews.com/newer"), sourceUpdatedAt: "2026-08-29T18:40:00Z" }];
    expect(clusterPublicHazards(values, now)).toEqual(clusterPublicHazards(values.slice().reverse(), now));
    expect(clusterPublicHazards(values, now).hazards[0].id).toBe("newer");
  });

  it("does not cluster a distinct level or headline", () => {
    const distinct = { ...event("distinct", "https://apnews.com/b"), level: "HIGH" as const };
    expect(clusterPublicHazards([event("base", "https://bbc.com/a"), distinct], now).hazards).toHaveLength(2);
  });

  it("deduplicates canonical evidence URLs without allowing support to extend lifecycle", () => {
    const primary = event("primary", "https://bbc.com/a?b=2&a=1", "HIGH");
    const support = { ...event("support", "https://bbc.com/a?a=1&b=2&utm_source=wire#latest"), endsAt: "2026-08-30T03:00:00Z", expiresAt: "2026-08-30T03:00:00Z" };
    const hazard = clusterPublicHazards([primary, support], now).hazards[0];
    expect(hazard.evidence).toEqual([expect.objectContaining({ sourceUrl: "https://bbc.com/a?a=1&b=2" })]);
    expect(hazard.expiresAt).toBe(primary.expiresAt);
  });
});

describe("Polish and Czech flood contracts", () => {
  it("ignores exact out-of-scope hydrological drought notices, including cancellations without flood degrees", () => {
    const cancellation = "Data i godzina wydania: 31.08.2026 - godz. 09:26\nOdwołanie ostrzeżenia Nr: 93 z dnia 04.08.2026\nZjawisko: susza hydrologiczna\nStopień: nie dotyczy\nWażność: od godz.  dnia  do godz.  dnia\nObszar: Wierzyca (pomorskie)";
    expect(parseImgwBulletin(cancellation, "https://danepubliczne.imgw.pl/a.TXT", context)).toEqual([]);
    expect(parseImgwBulletin(cancellation.replace("Odwołanie ostrzeżenia", "Ostrzeżenie"), "https://danepubliczne.imgw.pl/a.TXT", context)).toEqual([]);
    expect(() => parseImgwBulletin(cancellation.replace("susza hydrologiczna", "wezbranie"), "https://danepubliczne.imgw.pl/a.TXT", context)).toThrow(/degree/);
    expect(() => parseImgwBulletin(cancellation.replace("susza hydrologiczna", "unknown"), "https://danepubliczne.imgw.pl/a.TXT", context)).toThrow(/degree/);
  });

  it("maps IMGW warning and alarm boundaries and rejects stale/future evidence", () => {
    const base = { id_stacji: "153230080", stacja: "Sochonie", rzeka: "Czarna", stan_ostrzegawczy: "180", stan_alarmowy: "220" };
    const warning = parseImgwMeasurements([{ ...base, stan_wody: "180", stan_wody_data_pomiaru: "2026-08-29T18:30:00Z" }], context);
    const alarm = parseImgwMeasurements([{ ...base, stan_wody: "220", stan_wody_data_pomiaru: "2026-08-29T18:30:00Z" }], context);
    expect(warning.events[0]).toMatchObject({ level: "ELEVATED" });
    expect(alarm.events[0]).toMatchObject({ level: "HIGH" });
    expect(parseImgwMeasurements([{ ...base, stan_wody: "300", stan_wody_data_pomiaru: "2026-08-29T16:00:00Z" }], context)).toMatchObject({ events: [], staleLocationIds: ["pl-bialystok"] });
    expect(parseImgwMeasurements([{ ...base, stan_wody: "300", stan_wody_data_pomiaru: "2026-08-29T19:06:00Z" }], context)).toMatchObject({ events: [], staleLocationIds: ["pl-bialystok"] });
  });

  it("keeps a destination current when one of its reviewed IMGW stations is fresh", () => {
    const row = (id: string, measuredAt: string) => ({ id_stacji: id, stan_wody: "100", stan_ostrzegawczy: "180", stan_alarmowy: "220", stan_wody_data_pomiaru: measuredAt });
    const result = parseImgwMeasurements([
      row("153230080", "2026-08-29T18:30:00Z"),
      row("153230010", "2026-08-20T18:30:00Z"),
    ], context);
    expect(result.unavailableLocationIds).not.toContain("pl-bialystok");
    expect(result.staleLocationIds).not.toContain("pl-bialystok");
  });

  it("interprets timezone-less IMGW API measurements as UTC while bulletins remain Warsaw civil time", () => {
    const location = locations.find(({ id }) => id === "pl-bialystok")!;
    const winterContext = { now: new Date("2026-01-15T12:00:00Z"), locations: [location], fetch };
    const base = { id_stacji: "153230080", stacja: "Sochonie", rzeka: "Czarna", stan_wody: "220", stan_ostrzegawczy: "180", stan_alarmowy: "220" };
    expect(parseImgwMeasurements([{ ...base, stan_wody_data_pomiaru: "2026-01-15 11:30:00" }], winterContext).events[0].sourceUpdatedAt).toBe("2026-01-15T11:30:00.000Z");
    expect(parseImgwMeasurements([{ ...base, stan_wody_data_pomiaru: "2026-08-29 18:30:00" }], context).events[0].sourceUpdatedAt).toBe("2026-08-29T18:30:00.000Z");
  });

  it("applies one bulk IMGW station observation to every reviewed destination mapping", () => {
    const row = { id_stacji: "152210040", stacja: "Warszawa-Bulwary", rzeka: "Wisła", stan_wody: "500", stan_ostrzegawczy: "450", stan_alarmowy: "600", stan_wody_data_pomiaru: "2026-08-29T18:30:00Z" };
    expect(parseImgwMeasurements([row], context).events.map(({ id }) => id).sort()).toEqual([
      "pl:measurement:152210040:pl-mokotow",
      "pl:measurement:152210040:pl-praga-poludnie",
      "pl:measurement:152210040:pl-ursynow",
      "pl:measurement:152210040:pl-warsaw",
    ]);
  });

  it("fails closed when IMGW omits mapped stations or returns empty numeric fields", () => {
    const valid = { id_stacji: "153230080", stan_wody: "100", stan_ostrzegawczy: "180", stan_alarmowy: "220", stan_wody_data_pomiaru: "2026-08-29T18:30:00Z" };
    const omitted = parseImgwMeasurements([valid], context);
    expect(omitted.missingLocationIds).toContain("pl-warsaw");
    expect(omitted.unavailableLocationIds).toContain("pl-warsaw");
    const empty = parseImgwMeasurements([valid, { ...valid, id_stacji: "152210170", stan_wody: null }], context);
    expect(empty.invalid).toBe(1);
    expect(empty.unavailableLocationIds).toContain("pl-warsaw");
  });

  it("retains an unexpired IMGW measurement when its mapped station is omitted", async () => {
    const previous = { ...event("pl:measurement:152210170:pl-warsaw", "https://danepubliczne.imgw.pl/api/data/hydro/", "HIGH"),
      sourceId: "national-civil-alerts" as const, providerId: "national-civil-alerts" as const, type: "flood" as const,
      geometry: { kind: "locations" as const, ids: ["pl-warsaw"] }, expiresAt: "2026-08-29T19:20:00Z" };
    const state = createEmptyState(now); state.events = [previous];
    const row = { id_stacji: "153230080", stan_wody: "100", stan_ostrzegawczy: "180", stan_alarmowy: "220", stan_wody_data_pomiaru: "2026-08-29T18:30:00Z" };
    const result = await fetchPlPartition({ ...context, state, fetch: (async (input) => String(input).includes("/api/data/hydro/")
      ? Response.json([row]) : new Response("<html></html>")) as typeof fetch });
    expect(result).toMatchObject({ status: "partial", unavailableLocationIds: expect.arrayContaining(["pl-warsaw"]) });
    expect(result.events).toContainEqual(previous);
  });

  it("maps structured IMGW bulletin degrees without allowing measurements to become severe", () => {
    const bulletin = (degree: number) => `Data i godzina wydania: 29.08.2026 - godz. 09:50\nOstrzeżenie hydrologiczne Nr: 42\nStopień: ${degree}\nWażność: od godz. 15:00 dnia 29.08.2026 do godz. 00:00 dnia 30.08.2026\nObszar: Białystok, Czarna, podlaskie`;
    expect([1, 2, 3].map((degree) => parseImgwBulletin(bulletin(degree), "https://danepubliczne.imgw.pl/a.TXT", context)[0].level)).toEqual(["ELEVATED", "HIGH", "SEVERE"]);
    expect(parseImgwBulletin(bulletin(2), "https://danepubliczne.imgw.pl/a.TXT", context)[0]).toMatchObject({
      sourceUpdatedAt: "2026-08-29T07:50:00.000Z", startsAt: "2026-08-29T13:00:00.000Z", endsAt: "2026-08-29T22:00:00.000Z", timing: "ACTIVE",
    });
  });

  it("requires a reviewed region-and-water pair instead of a broad river-name match", () => {
    const bulletin = `Data i godzina wydania: 29.08.2026 - godz. 09:50\nStopień: 1\nWażność: od godz. 15:00 dnia 29.08.2026 do godz. 00:00 dnia 30.08.2026\nObszar: rzeka Wisła (warmińsko-mazurskie) oraz Pasłęka`;
    expect(parseImgwBulletin(bulletin, "https://danepubliczne.imgw.pl/42.TXT", context).map(({ geometry }) => geometry.kind === "locations" ? geometry.ids[0] : "")).toEqual(["pl-olsztyn"]);
  });

  it("fails closed on malformed or future-dated bulletin lifecycle fields", () => {
    const base = `Stopień: 1\nObszar: Białystok, Czarna, podlaskie\nWażność: od godz. 15:00 dnia 29.08.2026 do godz. 00:00 dnia 30.08.2026`;
    expect(() => parseImgwBulletin(`Data i godzina wydania: unknown\n${base}`, "https://danepubliczne.imgw.pl/a.TXT", context)).toThrow(/issue time/);
    expect(() => parseImgwBulletin(`Data i godzina wydania: 29.08.2026 - godz. 21:06\n${base}`, "https://danepubliczne.imgw.pl/a.TXT", context)).toThrow(/issue time/);
    expect(() => parseImgwBulletin(`Data i godzina wydania: 29.08.2026 - godz. 09:50\nStopień: 1\nObszar: Białystok`, "https://danepubliczne.imgw.pl/a.TXT", context)).toThrow(/validity/);
  });

  it("detects a truncated IMGW warning run instead of silently selecting 32 files", () => {
    const directory = Array.from({ length: 33 }, (_, index) => `<a href="warning-${index}.TXT">warning</a>`).join("");
    expect(() => currentImgwBulletinNames(directory)).toThrow(/completeness limit/);
    expect(currentImgwBulletinNames('<a href="one.TXT">one</a><a href="one.TXT">duplicate</a>')).toEqual(["one.TXT"]);
  });

  it("uses the matching CHMI H/Q series and caps SPA2+ measurement evidence at high", () => {
    const station = { objID: "x", dbc: "1", name: "Test", stream: "River", kind: "Q" as const, spa1: 10, spa2: 20, spa3: 30 };
    const payload = (value: number) => ({ objList: [{ objID: "x", tsList: [{ tsConID: "H", tsData: [{ dt: now.toISOString(), value: 999 }] }, { tsConID: "Q", tsData: [{ dt: now.toISOString(), value }] }] }] });
    expect(parseChmiStation(payload(9), station, context)).toBeNull();
    expect(parseChmiStation(payload(10), station, context)).toMatchObject({ value: 10, level: "ELEVATED" });
    expect(parseChmiStation(payload(20), station, context)).toMatchObject({ value: 20, level: "HIGH" });
    expect(parseChmiStation(payload(30), station, context)).toMatchObject({ value: 30, level: "HIGH" });
    expect(() => parseChmiStation(payload(30), { ...station, spa2: Number.NaN }, context)).toThrow(/thresholds/);
    const stale = { objList: [{ objID: "x", tsList: [{ tsConID: "Q", tsData: [{ dt: "2026-08-29T16:00:00Z", value: 30 }] }] }] };
    expect(() => parseChmiStation(stale, station, context)).toThrow(/stale/);
    const missing = { objList: [{ objID: "x", tsList: [{ tsConID: "Q", tsData: [{ dt: now.toISOString(), value: null }] }] }] };
    expect(() => parseChmiStation(missing, station, context)).toThrow(/stale/);
  });

  it("accepts report-only CHMI flash metadata as healthy empty and fails on unknown classes", () => {
    expect(parseChmiFlashFlood({ datumVytvoreni: "2026-08-29T18:55:00Z", data: { report: { creator: "ČHMÚ" } } }, context)).toEqual([]);
    expect(() => parseChmiFlashFlood({ datumVytvoreni: "2026-08-29T18:55:00Z", data: { report: {}, risks: [{ name: "Brno", kod_orp_ruian: "x", riziko_grid: 1, riziko_povodi: 1, riziko_vysledne: 9, riziko_popis: "fixture" }] } }, context)).toThrow(/undocumented/);
  });

  it("maps the reviewed non-empty CHMI contract and official result class", () => {
    expect(parseChmiFlashFlood(chmiNonempty, context)).toMatchObject([
      { level: "SEVERE", affectedArea: "Brno", geometry: { kind: "locations", ids: ["cz-brno"] } },
      { level: "SEVERE", affectedArea: "Brno", geometry: { kind: "locations", ids: ["cz-brno-stred"] } },
    ]);
  });

  it("isolates a failed CHMI station to only its mapped destination", async () => {
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("risk_FF_web.json")) return new Response(JSON.stringify({ datumVytvoreni: "2026-08-29T18:55:00Z", data: { report: { creator: "ČHMÚ" } } }), { status: 200 });
      const objID = new URL(url).pathname.split("/").at(-1)!.replace(/\.json$/, "");
      if (objID === "0-203-1-266000") return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ objList: [{ objID, tsList: [
        { tsConID: "H", tsData: [{ dt: "2026-08-29T18:55:00Z", value: 0 }] },
        { tsConID: "Q", tsData: [{ dt: "2026-08-29T18:55:00Z", value: 0 }] },
      ] }] }), { status: 200 });
    }) as typeof fetch;
    const result = await fetchCzPartition({ ...context, fetch: fetchMock });
    expect(result.status).toBe("partial");
    expect(result.unavailableLocationIds).toEqual(["cz-opava"]);
    expect(result.checkedLocationIds).toContain("cz-ostrava");
  });

  it.each([
    { stationFails: true, bulletinFails: false },
    { stationFails: false, bulletinFails: true },
    { stationFails: true, bulletinFails: true },
    { stationFails: false, bulletinFails: false },
  ])("replaces only successful CHMI evidence: %j", async ({ stationFails, bulletinFails }) => {
    const stations = chmiMapping.mappings.flatMap(({ stations }) => stations);
    const failedStation = chmiMapping.mappings.find(({ locationId }) => locationId === "cz-brno")!.stations[0];
    const mockFetch = (initial: boolean): typeof fetch => (async (input) => {
      const url = String(input);
      if (url.includes("risk_FF_web.json")) return Response.json(initial ? chmiNonempty
        : bulletinFails ? {} : { datumVytvoreni: now.toISOString(), data: { report: {} } });
      const id = new URL(url).pathname.split("/").at(-1)!.replace(/\.json$/, "");
      const station = stations.find(({ objID }) => objID === id)!;
      if (!initial && stationFails && id === failedStation.objID) return Response.json({ objList: [] });
      return Response.json({ objList: [{ objID: id, tsList: [{ tsConID: station.kind, tsData: [{ dt: now.toISOString(), value: initial ? station.spa2 : station.spa1 - 1 }] }] }] });
    }) as typeof fetch;
    const wrap = (partition: Awaited<ReturnType<typeof fetchCzPartition>>) => PartitionedSourceResultSchema.parse({
      sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((code) => [code, code === "CZ"
        ? { ...partition, transports: { "chmi-hydrology": { ...partition, events: partition.events.map((event) => ({ ...event, transportId: "chmi-hydrology" })) } } }
        : { status: "disabled", events: [], sourceUpdatedAt: null, error: null, limitationCode: "not_supported" }])),
    });
    const initial = await fetchCzPartition({ ...context, fetch: mockFetch(true) });
    expect(initial.events.filter(({ id }) => id.startsWith("cz:bulletin:"))).toHaveLength(2);
    const state = mergeSourceResults(createEmptyState(now), [wrap(initial)], now);
    const result = await fetchCzPartition({ ...context, state, fetch: mockFetch(false) });
    expect(result.status).toBe(stationFails || bulletinFails ? "partial" : "ok");
    const expected = initial.events.filter(({ id }) => bulletinFails && id.startsWith("cz:bulletin:")
      || stationFails && id.startsWith(`cz:measurement:${failedStation.objID}:`)).map(({ id }) => id).sort();
    expect(mergeSourceResults(state, [wrap(result)], now).events.map(({ id }) => id).sort()).toEqual(expected);
  });
});

describe("bounded satellite targeting", () => {
  it("scans all EFFIS components and ranks by catalog proximity instead of row order", () => {
    const raster = new Uint8Array(100); raster[0] = 1; raster[88] = 1;
    const nearby = [{ ...locations.find(({ id }) => id === "gr-athens")!, centroid: [36.5, 30] as [number, number] }];
    expect(effisCandidatePixels(raster, 10, 10, nearby, 1).pixels).toEqual([[8, 8]]);
  });

  it("accepts only fresh, valid EFFIS perimeter geometry", () => {
    const geometry = { type: "Polygon", coordinates: [[[16, 48], [17, 48], [17, 49], [16, 49], [16, 48]]] };
    expect(parseEffisPerimeters({ features: [{ id: "fresh", geometry, properties: { lastupdate: now.toISOString() } }, { id: "old", geometry, properties: { lastupdate: "2026-08-28T00:00:00Z" } }] }, now).map(({ id }) => id)).toEqual(["fresh"]);
  });

  it("uses the destination geometry plus an exact 25 km perimeter buffer", () => {
    const destination = { ...locations.find(({ id }) => id === "at-vienna")!, centroid: [16, 48] as [number, number], geometry: { kind: "radius" as const, center: [16, 48] as [number, number], radiusKm: 1 } };
    const perimeter = (longitude: number) => ({ id: String(longitude), updatedAt: now.toISOString(), geometry: { type: "Polygon" as const, coordinates: [[[longitude, 47.999], [longitude + 0.001, 47.999], [longitude + 0.001, 48.001], [longitude, 48.001], [longitude, 47.999]]] } });
    expect(effisPerimeterNearLocation(perimeter(16.34), destination)).toBe(true);
    expect(effisPerimeterNearLocation(perimeter(16.37), destination)).toBe(false);
  });

  it("parses the official EFFIS WFS GML polygon contract deterministically", () => {
    const gml = `<wfs:FeatureCollection><gml:featureMember><ms:effis.nrt.ba.poly><ms:msGeometry><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">16 48 17 48 17 49 16 49 16 48</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></ms:msGeometry></ms:effis.nrt.ba.poly></gml:featureMember></wfs:FeatureCollection>`;
    const first = parseEffisPerimeterGml(gml, now);
    expect(first).toMatchObject([{ geometry: { type: "Polygon" }, updatedAt: now.toISOString() }]);
    expect(parseEffisPerimeterGml(gml, now)[0].id).toBe(first[0].id);
  });

  it("extracts GloFAS destination targets without creating an incident", () => {
    const raster = new Uint8Array(100); raster[55] = 3;
    const candidate = { ...locations[0], centroid: [5.5, 4.5] as [number, number] };
    expect(selectGlofasLocations(raster, 10, 10, [0, 0, 10, 10], [candidate]).map(({ id }) => id)).toEqual([candidate.id]);
    expect([...glofasRiskMask([new Uint8Array([255, 230]), new Uint8Array([255, 0]), new Uint8Array([255, 0])])]).toEqual([0, 1]);
    expect([...glofasRiskMask([new Uint8Array([255]), new Uint8Array([254]), new Uint8Array([0])])]).toEqual([1]);
    expect(() => glofasRiskMask([new Uint8Array([0]), new Uint8Array([0]), new Uint8Array([0])])).toThrow(/risk color/);
  });
});

describe("keyless fallback and news corroboration", () => {
  it("does not spend the GDELT budget again after an oversized combined response", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    try {
      const diagnostics = createSourceDiagnostics();
      const fetchMock = vi.fn(async () => new Response(" ".repeat(512 * 1024 + 1)));
      const result = await withFetchDiagnostics(diagnostics, () => new GdeltAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch }));
      expect(result.status).toBe("failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(diagnostics.responseBytes).toBeLessThanOrEqual(1024 * 1024);
    } finally { vi.unstubAllEnvs(); }
  });

  it("charges bytes from an interrupted GDELT body before reserving concurrent shard budgets", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    try {
      let calls = 0;
      const diagnostics = createSourceDiagnostics();
      const fetchMock = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          let sent = false;
          return new Response(new ReadableStream({ pull(controller) {
            if (!sent) { sent = true; controller.enqueue(new Uint8Array(400 * 1024)); }
            else controller.error(new Error("interrupted body"));
          } }));
        }
        return new Response(" ".repeat(400 * 1024), { headers: { "content-length": String(400 * 1024) } });
      });
      const result = await withFetchDiagnostics(diagnostics, () => new GdeltAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch }));
      expect(result.status).toBe("failed");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(diagnostics.responseBytes).toBe(400 * 1024);
    } finally { vi.unstubAllEnvs(); }
  });

  it("requires exact true before GDELT makes any request", async () => {
    const previous = process.env.GDELT_ENABLED;
    process.env.GDELT_ENABLED = "TRUE";
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    try {
      expect(await new GdeltAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch })).toMatchObject({ status: "disabled", events: [], candidates: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GDELT_ENABLED; else process.env.GDELT_ENABLED = previous;
    }
  });

  it("assigns an article matching multiple queries to one deterministic hazard bucket", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    try {
      const feature = { type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { url: "https://reuters.com/shared", title: "Protest after terror attack and shelling", description: "Security incident with an explosion", publishedAt: "2026-08-29T18:30:00Z" } };
      const fetchMock = vi.fn(async () => Response.json({ type: "FeatureCollection", features: [feature] }));
      const result = await new GdeltAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
      expect(result.candidates).toMatchObject([{ hazardType: "civil-unrest" }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("falls back to two fixed shards and reports one-shard recovery as partial", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    try {
      const feature = { type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { url: "https://reuters.com/shard", title: "Current shooting near station", description: "Security incident", publishedAt: "2026-08-29T18:30:00Z" } };
      const fetchMock = vi.fn(async () => {
        const request = fetchMock.mock.calls.length;
        if (request === 1 || request === 3) throw new Error("timeout");
        return Response.json({ type: "FeatureCollection", features: [feature] });
      });
      const result = await new GdeltAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ status: "partial", error: expect.stringMatching(/one fallback shard succeeded/) });
      expect(result.candidates).toMatchObject([{ hazardType: "security" }]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("fails fast after the combined request and both shards fail", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    try {
      const fetchMock = vi.fn(async () => { throw new Error("timeout"); });
      const result = await new GdeltAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ status: "failed", events: [], candidates: [] });
    } finally { vi.unstubAllEnvs(); }
  });

  it("discards reviewed articles that do not match the fixed hazard vocabulary", () => {
    const feature = { type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { url: "https://reuters.com/unclassified", title: "City council publishes an update", description: "Transit information", publishedAt: "2026-08-29T18:30:00Z" } };
    expect(parseGdeltGeo({ type: "FeatureCollection", features: [feature] }, now)).toEqual([]);
  });

  it("builds one IFRC request restricted to the failed country partitions", () => {
    const query = ifrcFallbackQuery(["AT", "CZ"]);
    expect(query).toContain('AT: alerts(filters: { sent: { gte: $since }, country: { pk: "11" } }');
    expect(query).toContain('CZ: alerts(filters: { sent: { gte: $since }, country: { pk: "53" } }');
    expect(query).not.toContain("DE: alerts");
    expect(query).toContain("msgType references country");
  });

  it("accepts only originating MeteoAlarm authority records from IFRC", () => {
    const info = { effective: "2026-08-29T18:00:00Z", expires: "2026-08-29T23:00:00Z", event: "Flood", severity: "MODERATE", areas: [{ areaDesc: "Austria", geocodes: [{ value: "AT:country" }] }] };
    const value = { data: { public: { AT: { items: [
      { sent: now.toISOString(), url: "https://meteoalarm.org/a", identifier: "a", scope: "Public", status: "ACTUAL", msgType: "ALERT", country: { iso3: "AUT" }, feed: { url: "https://feeds.meteoalarm.org/a", official: true }, infos: [info] },
      { sent: now.toISOString(), url: "https://example.com/b", identifier: "b", scope: "Public", status: "ACTUAL", msgType: "ALERT", country: { iso3: "AUT" }, feed: { url: "https://example.com/feed", official: true }, infos: [info] },
    ] } } } };
    expect(parseIfrcMeteoAlarm(value, ["AT"], now).get("AT")?.events).toHaveLength(1);
  });

  it("does not treat a missing or truncated IFRC country collection as healthy empty", () => {
    expect(() => parseIfrcMeteoAlarm({ data: { public: { AT: { items: [] } } } }, ["AT", "DE"], now)).toThrow(/no alert items/);
    expect(() => parseIfrcMeteoAlarm({ data: { public: { AT: { items: Array.from({ length: 25 }, () => ({})) } } } }, ["AT"], now)).toThrow(/record limit/);
    expect(parseIfrcMeteoAlarm({ data: { public: { AT: { items: [] } } } }, ["AT"], now).get("AT")?.events).toEqual([]);
  });

  it("preserves every IFRC CAP area and cancellation reference", () => {
    const alert = { sent: now.toISOString(), url: "https://meteoalarm.org/a", identifier: "a", scope: "Public", status: "ACTUAL", msgType: "ALERT", country: { iso3: "AUT" }, feed: { url: "https://feeds.meteoalarm.org/a", official: true }, infos: [{ effective: "2026-08-29T18:00:00Z", expires: "2026-08-29T23:00:00Z", event: "Flood", severity: "MODERATE", areas: [{ areaDesc: "Vienna", geocodes: [{ value: "AT13" }] }, { areaDesc: "Lower Austria", geocodes: [{ value: "AT12" }] }] }] };
    const active = parseIfrcMeteoAlarm({ data: { public: { AT: { items: [alert] } } } }, ["AT"], now).get("AT")!;
    expect(active.events).toHaveLength(2);
    expect(active.events.flatMap((event) => event.geometry.kind === "regions" ? event.geometry.codes : [])).toEqual(expect.arrayContaining(["AT13", "AT12"]));
    const cancelled = parseIfrcMeteoAlarm({ data: { public: { AT: { items: [{ ...alert, infos: [], identifier: "cancel-a", msgType: "CANCEL", references: "sender,a,2026-08-29T18:00:00Z" }] } } } }, ["AT"], now).get("AT")!;
    expect(cancelled).toMatchObject({ events: [], supersededIdentifiers: ["a"] });
  });

  it("requires three independent ownership groups and publishes no publisher text", () => {
    const feature = (domain: string, minute: number) => ({ type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { url: `https://${domain}/article`, title: `Current incident report ${domain}`, description: `Verified update ${domain}`, publishedAt: `2026-08-29T18:${String(minute).padStart(2, "0")}:00Z` } });
    const candidates = [feature("reuters.com", 0), feature("apnews.com", 10), feature("bbc.com", 20)].flatMap((item) => parseGdeltGeo({ features: [item] }, "security", now));
    expect(corroboratedGdeltEvents(candidates, context)).toHaveLength(3);
    expect(corroboratedGdeltEvents(candidates.slice(0, 2), context)).toEqual([]);
    expect(JSON.stringify(corroboratedGdeltEvents(candidates, context))).not.toContain("Current incident report");
  });

  it("retains distinct publisher evidence after three parent groups corroborate", () => {
    const feature = (domain: string, minute: number) => ({ type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { url: `https://${domain}/article`, title: `Independent report ${domain}`, description: `Distinct account ${domain}`, publishedAt: `2026-08-29T18:${String(minute).padStart(2, "0")}:00Z` } });
    const candidates = [feature("bbc.com", 0), feature("bbc.co.uk", 5), feature("reuters.com", 10), feature("apnews.com", 15)]
      .flatMap((item) => parseGdeltGeo({ features: [item] }, "security", now));
    expect(corroboratedGdeltEvents(candidates, context).map(({ sourceName }) => sourceName)).toEqual([
      "Associated Press", "BBC", "BBC", "Reuters",
    ]);
  });

  it("caps GDELT output only between complete corroborated incidents", () => {
    const feature = (domain: string, minute: number) => ({ type: "Feature", geometry: { type: "Point", coordinates: locations[0].centroid }, properties: { url: `https://${domain}/cap`, title: `Independent cap report ${domain}`, description: `Distinct cap account ${domain}`, publishedAt: `2026-08-29T18:${String(minute).padStart(2, "0")}:00Z` } });
    const candidates = [feature("reuters.com", 0), feature("apnews.com", 10), feature("bbc.com", 20)].flatMap((item) => parseGdeltGeo({ features: [item] }, "security", now));
    const catalog = Array.from({ length: 67 }, (_, index) => ({ ...locations[0], id: `at-cap-${index}` }));
    const events = corroboratedGdeltEvents(candidates, { ...context, locations: catalog });
    const counts = Object.values(events.reduce<Record<string, number>>((result, item) => {
      const id = item.geometry.kind === "locations" ? item.geometry.ids[0] : "";
      result[id] = (result[id] || 0) + 1;
      return result;
    }, {}));
    expect(events).toHaveLength(198);
    expect(new Set(counts)).toEqual(new Set([3]));
  });

  it("rejects undated PointData links on every refresh instead of inventing publication times", () => {
    const features = ["reuters.com", "apnews.com", "bbc.com"].map((domain) => ({ type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { html: `<a href="https://${domain}/live?utm_source=gdelt">Shooting incident report from ${domain}</a>` } }));
    for (const at of [now, new Date(now.getTime() + 24 * 60 * 60_000)]) {
      const candidates = parseGdeltGeo({ features }, at);
      expect(candidates).toEqual([]);
      expect(corroboratedGdeltEvents(candidates, { ...context, now: at })).toEqual([]);
    }
  });

  it("keeps genuine article publication and expiry times fixed across refreshes", () => {
    const features = ["reuters.com", "apnews.com", "bbc.com"].map((domain) => ({ type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: {
      url: `https://${domain}/live?utm_source=gdelt`, title: `Shooting incident report from ${domain}`, publishedAt: "2026-08-29T18:30:00Z",
    } }));
    const candidates = parseGdeltGeo({ features }, now);
    expect(candidates).toHaveLength(3);
    expect(candidates.every(({ canonicalUrl, publishedAt, expiresAt }) => canonicalUrl && !canonicalUrl.includes("utm_source")
      && publishedAt === "2026-08-29T18:30:00.000Z" && expiresAt === "2026-08-30T00:30:00.000Z")).toBe(true);
    expect(corroboratedGdeltEvents(candidates, context)).toHaveLength(3);
    expect(parseGdeltGeo({ features }, new Date(now.getTime() + 60 * 60_000))).toEqual(candidates);
    expect(parseGdeltGeo({ features }, new Date(now.getTime() + 24 * 60 * 60_000))).toEqual([]);
  });

  it("rejects same-parent and syndication duplicates", () => {
    const candidate = (externalId: string, group: string, fingerprint: string): DiscoveryCandidate => ({ providerId: "gdelt", externalId, hazardType: "security", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, startsAt: "2026-08-29T18:00:00Z", endsAt: "2026-08-30T00:00:00Z", sourceUpdatedAt: "2026-08-29T18:00:00Z", officialUrl: `https://bbc.com/${externalId}`, expiresAt: "2026-08-30T00:00:00Z", publisherDomain: "bbc.com", ownershipGroup: group, contentFingerprint: fingerprint.repeat(64).slice(0, 64), publishedAt: "2026-08-29T18:00:00Z", canonicalUrl: `https://bbc.com/${externalId}` });
    expect(corroboratedGdeltEvents([candidate("a", "BBC", "a"), candidate("b", "BBC", "b"), candidate("c", "BBC", "c")], context)).toEqual([]);
    expect(corroboratedGdeltEvents([candidate("a", "BBC", "a"), candidate("b", "AP", "a"), candidate("c", "Reuters", "a")], context)).toEqual([]);
  });

  it("ignores retained candidates whose publisher is no longer reviewed", () => {
    const feature = (domain: string, minute: number) => ({ type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] }, properties: { url: `https://${domain}/retained`, title: `Retained report ${domain}`, description: `Distinct retained account ${domain}`, publishedAt: `2026-08-29T18:${String(minute).padStart(2, "0")}:00Z` } });
    const current = [feature("reuters.com", 0), feature("apnews.com", 10)].flatMap((item) => parseGdeltGeo({ features: [item] }, "security", now));
    const removed = { ...current[0], externalId: "removed", publisherDomain: "removed.example", ownershipGroup: "Former Publisher", canonicalUrl: "https://removed.example/retained", officialUrl: "https://removed.example/retained" };
    expect(corroboratedGdeltEvents([...current, removed], context)).toEqual([]);
  });

  it("requires reports to be mutually close in both distance and publication time", () => {
    const feature = (domain: string, coordinates: [number, number], publishedAt: string) => ({ type: "Feature", geometry: { type: "Point", coordinates }, properties: { url: `https://${domain}/incident`, title: `Independent live report ${domain}`, description: `Distinct account ${domain}`, publishedAt } });
    const spatial = [
      feature("reuters.com", [16.1738, 48.2082], "2026-08-29T18:00:00Z"),
      feature("apnews.com", [16.3738, 48.2082], "2026-08-29T18:10:00Z"),
      feature("bbc.com", [16.5738, 48.2082], "2026-08-29T18:20:00Z"),
    ].flatMap((item) => parseGdeltGeo({ features: [item] }, "security", now));
    const temporal = [
      feature("reuters.com", [16.3738, 48.2082], "2026-08-29T16:01:00Z"),
      feature("apnews.com", [16.3738, 48.2082], "2026-08-29T18:00:00Z"),
      feature("bbc.com", [16.3738, 48.2082], "2026-08-29T19:59:00Z"),
    ].flatMap((item) => parseGdeltGeo({ features: [item] }, "security", now));
    expect(corroboratedGdeltEvents(spatial, context)).toEqual([]);
    expect(corroboratedGdeltEvents(temporal, context)).toEqual([]);
  });

  it("excludes historical, planned, resolved, and denied reports before persistence", () => {
    const features = ["Historical incident", "Planned protest", "Incident resolved", "Police denied report"].map((title, index) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [16.3738, 48.2082] },
      properties: { url: `https://bbc.com/${index}`, title, description: "Current coverage", publishedAt: "2026-08-29T18:00:00Z" },
    }));
    expect(parseGdeltGeo({ features }, "security", now)).toEqual([]);
  });
});
