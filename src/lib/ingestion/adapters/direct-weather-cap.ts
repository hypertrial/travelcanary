import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import mapping from "../../../../data/dhmz-warning-mapping.json";
import type { HazardType, NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted } from "../fetch";
import { readCapArchive } from "../cap-archive";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import { eventCopy } from "../templates";
import { capPolygon, matchingLocations, overlapsNextDay } from "./national-civil-alerts-shared";

type Row = Record<string, unknown>;
const array = (value: unknown): Row[] => value === undefined ? [] : (Array.isArray(value) ? value : [value]) as Row[];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+region$/, "").trim();
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const levels = { Moderate: "ELEVATED", Severe: "HIGH", Extreme: "SEVERE" } as const;
const aemetHazards: Record<string, HazardType> = {
  AT: "extreme-heat", BT: "extreme-cold", NE: "snow-ice", AL: "avalanche", VI: "severe-weather",
  LL: "severe-weather", TO: "severe-weather", NI: "severe-weather", CO: "coastal", DE: "snow-ice",
};
const dhmzHazards: Record<string, HazardType> = {
  "1": "severe-weather", "2": "snow-ice", "3": "severe-weather", "4": "severe-weather", "5": "extreme-heat",
  "6": "extreme-cold", "7": "coastal", "8": "fire-danger", "9": "avalanche", "10": "severe-weather", "12": "flood", "13": "flood",
};
function xmlDocument(xml: string): Row {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid warning XML");
  return parser.parse(xml) as Row;
}
function timestamp(value: unknown): number {
  const raw = text(value);
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) throw new Error("CAP timestamp has no offset");
  const result = Date.parse(raw);
  if (!Number.isFinite(result)) throw new Error("Invalid CAP timestamp");
  return result;
}

