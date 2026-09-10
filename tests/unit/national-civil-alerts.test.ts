import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { countryCodes, PartitionedSourceResultSchema, type NormalizedEvent, type PartitionedSourceResult } from "@/lib/domain/schemas";
import { atAlertPartition } from "@/lib/ingestion/adapters/national-civil-alerts-at";
import { fetchFrPartition, parseFrArchive, parseFrExports } from "@/lib/ingestion/adapters/national-civil-alerts-fr";
import { withFrAlertTlsFallback } from "@/lib/ingestion/adapters/fr-alert-fetch";
import { fetchLuPartition, parseLuCap } from "@/lib/ingestion/adapters/national-civil-alerts-lu";
import { capPolygon, capSeverity, structuredHazard } from "@/lib/ingestion/adapters/national-civil-alerts-shared";
import { lhpPartition } from "@/lib/ingestion/adapters/national-civil-alerts-de";
import { cataloniaLocationIds, cataloniaPartition } from "@/lib/ingestion/adapters/national-civil-alerts-es";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";
import { nationalWarningSources } from "@/lib/national-warning-sources";
import coverageJson from "../../data/coverage.json";
import bootstrapJson from "../../data/lu-alert-bootstrap.json";

const now = new Date("2026-08-28T04:30:00.000Z");
const context = { now, locations, fetch };
let archive = "";
let frExport: unknown;
let luCap = "";

beforeAll(async () => {
  [archive, frExport, luCap] = await Promise.all([
    readFile("tests/fixtures/providers/fr-alert-archive.html", "utf8"),
    readFile("tests/fixtures/providers/fr-alert-export.json", "utf8").then(JSON.parse),
    readFile("tests/fixtures/providers/lu-alert-cap.xml", "utf8"),
  ]);
});

