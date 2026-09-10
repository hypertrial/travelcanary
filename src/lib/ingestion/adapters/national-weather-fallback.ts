import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { CountryCode, HazardLevel, HazardType, NormalizedEvent } from "../../domain/schemas";
import { meteoalarmFallbackSystem } from "../../national-warning-sources";
import { fetchAllowlisted, fetchWithRetry, mapConcurrent } from "../fetch";
import { eventCopy } from "../templates";
import type { IngestionContext } from "../types";
import { capPolygon, matchingLocations, overlapsNextDay } from "./national-civil-alerts-shared";
import ipmaMappingJson from "../../../../data/ipma-warning-mapping.json";
import { z } from "zod";
import { locations } from "../../data";
import { fetchDirectWeatherCaps } from "./direct-weather-cap";

type Recovery = { events: NormalizedEvent[]; removedEventPrefixes: string[]; sourceUpdatedAt: string; transportId: string };
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value).trim()
  : value && typeof value === "object" && "#text" in value ? text((value as Record<string, unknown>)["#text"]) : "";

function severity(value: unknown): HazardLevel | null {
  const normalized = text(value).toLowerCase();
  if (normalized === "extreme" || normalized === "red") return "SEVERE";
  if (normalized === "severe" || normalized === "orange") return "HIGH";
  if (normalized === "moderate" || normalized === "yellow") return "ELEVATED";
  return null;
}

const fmiHazards: Record<string, HazardType> = {
  wind: "severe-weather", rain: "severe-weather", thunderstorm: "severe-weather", hotweather: "extreme-heat",
  coldweather: "extreme-cold", trafficweather: "snow-ice", pedestriansafety: "snow-ice",
  forestfireweather: "fire-danger", seawaterheight: "coastal", seawaveheight: "coastal",
  seawind: "coastal", seathunderstorm: "coastal", seaicing: "coastal",
};

const IpmaMappingSchema = z.object({ schemaVersion: z.literal(1), reviewedAt: z.string().date(), source: z.string().url(), documentation: z.string().url(),
  mappings: z.record(z.string().regex(/^[A-Z]{3}$/), z.array(z.string())), unsupportedOfficialAreas: z.array(z.string().regex(/^[A-Z]{3}$/)) }).superRefine((value, context) => {
  const known = new Set(Object.keys(value.mappings).concat(value.unsupportedOfficialAreas));
  if (known.size !== Object.keys(value.mappings).length + value.unsupportedOfficialAreas.length) context.addIssue({ code: "custom", message: "Duplicate IPMA warning area" });
  const portugal = new Set(locations.filter(({ countryCode }) => countryCode === "PT").map(({ id }) => id));
  const mapped = Object.values(value.mappings).flat();
  const official = ["AVR", "BJA", "BRG", "BGC", "CBO", "CBR", "EVR", "FAR", "GDA", "LRA", "LSB", "PTG", "PTO", "STM", "STB", "VCT", "VRL", "VIS", "MCS", "MPS", "AOR", "ACE", "AOC"];
  if (official.some((code) => !known.has(code)) || known.size !== official.length) context.addIssue({ code: "custom", message: "IPMA warning mapping must classify every official area" });
  if (new Set(mapped).size !== mapped.length || mapped.some((id) => !portugal.has(id)) || mapped.length !== portugal.size) context.addIssue({ code: "custom", message: "Invalid IPMA location mapping" });
});
const ipmaMapping = IpmaMappingSchema.parse(ipmaMappingJson);
const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ipmaHazards: Record<string, HazardType> = {
  "tempo quente": "extreme-heat", "tempo frio": "extreme-cold", neve: "snow-ice", "agitacao maritima": "coastal",
  precipitacao: "severe-weather", trovoada: "severe-weather", vento: "severe-weather", nevoeiro: "severe-weather",
};
const ipmaRows = z.array(z.object({ idAreaAviso: z.string().regex(/^[A-Z]{3}$/), awarenessLevelID: z.string(), awarenessTypeName: z.string(),
  startTime: z.string(), endTime: z.string(), text: z.unknown().optional() }).passthrough()).max(500);
const utc = (value: string) => Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);