export function parseDirectWeatherCap(xml: string, country: "ES" | "HR", context: IngestionContext) {
  const alert = xmlDocument(xml).alert as Row | undefined;
  if (!alert || Array.isArray(alert)) throw new Error("CAP document requires one alert");
  const identifier = text(alert.identifier);
  const sender = country === "ES" ? "http://www.aemet.es" : "https://meteo.hr";
  if (text(alert.sender) !== sender) throw new Error("Unreviewed CAP authority");
  const sent = timestamp(alert.sent);
  if (!identifier || sent > context.now.getTime() + 300_000) throw new Error("Invalid CAP identity or future sent time");
  const prefix = country === "ES" ? "meteoalarm:aemet:" : "meteoalarm:dhmz:";
  const removed = text(alert.references).split(/\s+/).filter(Boolean).map((reference) => {
    const parts = reference.split(",");
    if (parts.length !== 3 || parts[0] !== sender || !parts[1]) throw new Error("Malformed CAP reference");
    timestamp(parts[2]);
    return `${prefix}${parts[1]}:`;
  });
  const type = text(alert.msgType);
  if (text(alert.status) !== "Actual" || text(alert.scope) !== "Public") return { events: [], removed: [], sent, identifier, type };
  if (["Update", "Cancel"].includes(type) && !removed.length) throw new Error("CAP lifecycle message has no references");
  if (type === "Cancel") return { events: [], removed, sent, identifier, type };
  if (!["Alert", "Update"].includes(type)) throw new Error("Unsupported CAP lifecycle");
  const infos = array(alert.info);
  if (!infos.length) throw new Error("CAP alert has no information");
  const namedRegion = (area: Row) => mapping.mappings.find((r) => [r.name, ...r.aliases].some((name) => normalize(name) === normalize(text(area.areaDesc))));
  const regionCode = (area: Row) => text(array(area.geocode).find((code) => text(code.valueName) === "EMMA_ID")?.value);
  // A translated area can be joined to its reviewed English area by the CAP's
  // own EMMA_ID. Never infer an unreviewed area from its language or country.
  const translatedRegions = new Map<string, typeof mapping.mappings[number]>();
  if (country === "HR") for (const area of infos.flatMap((info) => array(info.area))) {
    const region = namedRegion(area), code = regionCode(area);
    if (!region || !code) continue;
    const prior = translatedRegions.get(code);
    if (prior && prior.name !== region.name) throw new Error("Conflicting multilingual CAP geography");
    translatedRegions.set(code, region);
  }
  const events = new Map<string, NormalizedEvent>();
  // Parse every area, not just the first English info block. Fixed TravelCanary copy
  // avoids truncating or translating the authority's instructions.
  for (const info of infos) {
    if (text(info.category) !== "Met") throw new Error("Non-weather CAP category");
    if (text(info.severity) === "Minor") continue;
    const level = levels[text(info.severity) as keyof typeof levels];
    if (!level) throw new Error("Unsupported CAP severity");
    const starts = timestamp(info.onset || info.effective);
    const ends = timestamp(info.expires);
    if (ends <= starts) throw new Error("Invalid CAP validity range");
    if (!overlapsNextDay(starts, ends, context.now)) continue;
    const code = country === "ES"
      ? text(array(info.eventCode).find((x) => text(x.valueName) === "AEMET-Meteoalerta fenomeno")?.value).split(";")[0]
      : text(array(info.parameter).find((x) => text(x.valueName) === "awareness_type")?.value).split(";")[0];
    const hazard = (country === "ES" ? aemetHazards : dhmzHazards)[code];
    if (!hazard) throw new Error(`Unreviewed ${country} CAP hazard code: ${code}`);
    const areas = array(info.area);
    if (!areas.length) throw new Error("CAP warning has no area");
    for (const area of areas) {
      let ids: string[];
      let areaKey: string;
      let areaName = text(area.areaDesc);
      let actualHazard = hazard;
      if (country === "HR") {
        const region = namedRegion(area) || translatedRegions.get(regionCode(area));
        if (!region) throw new Error(`Unmapped DHMZ warning area: ${areaName}`);
        ids = region.locationIds.filter((id) => context.locations.some((l) => l.id === id && l.countryCode === "HR"));
        areaName = region.name;
        areaKey = region.name;
        if (region.kind === "sea") actualHazard = "coastal";
      } else {
        const values = Array.isArray(area.polygon) ? area.polygon : area.polygon ? [area.polygon] : [];
        if (!values.length) throw new Error("AEMET warning has no polygon");
        const polygons = values.map(capPolygon);
        areaKey = polygons.map((p) => JSON.stringify(p.geometry.coordinates)).sort().join("|");
        ids = matchingLocations(polygons, context.locations.filter((l) => l.countryCode === "ES")).map((l) => l.id);
      }
      if (!ids.length) continue;
      const id = `${prefix}${identifier}:${hash(`${areaKey}|${actualHazard}|${starts}|${ends}|${ids.slice().sort().join(",")}`)}`;
      const copy = eventCopy(actualHazard, level, areaName || "the official warning area", starts > context.now.getTime());
      const event: NormalizedEvent = {
        id, sourceId: "meteoalarm", providerId: "meteoalarm", transportId: country === "ES" ? "aemet-cap" : "dhmz-cap",
        type: actualHazard, level, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE", ...copy,
        affectedArea: areaName.slice(0, 200), geometry: { kind: "locations", ids },
        startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), expiresAt: new Date(ends).toISOString(),
        sourceUpdatedAt: new Date(sent).toISOString(), checkedAt: context.now.toISOString(),
        sourceName: country === "ES" ? "AEMET · processed by TravelCanary" : "DHMZ · processed by TravelCanary",
        sourceUrl: country === "ES" ? "https://www.aemet.es/en/eltiempo/prediccion/avisos" : "https://meteo.hr/upozorenja/index_en.php",
        confidence: "HIGH",
      };
      const prior = events.get(id);
      if (prior && prior.level !== event.level) throw new Error("Conflicting multilingual CAP severity");
      if (!prior || text(info.language).startsWith("en")) events.set(id, event);
    }
  }
  return { events: [...events.values()], removed: type === "Update" ? removed : [], sent, identifier, type };
}

