import { describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { fetchItPartition, italianFloodBulletin } from "@/lib/ingestion/adapters/national-civil-alerts-it";
import { NationalCivilAlertsAdapter, parseNationalAlertsDisabledCountries } from "@/lib/ingestion/adapters/national-civil-alerts";
import { fetchNationalWeatherFallback, parseFmiCap, parseIpmaWarnings, parseMetEireannWarnings, irishWarningCounties } from "@/lib/ingestion/adapters/national-weather-fallback";
import { MeteoAlarmAdapter } from "@/lib/ingestion/adapters/meteoalarm";
import { NationalWarningSourcesSchema, nationalWarningManifest } from "@/lib/national-warning-sources";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";
import ipmaWarnings from "../fixtures/providers/ipma-warnings.json";

const now = new Date("2026-08-30T10:00:00.000Z");
const context = { now, locations, fetch };

describe("aggressive national alert integrations", () => {
  it("records a current, explicit outcome for every reviewed country without promoting gated transports", () => {
    expect(Object.keys(nationalWarningManifest.countries)).toHaveLength(28);
    for (const country of Object.values(nationalWarningManifest.countries)) for (const system of country.systems) {
      expect(Date.parse(system.nextReviewAt)).toBeGreaterThan(Date.parse(system.reviewedAt));
      expect(system.evidenceUrls.length).toBeGreaterThan(0);
      if (system.coverageContribution !== "none") {
        expect(system).toMatchObject({ status: "active", role: "coverage", runtimeTarget: "national-civil-alerts" });
      }
      if (system.status !== "active") expect(system).toMatchObject({ limitationCode: expect.any(String), blocker: expect.any(String) });
    }
  });

  it("rejects incomplete manifests and active systems without runtime or completeness readiness", () => {
    const incomplete = structuredClone(nationalWarningManifest) as unknown as { countries: Record<string, unknown> };
    delete incomplete.countries.IE;
    expect(() => NationalWarningSourcesSchema.parse(incomplete)).toThrow();

    const noRuntime = structuredClone(nationalWarningManifest) as unknown as { countries: Record<string, { systems: Array<Record<string, unknown>> }> };
    noRuntime.countries.AT.systems[0].runtimeTarget = "none";
    expect(() => NationalWarningSourcesSchema.parse(noRuntime)).toThrow(/runtime target/i);

    const incompleteCoverage = structuredClone(nationalWarningManifest) as unknown as { countries: Record<string, { systems: Array<Record<string, unknown>> }> };
    incompleteCoverage.countries.IT.systems[1].completenessStatus = "credential_required";
    expect(() => NationalWarningSourcesSchema.parse(incompleteCoverage)).toThrow(/completeness decision/i);
  });

  it("validates the runtime country denylist strictly", () => {
    expect([...parseNationalAlertsDisabledCountries("PL,IT")]).toEqual(["PL", "IT"]);
    expect(() => parseNationalAlertsDisabledCountries("pl")).toThrow(/uppercase ISO/);
    expect(() => parseNationalAlertsDisabledCountries("PL,PL")).toThrow(/duplicates/);
    expect(() => parseNationalAlertsDisabledCountries("US")).toThrow(/reviewed/);
  });

  it("makes zero requests when every approved national partition is denylisted", async () => {
    const previous = process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES;
    process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES = "AT,CZ,DE,ES,FR,IT,LU,LV,PL,SE";
    const fetchMock = vi.fn(async () => new Response("unexpected"));
    try {
      const result = await new NationalCivilAlertsAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.partitions.IT).toMatchObject({ status: "disabled", limitationCode: "runtime_country_disabled" });
    } finally {
      if (previous === undefined) delete process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES;
      else process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES = previous;
    }
  });

  it("aborts an individual national transport after eight seconds", async () => {
    vi.useFakeTimers();
    const previous = process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES;
    process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES = "CZ,DE,ES,FR,IT,LU,LV,PL,SE";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    try {
      const request = new NationalCivilAlertsAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(request).resolves.toMatchObject({ partitions: { AT: { status: "failed" } } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES;
      else process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES = previous;
    }
  });

  it("parses exact Italian zones, maps red to severe, and treats a complete green bulletin as healthy empty", () => {
    const zone = (name: string, risk: string) => ({ properties: {
      "Nome zona": name, "Rappresentata nella mappa": risk, "Per rischio idraulico": risk,
      "Per rischio temporali": risk, "Per rischio idrogeologico": risk,
    } });
    const green = "Assenza di fenomeni significativi prevedibili / NESSUNA ALLERTA";
    const geometries = [zone("Aniene", "ALLERTA ROSSA"), zone("Bacini di Roma", green),
      ...Array.from({ length: 148 }, (_, index) => zone(`Fixture zone ${index}`, green))];
    const parsed = italianFloodBulletin({ type: "Topology", objects: { warning: { geometries } } }, context);
    expect(parsed.status).toBe("partial");
    expect(parsed.events.find(({ geometry }) => geometry.kind === "locations" && geometry.ids.includes("it-rome")))
      .toMatchObject({ type: "flood", level: "SEVERE" });
    const empty = italianFloodBulletin({ type: "Topology", objects: { warning: { geometries: geometries.map(({ properties }) => zone(String(properties["Nome zona"]), green)) } } }, context);
    expect(empty.events).toEqual([]);
    expect(() => italianFloodBulletin({ type: "Topology", objects: { warning: { geometries: geometries.map(({ properties }) => zone(String(properties["Nome zona"]), "BLUE")) } } }, context)).toThrow(/undocumented/);
  });

  it("constructs one fixed allowlisted GitHub content request", async () => {
    const sha = "a".repeat(40);
    const rawUrl = `https://github.com/pcm-dpc/repo/raw/${sha}/files%2Ftopojson%2F20260830_1000_tomorrow.json`;
    const contentUrl = `https://raw.githubusercontent.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica/${sha}/files/topojson/20260830_1000_tomorrow.json`;
    const green = "Assenza di fenomeni significativi prevedibili / NESSUNA ALLERTA";
    const fixture = { type: "Topology", objects: { warning: { geometries: Array.from({ length: 150 }, (_, index) => ({ properties: {
      "Nome zona": index === 0 ? "Aniene" : index === 1 ? "Bacini di Roma" : `Fixture zone ${index}`,
      "Rappresentata nella mappa": index === 0 ? "ALLERTA ROSSA" : green, "Per rischio idraulico": green,
      "Per rischio temporali": green, "Per rischio idrogeologico": green,
    } })) } } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("commits?path=files/topojson&per_page=1")) return Response.json([{ sha, commit: { committer: { date: now.toISOString() } } }]);
      if (url.endsWith(`/commits/${sha}`)) return Response.json({ files: [{ filename: "files/topojson/20260830_1000_tomorrow.json", status: "modified", raw_url: rawUrl }] });
      if (url === contentUrl) return Response.json(fixture);
      throw new Error(`Unexpected URL: ${url}`);
    });
    const partition = await fetchItPartition({ ...context, fetch: fetchMock as typeof fetch });
    expect(partition.events.find(({ geometry }) => geometry.kind === "locations" && geometry.ids.includes("it-rome")))
      .toMatchObject({ timing: "UPCOMING", startsAt: "2026-08-30T22:00:00.000Z", endsAt: "2026-08-31T22:00:00.000Z" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(contentUrl);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("normalizes official FMI codes and recovers a mixed warning/advisory feed", async () => {
    const xml = `<alert><identifier>fmi-1</identifier><sent>2026-08-30T09:55:00Z</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en-GB</language><category>Met</category><eventCode><valueName>profile:cap:https://alerts.fmi.fi/cap/profile/v1.1.0</valueName><value>rain</value></eventCode><onset>2026-08-30T09:00:00Z</onset><expires>2026-08-30T18:00:00Z</expires><severity>Moderate</severity><area><areaDesc>Helsinki</areaDesc><polygon>59.9,24.7 59.9,25.2 60.4,25.2 60.4,24.7 59.9,24.7</polygon></area></info></alert>`;
    const result = parseFmiCap(xml, context, "https://alerts.fmi.fi/cap/example.xml");
    expect(result.events.find(({ geometry }) => geometry.kind === "locations" && geometry.ids.includes("fi-helsinki")))
      .toMatchObject({ sourceName: "Finnish Meteorological Institute", level: "ELEVATED" });
    expect(result.events.map(({ headline }) => headline).join(" ")).not.toMatch(/FMI|publisher/i);
    for (const [code, type] of Object.entries({ hotWeather: "extreme-heat", coldWeather: "extreme-cold", forestFireWeather: "fire-danger", trafficWeather: "snow-ice", pedestrianSafety: "snow-ice", seaWaterHeight: "coastal", seaWaveHeight: "coastal", seaWind: "coastal", seaThunderstorm: "coastal", seaIcing: "coastal", wind: "severe-weather", thunderstorm: "severe-weather" })) {
      expect(parseFmiCap(xml.replace("<value>rain</value>", `<value>${code}</value>`), context, "https://alerts.fmi.fi/cap/example.xml").events[0]?.type).toBe(type);
    }
    for (const code of ["uvNote", "unknownFutureCode"]) {
      expect(parseFmiCap(xml.replace("<value>rain</value>", `<value>${code}</value>`), context, "https://alerts.fmi.fi/cap/example.xml").events).toEqual([]);
    }
    expect(() => parseFmiCap(xml.replace("profile/v1.1.0", "profile/v2.0.0"), context, "https://alerts.fmi.fi/cap/example.xml")).toThrow(/profile event code/);
    expect(parseFmiCap(xml.replace("Moderate", "Minor"), context, "https://alerts.fmi.fi/cap/example.xml").events).toEqual([]);
    expect(() => parseFmiCap(xml.replace("Moderate", "Unknown"), context, "https://alerts.fmi.fi/cap/example.xml")).toThrow(/severity/);
    const recovered = await fetchNationalWeatherFallback("FI", { ...context, fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith("/hot.xml")) return new Response(xml.replace("<value>rain</value>", "<value>hotWeather</value>"));
      if (url.endsWith("/uv.xml")) return new Response(xml.replace("<value>rain</value>", "<value>uvNote</value>"));
      return new Response('<rss><channel><item><link>https://alerts.fmi.fi/cap/hot.xml</link></item><item><link>https://alerts.fmi.fi/cap/uv.xml</link></item></channel></rss>');
    }) as typeof fetch });
    expect(recovered?.events[0]).toMatchObject({ type: "extreme-heat", sourceName: "Finnish Meteorological Institute", sourceUrl: "https://alerts.fmi.fi/cap/hot.xml" });
    expect(recovered?.removedEventPrefixes).toContain("meteoalarm:fmi:");
  });

  it("distinguishes an empty FMI index from malformed or excessive CAP links", async () => {
    const fallback = (xml: string) => fetchNationalWeatherFallback("FI", {
      ...context, fetch: (async () => new Response(xml)) as typeof fetch,
    });
    await expect(fallback("<rss><channel><title>Warnings</title></channel></rss>")).resolves.toMatchObject({ events: [], removedEventPrefixes: ["meteoalarm:fmi:"] });
    await expect(fallback("<rss><channel><item><link>https://example.com/warning.xml</link></item></channel></rss>"))
      .rejects.toThrow(/unsupported/);
    await expect(fallback(`<rss><channel>${Array.from({ length: 17 }, (_, index) => `<item><link>https://alerts.fmi.fi/cap/${index}.xml</link></item>`).join("")}</channel></rss>`))
      .rejects.toThrow(/excessive/);
  });

  it("uses exact Irish counties and rejects agricultural advisories without modifying official copy", () => {
    const warning = {
      capId: "ie-1", severity: "Severe", updated: "2026-08-30T09:55:00Z", onset: "2026-08-30T09:00:00Z",
      expiry: "2026-08-30T18:00:00Z", status: "Warning", headline: "Weather warning for Ireland",
      regions: Object.keys(irishWarningCounties), type: "Rain", description: "Heavy showers will affect all areas overnight and tomorrow. Expect local flooding",
    };
    expect(parseMetEireannWarnings([warning], context).events[0]).toMatchObject({
      id: expect.stringMatching(/^meteoalarm:met-eireann:/), sourceName: "Met Eireann", level: "HIGH",
      geometry: { kind: "locations", ids: expect.arrayContaining(["ie-dublin", "ie-cork"]) },
    });
    expect(parseMetEireannWarnings([{ ...warning, regions: ["EI01"] }], context).events).toEqual([]);
    expect(parseMetEireannWarnings([{ ...warning, regions: ["EI04"] }], context).events[0].geometry).toEqual({ kind: "locations", ids: ["ie-cork"] });
    expect(parseMetEireannWarnings([{ ...warning, type: "yellow; Moderate", headline: "Blight warning for Ireland" }], context).events).toEqual([]);
    expect(parseMetEireannWarnings([warning], context).events[0]).toMatchObject({ headline: warning.headline, explanation: warning.description });
    expect(parseMetEireannWarnings([], context).removedEventPrefixes).toEqual(["meteoalarm:met-eireann:"]);
    expect(parseMetEireannWarnings([{ ...warning, onset: "2026-08-28T09:00:00Z", expiry: "2026-08-29T18:00:00Z" }], context).events).toEqual([]);
    expect(parseMetEireannWarnings([warning], context).sourceUpdatedAt).toBe("2026-08-30T09:55:00.000Z");
    expect(() => parseMetEireannWarnings([{ ...warning, updated: "2026-08-30T10:06:00Z" }], context)).toThrow(/parseable/);
  });

  it("maps current non-green IPMA warnings to exact areas and replaces the fallback list", async () => {
    const rows = structuredClone(ipmaWarnings);
    const parsed = parseIpmaWarnings(rows, context, "2026-08-30T09:55:00Z");
    expect(parsed).toMatchObject({ removedEventPrefixes: ["meteoalarm:ipma:"], transportId: "ipma-warnings-json" });
    expect(parsed.events).toEqual([expect.objectContaining({ level: "ELEVATED", type: "severe-weather", sourceName: "IPMA",
      geometry: { kind: "locations", ids: ["pt-ponta-delgada"] } })]);
    expect(JSON.stringify(parsed.events)).not.toContain("Removed from normalized output");
    expect(() => parseIpmaWarnings([{ ...rows[0], awarenessTypeName: "Undocumented" }], context, "2026-08-30T09:55:00Z")).toThrow(/Unsupported non-green/);
    expect(() => parseIpmaWarnings(rows, context, "2026-08-28T09:55:00Z")).toThrow(/stale/);

    const response = new Response(JSON.stringify(rows), { headers: { "Last-Modified": "Sun, 30 Aug 2026 09:55:00 GMT" } });
    await expect(fetchNationalWeatherFallback("PT", { ...context, fetch: (async () => response) as typeof fetch }))
      .resolves.toMatchObject({ transportId: "ipma-warnings-json", events: [expect.objectContaining({ sourceUpdatedAt: "2026-08-30T09:55:00.000Z" })] });
  });

  it("does not attribute primary MeteoAlarm freshness to an unused fallback", () => {
    const state = createEmptyState(now);
    state.sourcePartitions.meteoalarm.IE = {
      status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: "2026-08-30T09:55:00.000Z",
      nextExpectedUpdate: "2026-08-30T10:10:00.000Z", itemCount: 0, consecutiveFailures: 0, error: null,
    };
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.providers.meteoalarm.partitions?.IE.transports?.find(({ id }) => id === "met-eireann-json"))
      .toMatchObject({ status: "ok", sourceUpdatedAt: null });
  });

  it("calls Ireland fallback only after the matching MeteoAlarm partition fails", async () => {
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-30T09:55:00Z</updated></feed>`;
    const warning = [{ capId: "ie-1", severity: "Moderate", updated: "2026-08-30T09:55:00Z", onset: "2026-08-30T09:00:00Z",
      expiry: "2026-08-30T18:00:00Z", status: "Warning", headline: "Warning for Ireland",
      regions: Object.keys(irishWarningCounties), type: "Rain", description: "Heavy showers will affect all areas." }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("warning_IRELAND")
      ? new Response(JSON.stringify(warning))
      : String(input).endsWith("-ireland") ? new Response("<invalid/>") : new Response(empty));
    const result = await new MeteoAlarmAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
    expect(result.partitions.IE).toMatchObject({ status: "partial", limitationCode: "national_authority_fallback", transports: { "met-eireann-json": { status: "ok" } } });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("warning_IRELAND"))).toHaveLength(1);

    const healthyFetch = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(empty); });
    await new MeteoAlarmAdapter().fetch({ ...context, fetch: healthyFetch as typeof fetch });
    expect(healthyFetch.mock.calls.some(([url]) => String(url).includes("warning_IRELAND"))).toBe(false);
  });

  it("calls IPMA only after Portugal's primary partition fails and keeps recovery partial", async () => {
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-30T09:55:00Z</updated></feed>`;
    const rows = [{ idAreaAviso: "MCS", awarenessLevelID: "orange", awarenessTypeName: "Vento",
      startTime: "2026-08-30T09:00:00", endTime: "2026-08-30T18:00:00" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("warnings_www.json")
      ? new Response(JSON.stringify(rows), { headers: { "Last-Modified": "Sun, 30 Aug 2026 09:55:00 GMT" } })
      : String(input).endsWith("-portugal") ? new Response("<invalid/>") : new Response(empty));
    const result = await new MeteoAlarmAdapter().fetch({ ...context, fetch: fetchMock as typeof fetch });
    expect(result.partitions.PT).toMatchObject({ status: "partial", limitationCode: "national_authority_fallback",
      transports: { "ipma-warnings-json": { status: "ok" } } });
    expect(result.partitions.PT.events[0]).toMatchObject({ level: "HIGH", geometry: { kind: "locations", ids: ["pt-funchal", "pt-madeira"] } });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("warnings_www.json"))).toHaveLength(1);

    const healthyFetch = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(empty); });
    await new MeteoAlarmAdapter().fetch({ ...context, fetch: healthyFetch as typeof fetch });
    expect(healthyFetch.mock.calls.some(([url]) => String(url).includes("warnings_www.json"))).toBe(false);
  });

  it("clears only retained Met Eireann fallback evidence after a healthy-empty recovery", async () => {
    const emptyAtom = `<?xml version="1.0"?><feed><updated>2026-08-30T09:55:00Z</updated></feed>`;
    const warning = { capId: "old-ie", severity: "Moderate", updated: "2026-08-30T09:55:00Z", onset: "2026-08-30T09:00:00Z",
      expiry: "2026-08-30T18:00:00Z", status: "Warning", headline: "Warning for Ireland",
      regions: Object.keys(irishWarningCounties), type: "Rain", description: "Heavy showers will affect all areas." };
    const state = createEmptyState(now);
    state.events = [parseMetEireannWarnings([warning], context).events[0], {
      ...parseMetEireannWarnings([warning], context).events[0], id: "meteoalarm:primary-record:ireland", transportId: "meteoalarm-primary",
    }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("warning_IRELAND")
      ? Response.json([]) : String(input).endsWith("-ireland") ? new Response("<invalid/>") : new Response(emptyAtom));
    const result = await new MeteoAlarmAdapter().fetch({ ...context, state, fetch: fetchMock as typeof fetch });
    const merged = mergeSourceResults(state, [result], now);
    expect(merged.events.some(({ id }) => id.startsWith("meteoalarm:met-eireann:"))).toBe(false);
    expect(merged.events.map(({ id }) => id)).toContain("meteoalarm:primary-record:ireland");
  });
});