describe("national civil alert country partitions", () => {
  it("maps LHP CAP severity, fallback classes, cancellation, and mixed reference geometry", () => {
    const berlin = locations.find(({ id }) => id === "de-berlin")!;
    const [longitude, latitude] = berlin.centroid;
    const polygon = { type: "Polygon", coordinates: [[
      [longitude - 0.2, latitude - 0.2], [longitude + 0.2, latitude - 0.2],
      [longitude + 0.2, latitude + 0.2], [longitude - 0.2, latitude + 0.2],
      [longitude - 0.2, latitude - 0.2],
    ]] };
    const response = (properties: Record<string, unknown>) => ({
      updated: now.toISOString(), features: [
        { id: "river-reference", geometry: { type: "LineString", coordinates: [[longitude, latitude], [longitude + 0.1, latitude]] }, properties: { lhpClass: 4 } },
        { id: "warning", geometry: polygon, properties: { areaDesc: "Berlin", alertHeadline: "Flood warning", ...properties } },
        { id: "cancelled", geometry: polygon, properties: { severity: "Extreme", msgType: "Cancel" } },
        { id: "expired", geometry: polygon, properties: { severity: "Extreme", expires: "2026-08-28T03:00:00Z" } },
      ],
    });
    expect(lhpPartition(response({ severity: "Moderate" }), context)).toMatchObject({ status: "ok", events: [{ level: "ELEVATED" }] });
    expect(lhpPartition(response({ severity: "Severe" }), context).events[0].level).toBe("HIGH");
    expect(lhpPartition(response({ lhpClass: 6 }), context).events[0].level).toBe("SEVERE");
    expect(lhpPartition({ updated: now.toISOString(), features: [] }, context)).toMatchObject({ status: "ok", events: [], error: null });
    expect(lhpPartition(response({ severity: "Bogus" }), context)).toMatchObject({
      status: "partial", removedEventPrefixes: ["lhp:cancelled", "lhp:expired"], unavailableLocationIds: expect.arrayContaining(["de-berlin"]),
    });
  });

  it("clears explicit LHP cancellations and all-clears without losing unrelated retained warnings", () => {
    const [lon, lat] = locations.find(({ id }) => id === "de-berlin")!.centroid;
    const geometry = { type: "Polygon", coordinates: [[[lon - 0.2, lat - 0.2], [lon + 0.2, lat - 0.2], [lon + 0.2, lat + 0.2], [lon - 0.2, lat + 0.2], [lon - 0.2, lat - 0.2]]] };
    const feature = (id: string, properties: Record<string, unknown>) => ({ id, geometry, properties });
    const previous = lhpPartition({ updated: now.toISOString(), features: [feature("cancelled", { severity: "Severe" })] }, context).events[0];
    const partition = lhpPartition({ updated: now.toISOString(), features: [
      feature("cancelled", { msgType: "Cancel" }), feature("clear", { lhpClass: 1 }),
      feature("expired", { severity: "Severe", expires: "2026-08-28T03:00:00Z" }),
      feature("malformed", { severity: "Bogus" }),
    ] }, context);
    const state = createEmptyState(now);
    state.events = ["cancelled", "clear", "expired", "retained", "cancelled-extra"].map((id) => ({ ...previous, id: `lhp:${id}` }));
    const result: PartitionedSourceResult = {
      sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((code) => [code, code === "DE" ? partition : { status: "disabled", sourceUpdatedAt: null, events: [], error: null }])) as PartitionedSourceResult["partitions"],
    };
    expect(partition.status).toBe("partial");
    expect(mergeSourceResults(state, [result], now).events.map(({ id }) => id)).toEqual(["lhp:retained", "lhp:cancelled-extra"]);
  });

  it("keeps Catalonia plan activations context-only and scoped to five destinations", () => {
    const activated = cataloniaPartition([
      { plaacronim: "INUNCAT", planom: "Flood plan", plafase: "ALERTA", fasedatahora: "2026-08-28T04:00:00Z" },
      { plaacronim: "VENTCAT", planom: "Wind plan", plafase: "PREALERTA", fasedatahora: "2026-08-28T04:00:00Z" },
    ], context);
    expect(activated).toMatchObject({ status: "ok", events: [{ level: "ELEVATED", type: "civil-emergency" }] });
    expect(activated.events[0].geometry).toEqual({ kind: "locations", ids: [...cataloniaLocationIds].sort() });
    expect(activated.events[0].explanation).toMatch(/context only/i);
    expect(cataloniaPartition([], context)).toMatchObject({ status: "ok", events: [], error: null, checkedLocationIds: expect.arrayContaining([...cataloniaLocationIds]) });
    expect(cataloniaPartition([{ plaacronim: "INUNCAT", plafase: "ALERTA", fasedatahora: "invalid" }], context))
      .toMatchObject({ status: "partial", removedEventPrefixes: [], unavailableLocationIds: expect.arrayContaining([...cataloniaLocationIds]) });
  });

  it("clears a timestamped Catalonia pre-alert during a partial refresh", () => {
    const plan = { plaacronim: "INUNCAT", plafase: "ALERTA", fasedatahora: now.toISOString() };
    const previous = cataloniaPartition([plan], context).events[0];
    const partition = cataloniaPartition([
      { ...plan, plafase: "PREALERTA" },
      { ...plan, plaacronim: "malformed", fasedatahora: "invalid" },
      { ...plan, plaacronim: "future", plafase: "PREALERTA", fasedatahora: "2099-01-01T00:00:00Z" },
    ], context);
    const state = createEmptyState(now);
    state.events = [previous, { ...previous, id: "catalonia-plan:retained" }];
    const result: PartitionedSourceResult = {
      sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((code) => [code, code === "ES" ? partition : { status: "disabled", sourceUpdatedAt: null, events: [], error: null }])) as PartitionedSourceResult["partitions"],
    };
    expect(partition).toMatchObject({ status: "partial", removedEventPrefixes: ["catalonia-plan:INUNCAT"] });
    expect(mergeSourceResults(state, [result], now).events.map(({ id }) => id)).toEqual(["catalonia-plan:retained"]);
  });

  it.each([
    ["31/08/2026 17:16", "2026-08-31T15:16:00.000Z"],
    ["15/01/2026 17:16", "2026-01-15T16:16:00.000Z"],
  ])("parses official Catalonia civil time and structured document links (%s)", (timestamp, expected) => {
    const current = { ...context, now: new Date(expected) };
    const plan = { plaacronim: "CAMCAT", plafase: "ALERTA", fasedatahora: timestamp, comunicatpdf: { url: "https://documents.dadesobertes.gencat.cat/cecat/docs/current.pdf" } };
    expect(cataloniaPartition([plan], current)).toMatchObject({ status: "ok", events: [{ sourceUpdatedAt: expected, sourceUrl: plan.comunicatpdf.url }] });
    expect(cataloniaPartition([{ ...plan, plafase: "PREALERTA", plaactivat: "NO" }], current)).toMatchObject({ status: "ok", events: [], removedEventPrefixes: ["catalonia-plan:"] });
  });

  it.each(["31/02/2026 17:16", "29/03/2026 02:30", "25/10/2026 02:30", "31/08/2099 17:16"])("fails closed on impossible, ambiguous or future Catalonia civil time (%s)", (timestamp) => {
    // Keep the DST cases in the past so the future-date guard cannot mask a
    // parser that incorrectly accepts an ambiguous or nonexistent civil time.
    expect(cataloniaPartition([{ plaacronim: "CAMCAT", plafase: "ALERTA", fasedatahora: timestamp }], { ...context, now: new Date("2026-11-01T12:00:00Z") }))
      .toMatchObject({ status: "partial", events: [] });
  });

  it("selects only current production FR identifiers and normalizes CAP coordinates", () => {
    expect(parseFrArchive(archive, now)).toEqual({ identifiers: ["FR-ALERT.20260828.1"], overflow: false });
    const parsed = parseFrExports(frExport, context);
    expect(parsed.invalid).toBe(0);
    expect(parsed.events.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("fr-paris"))).toBe(true);
    expect(parsed.events.every((event) => event.level === "SEVERE" && event.type === "security" && event.confidence === "HIGH")).toBe(true);
    expect(parseFrExports({ 0: (frExport as unknown[])[0] }, context).events).toEqual(parsed.events);
    const multilingual = structuredClone(frExport) as Array<Record<string, unknown>>;
    (multilingual[0].infos as Array<Record<string, unknown>>).push(structuredClone((multilingual[0].infos as Array<Record<string, unknown>>)[0]));
    const deduplicated = parseFrExports(multilingual, context).events;
    expect(new Set(deduplicated.map(({ id }) => id)).size).toBe(deduplicated.length);
    const epochArchive = `<li id="FR-ALERT.1787776026.90000.0"><h3 data-statut="Actual"></h3></li><script data-drupal-selector="drupal-settings-json">{"alert_entity":{"alerts":{"FR-ALERT.1787776026.90000.0":{}}}}</script>`;
    expect(parseFrArchive(epochArchive, now).identifiers).toEqual(["FR-ALERT.1787776026.90000.0"]);
  });

  it("ignores generic Fire categories until an exact official wildfire code is evidenced", () => {
    const genericFrFire = structuredClone(frExport) as Array<Record<string, unknown>>;
    (genericFrFire[0].infos as Array<Record<string, unknown>>)[0]["catégorie"] = "Fire";
    expect(parseFrExports(genericFrFire, context)).toMatchObject({ events: [], invalid: 0 });
    const genericLuFire = luCap.replaceAll("<category>Safety</category>", "<category>Fire</category>");
    expect(parseLuCap(genericLuFire, context)).toMatchObject({ ignored: true, events: [] });
    expect(nationalWarningSources.FR.hazards).not.toContain("wildfire");
    expect(nationalWarningSources.LU.hazards).not.toContain("wildfire");
  });

  it("keeps every country without active national runtime current, sourced, and fail-closed", () => {
    const disabled = Object.values(nationalWarningSources).filter(({ enabled }) => !enabled);
    expect(disabled).toHaveLength(18);
    expect(disabled.every(({ reviewedAt, evidenceUrls, limitationCode }) =>
      Date.parse(reviewedAt) >= Date.parse("2026-08-30") && evidenceUrls.length > 0 && Boolean(limitationCode))).toBe(true);
  });

  it("bounds FR archive selection and applies cancellation before destination caps", () => {
    const alerts = Object.fromEntries(Array.from({ length: 251 }, (_, index) => [`FR-ALERT.2026${String(index).padStart(6, "0")}`, { created: `2026-08-${String(1 + index % 27).padStart(2, "0")}T00:00:00Z`, status: "Actual" }]));
    const html = `<script data-drupal-selector="drupal-settings-json">${JSON.stringify({ alert_entity: { alerts } })}</script>`;
    const bounded = parseFrArchive(html, now);
    expect(bounded).toMatchObject({ overflow: true });
    expect(bounded.identifiers).toHaveLength(250);
    const alert = (frExport as Array<Record<string, unknown>>)[0];
    const cancelled = { identifiant: "FR-ALERT.cancel", status: "Réel", dateEmission: "28/08/2026 06:30:00", fuseauHoraire: { utc: "UTC+02" }, msgType: "Cancel", references: "sender,FR-ALERT.20260828.1,2026-08-28T04:00:00Z" };
    expect(parseFrExports([alert, cancelled], context).events).toEqual([]);
    expect(parseFrExports(frExport, { ...context, now: new Date("2026-08-29T12:00:00Z") })).toMatchObject({ events: [], invalid: 0 });
    const invertedExpired = structuredClone(alert);
    const invertedExpiredInfo = (invertedExpired.infos as Array<Record<string, unknown>>)[0];
    invertedExpiredInfo.dateEffective = "29/07/2026 19:11:40";
    invertedExpiredInfo["dateExpiré"] = "29/07/2026 08:54:14";
    expect(parseFrExports([invertedExpired], context)).toMatchObject({ events: [], invalid: 0, unavailableLocationIds: [] });
    const invertedCurrent = structuredClone(alert);
    const invertedCurrentInfo = (invertedCurrent.infos as Array<Record<string, unknown>>)[0];
    invertedCurrentInfo.dateEffective = "28/08/2026 08:00:00";
    invertedCurrentInfo["dateExpiré"] = "28/08/2026 07:00:00";
    expect(() => parseFrExports([invertedCurrent], context)).toThrow(/no parseable records/);
    const circleAlert = structuredClone(alert);
    const circleInfo = (circleAlert.infos as Array<Record<string, unknown>>)[0];
    circleInfo.areas = [{ descriptionZone: "Paris", polygone: [], cercle: ["48.85341,2.3488 150"] }];
    const circleEvents = parseFrExports([circleAlert], context).events;
    expect(circleEvents.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("fr-paris"))).toBe(true);
    expect(circleEvents.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("fr-reims"))).toBe(true);
    expect(() => capPolygon("48.75,2.20 48.95,2.20 48.95,2.50 48.75,2.50")).toThrow(/closed ring/);
  });

  it("maps only structured severity and emergency codes", () => {
    expect(["Extreme", "Severe", "Moderate", "Minor", "Unknown"].map(capSeverity)).toEqual(["SEVERE", "HIGH", "ELEVATED", "ELEVATED", "ELEVATED"]);
    expect(structuredHazard(["NUCLEAR_INCIDENT"])).toBe("nuclear");
    expect(structuredHazard([{ valueName: "FR_EVENT", value: "NUCLEAR_INCIDENT" }])).toBe("nuclear");
    expect(structuredHazard(["hazardous-materials"])).toBe("industrial");
    expect(structuredHazard(["Safety"])).toBe("civil-emergency");
    expect(structuredHazard(["Security"])).toBe("security");
    expect(structuredHazard(["Unmapped official code"])).toBe("civil-emergency");
  });

  it("uses the secure FR certificate-chain fallback only for the known TLS error", async () => {
    const tlsError = new TypeError("fetch failed", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    const primary = vi.fn(async () => { throw tlsError; });
    const fallback = vi.fn(async () => new Response("ok"));
    expect(await (await withFrAlertTlsFallback(primary as typeof fetch, fallback as typeof fetch)("https://fr-alert.gouv.fr/les-alertes")).text()).toBe("ok");
    expect(fallback).toHaveBeenCalledTimes(1);
    const ordinaryError = new Error("offline");
    const noFallback = withFrAlertTlsFallback((async () => { throw ordinaryError; }) as typeof fetch, fallback as typeof fetch);
    await expect(noFallback("https://fr-alert.gouv.fr/les-alertes")).rejects.toBe(ordinaryError);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("uses the FR HEAD fast path and re-emits retained unexpired alerts", async () => {
    const parsed = parseFrExports(frExport, context).events;
    const state = createEmptyState(now);
    state.events.push(...parsed);
    state.sourcePartitions.nationalCivilAlerts.FR.status = "ok";
    state.sourcePartitions.nationalCivilAlerts.FR.sourceUpdatedAt = "2026-08-28T04:00:00.000Z";
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response(null, { headers: { "Last-Modified": "Fri, 28 Aug 2026 04:00:00 GMT" } });
    });
    const result = await fetchFrPartition({ ...context, state, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ status: "ok", events: parsed, unavailableLocationIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
  });

  it("downloads a changed FR archive once and fails closed on malformed non-empty exports", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { headers: { "Last-Modified": "Fri, 28 Aug 2026 04:00:00 GMT" } });
      if (String(url).endsWith("/export-alert")) return Response.json(frExport);
      return new Response(archive);
    });
    const result = await fetchFrPartition({ ...context, fetch: fetchMock as typeof fetch });
    expect(result.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(() => parseFrExports([{ identifiant: "broken", status: "Réel", infos: [{}] }], context)).toThrow(/no parseable records/);
    const mixed = structuredClone(frExport) as Array<Record<string, unknown>>;
    const invalidInfo = structuredClone((mixed[0].infos as Array<Record<string, unknown>>)[0]);
    invalidInfo["sévérité"] = "unsupported";
    mixed.push({ ...mixed[0], identifiant: "FR-ALERT.invalid", infos: [invalidInfo] });
    const mixedResult = parseFrExports(mixed, context);
    expect(mixedResult.unavailableLocationIds).toContain("fr-paris");
    expect(mixedResult.unavailableLocationIds).not.toContain("fr-lyon");
  });

  it("reports bounded FR archive and export overflows as scoped partial results", async () => {
    const archiveOverflowFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { headers: { "Last-Modified": "Fri, 28 Aug 2026 04:00:00 GMT" } })
      : new Response("x", { headers: { "Content-Length": String(6 * 1024 * 1024 + 1) } }));
    const archiveOverflow = await fetchFrPartition({ ...context, fetch: archiveOverflowFetch as typeof fetch });
    expect(archiveOverflow).toMatchObject({ status: "partial", checkedLocationIds: [], error: "FR-Alert archive response limit reached" });
    expect(archiveOverflow.unavailableLocationIds).toHaveLength(locations.filter(({ countryCode }) => countryCode === "FR").length);

    const exportOverflowFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { headers: { "Last-Modified": "Fri, 28 Aug 2026 04:00:00 GMT" } });
      if (String(url).endsWith("/export-alert")) return new Response("x", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } });
      return new Response(archive);
    });
    const exportOverflow = await fetchFrPartition({ ...context, fetch: exportOverflowFetch as typeof fetch });
    expect(exportOverflow).toMatchObject({ status: "partial", checkedLocationIds: [], error: "FR-Alert export response limit reached" });
    expect(exportOverflow.unavailableLocationIds).toHaveLength(locations.filter(({ countryCode }) => countryCode === "FR").length);
  });

  it("does not turn an unchanged partial FR or LU partition falsely healthy", async () => {
    const frState = createEmptyState(now);
    frState.sourcePartitions.nationalCivilAlerts.FR.status = "partial";
    frState.sourcePartitions.nationalCivilAlerts.FR.sourceUpdatedAt = "2026-08-28T04:00:00.000Z";
    const frFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { headers: { "Last-Modified": "Fri, 28 Aug 2026 04:00:00 GMT" } });
      return String(url).endsWith("/export-alert") ? Response.json(frExport) : new Response(archive);
    });
    expect((await fetchFrPartition({ ...context, state: frState, fetch: frFetch as typeof fetch })).status).toBe("ok");
    expect(frFetch).toHaveBeenCalledTimes(3);

    const luState = createEmptyState(now);
    luState.sourcePartitions.nationalCivilAlerts.LU.status = "partial";
    luState.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T04:00:00.000Z";
    const resource = { url: "https://download.data.public.lu/invalid.xml", last_modified: "2026-08-28T03:30:00Z", format: "xml" };
    const luFetch = vi.fn(async (url: string | URL | Request) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T04:00:00Z", resources: [resource] })
      : new Response("<alert></alert>"));
    await expect(fetchLuPartition({ ...context, state: luState, fetch: luFetch as typeof fetch })).rejects.toThrow(/no parseable records/);
    expect(luFetch).toHaveBeenCalledTimes(2);
    const recoveredFetch = vi.fn(async (url: string | URL | Request) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T04:00:00Z", resources: [resource] })
      : new Response(luCap));
    expect(await fetchLuPartition({ ...context, state: luState, fetch: recoveredFetch as typeof fetch })).toMatchObject({ status: "ok", unavailableLocationIds: [] });
    expect(recoveredFetch).toHaveBeenCalledTimes(2);
  });

  it("prefers English CAP-LU information, maps severity, and rejects test scope", () => {
    const record = parseLuCap(luCap, context);
    expect(record).toMatchObject({ identifier: "LU-Alert.fixture.1", msgType: "alert", ignored: false });
    expect(record.events).toHaveLength(5);
    expect(record.events.every((event) => event.headline === "English public alert" && event.level === "HIGH" && event.type === "civil-emergency")).toBe(true);
    expect(parseLuCap(luCap.replace("<status>Actual</status>", "<status>Exercise</status>"), context)).toMatchObject({ ignored: true, events: [] });
    expect(parseLuCap(luCap, { ...context, now: new Date("2026-08-29T04:30:00.000Z") })).toMatchObject({ ignored: true, events: [] });
    const countrywide = luCap.replace(/<polygon>[\s\S]*?<\/polygon>/g, "");
    expect(parseLuCap(countrywide, context).events).toHaveLength(5);
  });

  it("applies CAP-LU cancellation relationships and keeps resource requests bounded", async () => {
    const cancelled = luCap
      .replace("<identifier>LU-Alert.fixture.1</identifier>", "<identifier>LU-Alert.fixture.cancel</identifier>")
      .replace("<msgType>Alert</msgType>", "<msgType>Cancel</msgType>\n  <references>fixture@example.lu,LU-Alert.fixture.1,2026-08-28T06:00:00+02:00</references>")
      .replace(/\s*<info>[\s\S]*<\/info>\s*<\/alert>/, "\n</alert>");
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    const resources = [
      { url: "https://download.data.public.lu/alert.xml", last_modified: "2026-08-28T03:00:00Z", format: "xml" },
      { url: "https://download.data.public.lu/cancel.xml", last_modified: "2026-08-28T04:00:00Z", format: "xml" },
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:00:00Z", resources });
      return new Response(value.endsWith("cancel.xml") ? cancelled : luCap);
    });
    const result = await fetchLuPartition({ ...context, state, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ status: "ok", events: [], unavailableLocationIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("scopes malformed CAP-LU records to their parseable affected geometry", async () => {
    const localizedInvalid = luCap
      .replaceAll("<severity>Severe</severity>", "<severity>Unsupported</severity>")
      .replaceAll(/<polygon>[\s\S]*?<\/polygon>/g, "<polygon>49.605,6.125 49.615,6.125 49.615,6.140 49.605,6.140 49.605,6.125</polygon>")
      .replace("LU-Alert.fixture.1", "LU-Alert.fixture.invalid");
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    const resources = [
      { url: "https://download.data.public.lu/valid.xml", last_modified: "2026-08-28T03:00:00Z", format: "xml" },
      { url: "https://download.data.public.lu/invalid.xml", last_modified: "2026-08-28T04:00:00Z", format: "xml" },
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:00:00Z", resources });
      return new Response(value.endsWith("invalid.xml") ? localizedInvalid : luCap);
    });
    const result = await fetchLuPartition({ ...context, state, fetch: fetchMock as typeof fetch });
    expect(result.status).toBe("partial");
    expect(result.unavailableLocationIds).toContain("lu-luxembourg");
    expect(result.unavailableLocationIds!.length).toBeLessThan(5);
    expect(result.checkedLocationIds!.length).toBeGreaterThan(0);
    expect(result.events).toHaveLength(5); // Valid evidence survives even where another record is unavailable.
  });

  it.each(["Update", "Pause", "Resume"])("accepts CAP-LU %s lifecycle records", (msgType) => {
    const xml = luCap.replace("<msgType>Alert</msgType>", `<msgType>${msgType}</msgType><references>fixture@example.lu,LU-Alert.previous,2026-08-28T05:00:00+02:00</references>`);
    const parsed = parseLuCap(xml, context);
    expect(parsed.msgType).toBe(msgType.toLowerCase());
    expect(parsed.references).toEqual(["LU-Alert.previous"]);
    expect(parsed.events.length).toBe(msgType === "Pause" ? 0 : 5);
  });

  it("re-emits retained LU alerts when dataset metadata is unchanged", async () => {
    const retained = parseLuCap(luCap, context).events[0] as NormalizedEvent;
    const state = createEmptyState(now);
    state.events.push(retained);
    state.sourcePartitions.nationalCivilAlerts.LU.status = "ok";
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T04:00:00.000Z";
    const fetchMock = vi.fn(async () => Response.json({ last_update: "2026-08-28T04:00:00Z", resources: [] }));
    const result = await fetchLuPartition({ ...context, state, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ status: "ok", events: [retained], unavailableLocationIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports CAP-LU resource overflow as partial and advances its watermark", async () => {
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    const resources = Array.from({ length: 101 }, (_, index) => ({
      url: `https://download.data.public.lu/${index}.xml`,
      last_modified: new Date(Date.parse("2026-08-28T03:00:00Z") + index * 1_000).toISOString(),
      format: "xml",
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T05:00:00Z", resources })
      : new Response(luCap));
    const result = await fetchLuPartition({ ...context, state, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ status: "partial", sourceUpdatedAt: resources[99].last_modified, checkedLocationIds: [] });
    expect(result.unavailableLocationIds).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(101);
    state.sourcePartitions.nationalCivilAlerts.LU.status = "partial";
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = result.sourceUpdatedAt;
    state.sourcePartitions.nationalCivilAlerts.LU.error = result.error;
    const catchUpFetch = vi.fn(async (url: string | URL | Request) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T05:00:00Z", resources })
      : new Response(luCap));
    expect(await fetchLuPartition({ ...context, state, fetch: catchUpFetch as typeof fetch })).toMatchObject({ status: "ok", sourceUpdatedAt: "2026-08-28T05:00:00.000Z" });
    expect(catchUpFetch).toHaveBeenCalledTimes(2);
  });

  it("treats a bounded CAP-LU resource overflow as partial rather than a healthy empty result", async () => {
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    const resource = { url: "https://download.data.public.lu/large.xml", last_modified: "2026-08-28T03:00:00Z", format: "xml" };
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T04:00:00Z", resources: [resource] })
      : new Response("x", { headers: { "Content-Length": String(128 * 1024 + 1) } }));
    const result = await fetchLuPartition({ ...context, state, fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ status: "partial", events: [], checkedLocationIds: [] });
    expect(result.unavailableLocationIds).toHaveLength(5);
  });

  it("retries an older CAP-LU resource after a mixed-validity partial run", async () => {
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    const resources = [
      { url: "https://download.data.public.lu/older.xml", last_modified: "2026-08-28T02:30:00Z", format: "xml" },
      { url: "https://download.data.public.lu/newer.xml", last_modified: "2026-08-28T03:30:00Z", format: "xml" },
    ];
    const first = await fetchLuPartition({ ...context, state, fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:00:00Z", resources });
      return new Response(url.endsWith("older.xml") ? "<broken />" : luCap.replaceAll("LU-Alert.fixture.1", "LU-Alert.newer"));
    }) as typeof fetch });
    expect(first).toMatchObject({ status: "partial", sourceUpdatedAt: "2026-08-28T02:00:00.000Z" });

    state.sourcePartitions.nationalCivilAlerts.LU.status = "partial";
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = first.sourceUpdatedAt;
    state.sourcePartitions.nationalCivilAlerts.LU.error = first.error;
    const calls: string[] = [];
    const recovered = await fetchLuPartition({ ...context, state, fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:00:00Z", resources });
      const identifier = url.endsWith("older.xml") ? "LU-Alert.older" : "LU-Alert.newer";
      return new Response(luCap.replaceAll("LU-Alert.fixture.1", identifier));
    }) as typeof fetch });

    expect(recovered.status).toBe("ok");
    expect(calls).toContain("https://download.data.public.lu/older.xml");
    expect(recovered.events.some((event) => event.id.startsWith("lu-alert:LU-Alert.older:"))).toBe(true);
  });

  it("keeps the committed CAP-LU bootstrap parseable as alerts expire", () => {
    const bootstrapNow = new Date(bootstrapJson.generatedAt);
    expect(bootstrapJson.alerts.length).toBeGreaterThan(0);
    expect(() => bootstrapJson.alerts.map((xml) => parseLuCap(xml, { ...context, now: bootstrapNow }))).not.toThrow();
  });

  it("drives enabled national coverage and precise limitations from the manifest", () => {
    for (const countryCode of ["AT", "FR", "LU"] as const) {
      expect(nationalWarningSources[countryCode]).toMatchObject({ enabled: true, limitationCode: null });
      for (const hazard of nationalWarningSources[countryCode].hazards) {
        expect(coverageJson.countries[countryCode].hazards[hazard]).toMatchObject({ status: "partial", providerIds: expect.arrayContaining(["national-civil-alerts"]) });
      }
    }
    expect(nationalWarningSources.FR.license?.name).toMatch(/Open Licence 2\.0/);
    expect(nationalWarningSources.LU.license?.name).toBe("CC BY 4.0");
    expect(nationalWarningSources.AT).toMatchObject({
      enabled: true, limitationCode: null, format: "json", hazards: ["civil-emergency"],
    });
    expect(coverageJson.countries.AT.hazards["civil-emergency"]).toMatchObject({
      status: "partial", providerIds: expect.arrayContaining(["national-civil-alerts"]),
    });
    expect(coverageJson.countries.AT.hazards.security.status).toBe("not_monitored");
  });

  it("scores official AT-Alert levels, rejects tests, and requires geometry", async () => {
    const fixture = JSON.parse(await readFile("tests/fixtures/providers/at-alert-list.json", "utf8"));
    const parsed = atAlertPartition(fixture, context);
    expect(parsed.status).toBe("ok");
    expect(parsed.events.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("at-vienna"))).toBe(true);
    expect(parsed.events.every((event) => event.level === "HIGH" && event.type === "civil-emergency" && !event.id.includes("TEST"))).toBe(true);
    const empty = atAlertPartition({ json: { totalCount: 0, alerts: [] } }, context);
    expect(empty).toMatchObject({ status: "ok", events: [], error: null });
    const missingGeometry = structuredClone(fixture);
    delete missingGeometry.json.alerts[0].polygons;
    const invalid = atAlertPartition(missingGeometry, context);
    expect(invalid.status).toBe("partial");
    expect(invalid.unavailableLocationIds).toContain("at-vienna");
    const overflow = atAlertPartition({ json: { totalCount: 101, alerts: fixture.json.alerts } }, context);
    expect(overflow).toMatchObject({ status: "partial", error: "AT-Alert input limit reached" });
    expect(overflow.unavailableLocationIds).toContain("at-vienna");
    expect(overflow.checkedLocationIds).toEqual([]);
  });

  it("marks an AT-Alert ending before it starts as invalid", async () => {
    const fixture = JSON.parse(await readFile("tests/fixtures/providers/at-alert-list.json", "utf8"));
    fixture.json.alerts[0].end_date = "2026-08-28T02:00:00.000Z";
    const result = atAlertPartition(fixture, context);
    expect(result).toMatchObject({ status: "partial", events: [], error: "1 AT-Alert records were invalid" });
    expect(result.unavailableLocationIds).toContain("at-vienna");
  });

  it("discards parsed AT-Alert events and marks every Austrian destination unavailable on overflow", async () => {
    const fixture = JSON.parse(await readFile("tests/fixtures/providers/at-alert-list.json", "utf8"));
    const parsed = atAlertPartition(fixture, context);
    expect(parsed.events.length).toBeGreaterThan(0);

    const austrianIds = locations.filter(({ countryCode }) => countryCode === "AT").map(({ id }) => id).sort();
    const overflow = atAlertPartition({ json: { totalCount: 101, alerts: fixture.json.alerts } }, context);
    expect(overflow).toMatchObject({ status: "partial", error: "AT-Alert input limit reached", events: [], checkedLocationIds: [] });
    expect(overflow.unavailableLocationIds).toEqual(austrianIds);

    const overflowByCount = atAlertPartition({
      json: { totalCount: 2, alerts: Array.from({ length: 101 }, () => fixture.json.alerts[0]) },
    }, context);
    expect(overflowByCount).toMatchObject({ status: "partial", error: "AT-Alert input limit reached", events: [] });
    expect(overflowByCount.unavailableLocationIds).toEqual(austrianIds);
  });
});