export function combineDirectWeatherCaps(records: ReturnType<typeof parseDirectWeatherCap>[], country: "ES" | "HR", updatedAt: string) {
  const prefix = country === "ES" ? "meteoalarm:aemet:" : "meteoalarm:dhmz:";
  const removed = records.flatMap((r) => r.removed);
  const events = new Map<string, NormalizedEvent>();
  for (const record of records.slice().sort((a, b) => a.sent - b.sent)) for (const event of record.events) {
    if (!removed.some((ref) => event.id.startsWith(ref))) events.set(event.id, event);
  }
  if (events.size > 500) throw new Error("Direct CAP event limit exceeded");
  return { events: [...events.values()], removedEventPrefixes: [prefix, ...new Set(removed)], sourceUpdatedAt: updatedAt,
    transportId: country === "ES" ? "aemet-cap" : "dhmz-cap" };
}

export async function fetchDirectWeatherCaps(country: "ES" | "HR", context: IngestionContext) {
  const controller = new AbortController();
  const budgetMs = Math.min(8_000, (context.deadlineAt ?? Date.now() + 8_000) - Date.now());
  if (budgetMs < 1000) throw new Error("Insufficient direct CAP deadline");
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const deadline = Date.now() + budgetMs;
  const finish = (records: ReturnType<typeof parseDirectWeatherCap>[], updatedAt: string) => {
    if (Date.now() >= deadline || controller.signal.aborted) throw new Error("Direct CAP deadline exhausted");
    if (context.now.getTime() - Date.parse(updatedAt) > 24 * 3_600_000) throw new Error("Direct CAP state is stale");
    if (country === "HR" && records.some((record) => context.now.getTime() - record.sent > 24 * 3_600_000)) throw new Error("DHMZ daily document is stale");
    recordSourceDiagnostics(context, { recordsExamined: records.length });
    return combineDirectWeatherCaps(records, country, updatedAt);
  };
  const byteBudget = { remaining: country === "ES" ? 1536 * 1024 : 1024 * 1024 };
  const request = (url: string, maxBytes: number) => fetchAllowlisted(context.fetch, url,
    country === "ES" ? ["www.aemet.es"] : ["meteo.hr"], 1,
    { maxBytes, byteBudget, signal: controller.signal, timeoutMs: 4000, diagnosticsCategory: country === "ES" ? "aemet_cap" : "dhmz_cap" });
  try {
    if (country === "HR") {
      const records = [];
      for (const day of ["today", "tomorrow"]) {
        const response = await request(`https://meteo.hr/upozorenja/cap_hr_${day}.xml`, 512 * 1024);
        records.push(parseDirectWeatherCap(await response.text(), country, context));
      }
      return finish(records, new Date(Math.max(...records.map((r) => r.sent))).toISOString());
    }
    const response = await request("https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_ATOM.xml", 512 * 1024);
    const feed = xmlDocument(await response.text()).feed as Row | undefined;
    if (!feed) throw new Error("AEMET Atom index has no feed");
    const updated = timestamp(feed.updated);
    if (updated > context.now.getTime() + 300_000 || context.now.getTime() - updated > 24 * 3_600_000) throw new Error("AEMET index timestamp is stale or future");
    const links = array(array(feed.entry)[0]?.link).map((l) => text(l["@_href"]));
    const url = links.find((l) => /^https:\/\/www\.aemet\.es\/documentos_d\/eltiempo\/prediccion\/avisos\/cap\/Z_CAP_C_LEMM_\d{14}_AFAE\.tar\.gz$/.test(l));
    if (!url) throw new Error("AEMET index has no approved complete-state archive");
    const archive = await request(url, 1024 * 1024);
    const records = readCapArchive(new Uint8Array(await archive.arrayBuffer())).map(({ xml }) => parseDirectWeatherCap(xml, country, context));
    if (records.some((r) => r.sent > updated + 300_000)) throw new Error("AEMET archive is newer than its index");
    return finish(records, new Date(updated).toISOString());
  } finally { clearTimeout(timer); }
}