export function parseIpmaWarnings(value: unknown, context: IngestionContext, sourceUpdatedAt: string): Recovery {
  const rows = ipmaRows.parse(value); const updated = Date.parse(sourceUpdatedAt);
  if (!Number.isFinite(updated) || updated > context.now.getTime() + 300_000 || context.now.getTime() - updated > 24 * 3_600_000) throw new Error("IPMA warning list update time is invalid or stale");
  const events: NormalizedEvent[] = [];
  for (const row of rows) {
    const levelName = normalize(row.awarenessLevelID);
    if (levelName === "green") continue;
    const level = severity(levelName); const hazard = ipmaHazards[normalize(row.awarenessTypeName)];
    const ids = ipmaMapping.mappings[row.idAreaAviso];
    const starts = utc(row.startTime); const ends = utc(row.endTime);
    if (!level || !hazard) throw new Error(`Unsupported non-green IPMA warning classification: ${row.awarenessLevelID}/${row.awarenessTypeName}`);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends || starts > context.now.getTime() + 24 * 3_600_000 || ends <= context.now.getTime()) continue;
    if (!ids?.length) continue;
    const copy = eventCopy(hazard, level, "the affected Portuguese warning area", starts > context.now.getTime());
    const stable = createHash("sha256").update(`${row.idAreaAviso}|${normalize(row.awarenessTypeName)}|${row.startTime}|${row.endTime}|${levelName}`).digest("hex").slice(0, 24);
    events.push({ id: `meteoalarm:ipma:${stable}:${row.idAreaAviso}`, sourceId: "meteoalarm", providerId: "meteoalarm", transportId: "ipma-warnings-json",
      type: hazard, level, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE", ...copy,
      affectedArea: "Portuguese warning area", geometry: { kind: "locations", ids }, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(),
      sourceUpdatedAt: new Date(updated).toISOString(), checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(),
      sourceName: "IPMA", sourceUrl: "https://www.ipma.pt/en/otempo/prev-sam/", confidence: "HIGH" });
  }
  return { events, removedEventPrefixes: ["meteoalarm:ipma:"], sourceUpdatedAt: new Date(updated).toISOString(), transportId: "ipma-warnings-json" };
}