it("persists LU warnings across overflow batches and applies cancellations during partial recovery", async () => {
  let state = createEmptyState(now);
  state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00Z";
  const resources = Array.from({ length: 101 }, (_, index) => ({ url: `https://download.data.public.lu/${index}.xml`,
    last_modified: new Date(Date.parse("2026-08-28T03:00:00Z") + index * 1000).toISOString(), format: "xml" }));
  const calls: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    return url.includes("api/1/datasets") ? Response.json({ last_update: "2026-08-28T04:00:00Z", resources })
      : new Response(url.endsWith("/0.xml") ? luCap : luCap.replace("<status>Actual</status>", "<status>Test</status>"));
  };
  const merge = (partition: Awaited<ReturnType<typeof fetchLuPartition>>) => {
    const result = PartitionedSourceResultSchema.parse({ sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((code) => [code, code === "LU" ? { ...partition, error: partition.status === "partial" ? "Some national transports unavailable" : null, transports: { "lu-alert": partition } }
        : { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "test" }])) });
    state = mergeSourceResults(state, [result], now);
  };
  const first = await fetchLuPartition({ ...context, state, fetch: fetchMock });
  expect(first).toMatchObject({ status: "partial", checkedLocationIds: [], sourceUpdatedAt: resources[99].last_modified });
  expect(first.events).toHaveLength(5);
  merge(first);
  const recovered = await fetchLuPartition({ ...context, state, fetch: fetchMock });
  expect(recovered.status).toBe("ok"); merge(recovered);
  expect(state.events).toHaveLength(5);
  expect(calls.filter((url) => url.endsWith("/0.xml"))).toHaveLength(1);
  const cancel = luCap.replace("<msgType>Alert</msgType>", "<msgType>Cancel</msgType><references>fixture@example.lu,LU-Alert.fixture.1,2026-08-28T04:00:00Z</references>");
  const cancelled = await fetchLuPartition({ ...context, state, fetch: async (input) => String(input).includes("api/1/datasets")
    ? Response.json({ last_update: "2026-08-28T04:20:00Z", resources: [
      { url: "https://download.data.public.lu/cancel.xml", last_modified: "2026-08-28T04:10:00Z", format: "xml" },
      { url: "https://download.data.public.lu/broken.xml", last_modified: "2026-08-28T04:15:00Z", format: "xml" },
    ] }) : new Response(String(input).endsWith("cancel.xml") ? cancel : "<broken />") });
  expect(cancelled.status).toBe("partial"); merge(cancelled);
  expect(state.events).toEqual([]);
});