export function parseFmiCap(xml: string, context: IngestionContext, sourceUrl: string) {
  const alert = (parser.parse(xml) as { alert?: Record<string, unknown> }).alert;
  if (!alert) throw new Error("FMI CAP record has no alert");
  if (text(alert.status) !== "Actual" || text(alert.scope) !== "Public") return { events: [], removed: [], updatedAt: context.now.toISOString() };
  const identifier = text(alert.identifier);
  const sent = Date.parse(text(alert.sent));
  if (!identifier || !Number.isFinite(sent) || sent > context.now.getTime() + 5 * 60_000) throw new Error("FMI CAP identifier or sent time is invalid");
  const lifecycle = text(alert.msgType).toLowerCase();
  const references = text(alert.references).split(/\s+/).flatMap((reference) => reference.split(",").slice(1, 2)).filter(Boolean);
  if (lifecycle === "cancel") return { events: [], removed: references.map((id) => `meteoalarm:fmi:${id}:`), updatedAt: new Date(sent).toISOString() };
  if (!["alert", "update"].includes(lifecycle)) return { events: [], removed: [], updatedAt: new Date(sent).toISOString() };
  const infos = array(alert.info as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const info = infos.find((item) => text(item.language).toLowerCase().startsWith("en")) || infos[0];
  if (!info || text(info.category).toLowerCase() !== "met") throw new Error("FMI CAP record has no supported public weather information");
  const eventCodes = array(info.eventCode as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .filter((item) => /^profile:cap:https:\/\/alerts\.fmi\.fi\/cap\/profile\/v1\.\d+\.\d+$/.test(text(item.valueName)))
    .map((item) => text(item.value));
  if (!eventCodes.length) throw new Error("FMI CAP record has no supported profile event code");
  const hazard = eventCodes.map((code) => fmiHazards[code.toLowerCase()]).find(Boolean);
  const level = severity(info.severity);
  if (!hazard || text(info.severity).toLowerCase() === "minor") return { events: [], removed: [], updatedAt: new Date(sent).toISOString() };
  if (!level) throw new Error("FMI CAP severity is unsupported");
  const starts = Date.parse(text(info.onset || info.effective));
  const ends = Date.parse(text(info.expires));
  if (!overlapsNextDay(starts, ends, context.now)) return { events: [], removed: [], updatedAt: new Date(sent).toISOString() };
  const areas = array(info.area as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const polygons = areas.flatMap((area) => array(area.polygon as unknown | unknown[] | undefined).map((value) => capPolygon(text(value))));
  if (!polygons.length) throw new Error("FMI CAP record has no usable polygon geometry");
  const matches = matchingLocations(polygons, context.locations.filter(({ countryCode }) => countryCode === "FI"));
  const copy = eventCopy(hazard, level, "the affected Finnish warning area", starts > context.now.getTime());
  const events = matches.map((location): NormalizedEvent => ({
    id: `meteoalarm:fmi:${identifier}:${createHash("sha256").update(location.id).digest("hex").slice(0, 12)}`,
    sourceId: "meteoalarm", providerId: "meteoalarm", type: hazard, level, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE",
    headline: copy.headline, explanation: copy.explanation, action: copy.action, affectedArea: location.name,
    geometry: { kind: "locations", ids: [location.id] }, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(),
    sourceUpdatedAt: new Date(sent).toISOString(), checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(),
    sourceName: "Finnish Meteorological Institute", sourceUrl, confidence: "HIGH",
  }));
  return { events, removed: lifecycle === "update" ? references.map((id) => `meteoalarm:fmi:${id}:`) : [], updatedAt: new Date(sent).toISOString() };
}

// Official Met Éireann JSON/CAP contract, June 2020 pp. 7–9, reviewed 2026-08-31.
export const irishWarningCounties: Record<string, string> = {
  EI01: "carlow", EI02: "cavan", EI03: "clare", EI04: "cork", EI06: "donegal", EI07: "dublin", EI10: "galway", EI11: "kerry",
  EI12: "kildare", EI13: "kilkenny", EI14: "leitrim", EI15: "laois", EI16: "limerick", EI18: "longford", EI19: "louth", EI20: "mayo",
  EI21: "meath", EI22: "monaghan", EI23: "offaly", EI24: "roscommon", EI25: "sligo", EI26: "tipperary", EI27: "waterford", EI29: "westmeath", EI30: "wexford", EI31: "wicklow",
};
const irishTypes: Record<string, HazardType> = { rain: "severe-weather", wind: "severe-weather", "snow-ice": "snow-ice", "low-temperature": "extreme-cold", "high-temperature": "extreme-heat", fog: "severe-weather", thunderstorm: "severe-weather" };
type IrishWarning = { capId?: unknown; type?: unknown; description?: unknown; severity?: unknown; level?: unknown; updated?: unknown; onset?: unknown; expiry?: unknown; regions?: unknown; status?: unknown; headline?: unknown };
export function parseMetEireannWarnings(value: unknown, context: IngestionContext): Recovery {
  if (!Array.isArray(value)) throw new Error("Met Eireann warnings response is not an array");
  if (value.length > 100) throw new Error("Met Eireann warning limit exceeded");
  const events: NormalizedEvent[] = [];
  let parseable = 0;
  let newest: number | null = null;
  for (const raw of (value as IrishWarning[]).slice(0, 100)) {
    if (text(raw.status).toLowerCase() !== "warning") continue;
    const id = text(raw.capId); const level = severity(raw.severity || raw.level);
    const starts = Date.parse(text(raw.onset)); const ends = Date.parse(text(raw.expiry)); const updated = Date.parse(text(raw.updated));
    const regions = Array.isArray(raw.regions) ? raw.regions.map(text).filter(Boolean) : [];
    if (!id || !level || !Number.isFinite(updated) || updated > context.now.getTime() + 5 * 60_000
      || !Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts || !regions.length) continue;
    parseable += 1;
    newest = Math.max(newest ?? Number.NEGATIVE_INFINITY, updated);
    if (!overlapsNextDay(starts, ends, context.now)) continue;
    const hazard = irishTypes[text(raw.type).toLowerCase()];
    if (!hazard) continue; // Includes blight/advisory and undocumented classes; never infer from prose.
    if (regions.some((code) => !irishWarningCounties[code])) throw new Error("Unknown Irish warning area");
    const countryWide = Object.keys(irishWarningCounties).every((code) => regions.includes(code));
    const matches = context.locations.filter((location) => location.countryCode === "IE" && (countryWide || regions.some((code) => location.sourceRegionCodes.meteoalarm.includes(`area:${irishWarningCounties[code]}`) || location.sourceRegionCodes.meteoalarm.includes(`area:county ${irishWarningCounties[code]}`))));
    if (!matches.length) continue;
    // The official contract forbids altering headline/description. Reject oversized copy, never truncate it.
    const headline = typeof raw.headline === "string" ? raw.headline : "";
    const explanation = typeof raw.description === "string" ? raw.description : "";
    if (headline.length < 3 || headline.length > 180 || explanation.length < 3 || explanation.length > 500) throw new Error("Irish warning copy cannot be displayed unmodified within alert limits");
    const copy = eventCopy(hazard, level, "the affected Irish counties", starts > context.now.getTime());
    events.push({
      id: `meteoalarm:met-eireann:${id}:ireland`, sourceId: "meteoalarm", providerId: "meteoalarm", transportId: "met-eireann-json", type: hazard, level,
      timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE", headline, explanation, action: copy.action,
      affectedArea: countryWide ? "Ireland" : regions.map((code) => irishWarningCounties[code]).join(", "), geometry: { kind: "locations", ids: matches.map(({ id }) => id) },
      startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), sourceUpdatedAt: new Date(updated).toISOString(),
      checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(), sourceName: "Met Eireann",
      sourceUrl: "https://www.met.ie/warnings-today.html", confidence: "HIGH",
    });
  }
  if (value.length && !parseable) throw new Error("Met Eireann response contains no parseable warning records");
  return { events, removedEventPrefixes: ["meteoalarm:met-eireann:"], sourceUpdatedAt: newest === null ? context.now.toISOString() : new Date(newest).toISOString(), transportId: "met-eireann-json" };
}

async function fetchFinland(context: IngestionContext): Promise<Recovery> {
  const system = meteoalarmFallbackSystem("FI")!;
  const rss = await fetchWithRetry(context.fetch, system.endpoint!, {}, 1, 256 * 1024, undefined, 4_000, "fmi_rss");
  const document = parser.parse(await rss.text()) as { rss?: { channel?: { item?: unknown } } };
  if (!document.rss?.channel) throw new Error("FMI RSS index has no channel");
  const items = array(document.rss.channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const links = items.map((item) => text(item.link));
  if (links.length > 16 || links.some((url) => !/^https:\/\/alerts\.fmi\.fi\/cap\/.+\.xml$/.test(url))) {
    throw new Error("FMI RSS index contains unsupported or excessive CAP links");
  }
  const records = await mapConcurrent(links, 4, async (url) => {
    const response = await fetchAllowlisted(context.fetch, url, ["alerts.fmi.fi"], 1, { maxBytes: 256 * 1024, diagnosticsCategory: "fmi_cap" });
    return parseFmiCap(await response.text(), context, url);
  });
  return {
    events: records.flatMap(({ events }) => events).slice(0, 500),
    removedEventPrefixes: ["meteoalarm:fmi:", ...new Set(records.flatMap(({ removed }) => removed))],
    sourceUpdatedAt: records.map(({ updatedAt }) => updatedAt).sort().at(-1) || context.now.toISOString(), transportId: system.id,
  };
}

export function nationalWeatherFallbackDisabled(countryCode: CountryCode) {
  const system = meteoalarmFallbackSystem(countryCode);
  return (process.env.NATIONAL_ALERTS_DISABLED_COUNTRIES || "").split(",").map((s) => s.trim()).includes(countryCode)
    || Boolean(system && (process.env.NATIONAL_ALERTS_DISABLED_TRANSPORTS || "").split(",").map((s) => s.trim()).includes(system.id));
}

export async function fetchNationalWeatherFallback(countryCode: CountryCode, context: IngestionContext): Promise<Recovery | null> {
  const system = meteoalarmFallbackSystem(countryCode);
  if (!system || nationalWeatherFallbackDisabled(countryCode)) return null;
  if (countryCode === "ES" || countryCode === "HR") return fetchDirectWeatherCaps(countryCode, context);
  if (countryCode === "FI") return fetchFinland(context);
  if (countryCode === "IE") {
    const response = await fetchWithRetry(context.fetch, system.endpoint!, {}, 1, system.maxBytes || 512 * 1024, undefined, 4_000, "met_eireann");
    return parseMetEireannWarnings(await response.json(), context);
  }
  if (countryCode === "PT") {
    const response = await fetchWithRetry(context.fetch, system.endpoint!, {}, 1, system.maxBytes || 512 * 1024, undefined, 4_000, "ipma_warnings");
    const lastModified = response.headers.get("last-modified");
    if (!lastModified) throw new Error("IPMA warning response has no Last-Modified timestamp");
    return parseIpmaWarnings(await response.json(), context, new Date(lastModified).toISOString());
  }
  return null;
}
