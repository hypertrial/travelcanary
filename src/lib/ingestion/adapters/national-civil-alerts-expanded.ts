import { XMLParser } from "fast-xml-parser";
import { polygon } from "@turf/helpers";
import type { HazardLevel, HazardType, NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted, mapConcurrent, readJsonWithLimit } from "../fetch";
import { eventCopy, weatherHazard } from "../templates";
import type { IngestionContext } from "../types";
import type { NationalPartition } from "./national-civil-alerts-shared";

type Row = Record<string, unknown>;
type Position = [number, number];
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const rows = (value: unknown): Row[] => value === undefined ? [] : (Array.isArray(value) ? value : [value]) as Row[];
const norwayIds = (context: IngestionContext) => context.locations.filter(({ countryCode }) => countryCode === "NO").map(({ id }) => id);
const englandIds = new Set(["gb-bath", "gb-birmingham", "gb-brighton", "gb-cambridge", "gb-exeter", "gb-lake-district-national-park", "gb-leeds", "gb-liverpool", "gb-london", "gb-manchester", "gb-newcastle-upon-tyne", "gb-oxford", "gb-plymouth", "gb-portsmouth", "gb-york"]);

function timestamp(value: unknown, options: { norwayLocal?: boolean } = {}) {
  const raw = text(value);
  if (!raw) throw new Error("Warning timestamp is missing");
  if (/(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(raw)) {
    const parsed = Date.parse(raw); if (Number.isFinite(parsed)) return parsed;
    throw new Error("Warning timestamp is invalid");
  }
  if (!options.norwayLocal) throw new Error("Warning timestamp has no UTC offset");
  const iso = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,7}))?)?$/.exec(raw);
  const nve = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,7}))?)?$/.exec(raw);
  if (!iso && !nve) throw new Error("Warning timestamp has no UTC offset");
  const [year, month, day, hour, minute, second] = iso
    ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6] || "0"].map(Number)
    : [nve![3], nve![2], nve![1], nve![4], nve![5], nve![6] || "0"].map(Number);
  const milliseconds = Number(`0.${iso?.[7] || nve?.[7] || "0"}`) * 1000;
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) {
    throw new Error("Warning timestamp is invalid");
  }
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const local = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const candidates = [60, 120].map((offset) => local - offset * 60_000).filter((utc) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
    return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute && parts.second === second;
  });
  if (candidates.length !== 1) throw new Error("Warning timestamp is invalid");
  return candidates[0];
}

function ring(value: unknown): Position[] {
  if (!Array.isArray(value) || value.length < 4 || value.length > 2_000) throw new Error("Warning polygon ring has an invalid point count");
  const result = value.map((point) => {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) throw new Error("Warning polygon coordinate is invalid");
    const coordinate: Position = [Number(point[0]), Number(point[1])];
    if (Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) throw new Error("Warning polygon coordinate is out of range");
    return coordinate;
  });
  if (result[0][0] !== result.at(-1)![0] || result[0][1] !== result.at(-1)![1]) throw new Error("Warning polygon is not closed");
  polygon([result]);
  return result;
}

function polygonRings(geometry: unknown): Position[][][] {
  const value = geometry as { type?: unknown; coordinates?: unknown };
  const result = value?.type === "Polygon" && Array.isArray(value.coordinates) ? [(value.coordinates as unknown[]).map(ring)]
    : value?.type === "MultiPolygon" && Array.isArray(value.coordinates) ? (value.coordinates as unknown[]).map((part) => {
    if (!Array.isArray(part)) throw new Error("Warning multipolygon is malformed");
    return part.map(ring);
    }) : null;
  if (!result) throw new Error("Warning geometry must be Polygon or MultiPolygon");
  const allRings = result.flat();
  if (allRings.length > 64 || allRings.reduce((total, item) => total + item.length, 0) > 5_000) throw new Error("Warning geometry exceeds aggregate limits");
  return result;
}

function level(value: unknown): HazardLevel | null {
  const normalized = text(value).toLowerCase();
  if (/extreme|red|danger/.test(normalized)) return "SEVERE";
  if (/severe|orange|amber|warning/.test(normalized)) return "HIGH";
  if (/moderate|yellow|alert/.test(normalized)) return "ELEVATED";
  return null;
}

function event(options: {
  id: string; type: HazardType; level: HazardLevel; area: string; starts: number; ends: number; updated: number;
  geometry: NormalizedEvent["geometry"]; sourceName: string; sourceUrl: string; context: IngestionContext;
}): NormalizedEvent {
  const copy = eventCopy(options.type, options.level, options.area, options.starts > options.context.now.getTime());
  return {
    id: options.id, sourceId: "national-civil-alerts", providerId: "national-civil-alerts", type: options.type, level: options.level,
    timing: options.starts > options.context.now.getTime() ? "UPCOMING" : "ACTIVE", ...copy, affectedArea: options.area.slice(0, 200),
    geometry: options.geometry, startsAt: new Date(options.starts).toISOString(), endsAt: new Date(options.ends).toISOString(),
    sourceUpdatedAt: new Date(options.updated).toISOString(), checkedAt: options.context.now.toISOString(), expiresAt: new Date(options.ends).toISOString(),
    sourceName: options.sourceName, sourceUrl: options.sourceUrl, confidence: "HIGH",
  };
}

const metNorwayHazards: Record<string, HazardType> = {
  blowingsnow: "snow-ice", forestfire: "fire-danger", gale: "severe-weather", ice: "snow-ice", icing: "snow-ice",
  lightning: "severe-weather", polarlow: "severe-weather", rain: "severe-weather", rainflood: "flood", snow: "snow-ice",
  stormsurge: "coastal", wind: "severe-weather",
};

function capReferenceIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => text(item).split(/\s+/)).map((reference) => {
    const parts = reference.split(",");
    return (parts.length >= 2 ? parts[1] : parts[0]).trim();
  }).filter(Boolean);
}

export function parseMetNorway(value: unknown, context: IngestionContext): NationalPartition {
  const document = value as { type?: unknown; features?: unknown };
  if (document?.type !== "FeatureCollection" || !Array.isArray(document.features) || document.features.length > 500) throw new Error("MET Norway response is not a bounded FeatureCollection");
  const events: NormalizedEvent[] = [];
  const superseded = new Set<string>();
  let invalid = 0;
  for (const raw of document.features as Row[]) {
    const properties = raw.properties as Row | undefined;
    try {
      if (!properties || text(properties.status || "Actual") !== "Actual") continue;
      const domain = text(properties.geographicDomain || properties.geographic_domain).toLowerCase();
      if (domain && !/land|coast/.test(domain)) continue;
      const lifecycle = text(properties.msgType || properties.messageType || properties.type || "Alert").toLowerCase();
      for (const reference of capReferenceIds(properties.references || properties.reference)) superseded.add(reference);
      const identifier = text(properties.id || properties.identifier || raw.id);
      if (lifecycle === "cancel") { if (identifier) superseded.add(identifier); continue; }
      const type = metNorwayHazards[text(properties.event || properties.awareness_type || properties.eventCode).toLowerCase().replace(/[^a-z]/g, "")];
      const hazardLevel = level(properties.severity || properties.awareness_level);
      const interval = (raw.when as Row | undefined)?.interval;
      const intervalValues = Array.isArray(interval) ? interval : [];
      const starts = timestamp(properties.onset || properties.effective || properties.sent || intervalValues[0]);
      const ends = timestamp(properties.expires || properties.eventEndingTime || intervalValues[1]);
      const updated = timestamp(properties.sent || properties.updated || properties.effective || intervalValues[0]);
      if (!identifier || !type || !hazardLevel || starts >= ends || ends <= context.now.getTime() || starts >= context.now.getTime() + 86_400_000) throw new Error("MET Norway warning fields are invalid");
      for (const [index, coordinates] of polygonRings(raw.geometry).entries()) events.push(event({
        id: `national:met-no:${identifier}:${index}`, type, level: hazardLevel, area: text(properties.area || properties.areaDesc || "Norway"),
        starts, ends, updated, geometry: { kind: "polygon", coordinates }, sourceName: "MET Norway",
        sourceUrl: "https://www.met.no/en/weather-and-climate/text-forecast-and-warnings", context,
      }));
    } catch { invalid += 1; }
  }
  const ids = norwayIds(context);
  return {
    status: invalid ? "partial" : "ok", sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events, error: invalid ? `${invalid} MET Norway warnings were rejected` : null, limitationCode: invalid ? "malformed_warning_records" : undefined,
    checkedLocationIds: invalid ? [] : ids, unavailableLocationIds: invalid ? ids : [],
    removedEventPrefixes: invalid ? [...superseded].map((id) => `national:met-no:${id}:`) : ["national:met-no:"],
  };
}

const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nveMunicipalities: Record<string, string[]> = {
  "no-alta": ["Alta"], "no-bergen": ["Bergen"], "no-bodo": ["Bodø"], "no-flam": ["Aurland"], "no-geilo": ["Hol"],
  "no-geiranger": ["Stranda"], "no-jotunheimen-national-park": ["Lom", "Vågå", "Vang", "Årdal", "Luster"],
  "no-kirkenes": ["Sør-Varanger"], "no-kristiansand": ["Kristiansand"], "no-lillehammer": ["Lillehammer"],
  "no-lofoten": ["Vågan", "Vestvågøy", "Moskenes", "Flakstad"], "no-narvik": ["Narvik"], "no-oslo": ["Oslo"],
  "no-stavanger": ["Stavanger"], "no-svolvaer": ["Vågan"], "no-tromso": ["Tromsø"], "no-trondheim": ["Trondheim"],
  "no-voss": ["Voss"], "no-alesund": ["Ålesund"], "no-andalsnes": ["Rauma"],
};

export function parseNveWarnings(value: unknown, context: IngestionContext): NationalPartition {
  const records = Array.isArray(value) ? value : Array.isArray((value as { items?: unknown })?.items) ? (value as { items: unknown[] }).items : null;
  if (!records || records.length > 500) throw new Error("NVE response is not a bounded warning list");
  const latest = new Map<string, Row>();
  for (const raw of records as Row[]) {
    const capStatus = text(raw.CapStatus || raw.capStatus);
    if (capStatus && capStatus.toLowerCase() !== "actual") continue;
    const id = text(raw.MasterId || raw.masterId || raw.Id || raw.id || raw.WarningId || raw.warningId);
    if (!id) throw new Error("NVE warning has no stable identity");
    const prior = latest.get(id); const version = Number(raw.Version ?? raw.version ?? 0);
    if (!Number.isFinite(version) || version < 0) throw new Error("NVE warning version is invalid");
    const updated = timestamp(raw.LastUpdated || raw.lastUpdated || raw.PublishTime || raw.publishTime, { norwayLocal: true });
    const priorVersion = prior ? Number(prior.Version ?? prior.version ?? 0) : -Infinity;
    const priorUpdated = prior ? timestamp(prior.LastUpdated || prior.lastUpdated || prior.PublishTime || prior.publishTime, { norwayLocal: true }) : -Infinity;
    if (version > priorVersion || (version === priorVersion && updated >= priorUpdated)) latest.set(id, raw);
  }
  const events: NormalizedEvent[] = [];
  const unavailable = new Set<string>();
  let unmapped = false;
  for (const [id, raw] of latest) {
    const activity = Number(raw.ActivityLevel ?? raw.activityLevel ?? raw.WarningLevel ?? raw.warningLevel);
    const names = rows(raw.MunicipalityList || raw.municipalityList || raw.Municipalities || raw.municipalities)
      .map((item) => normalize(text(item.Name || item.name || item.MunicipalityName || item))).filter(Boolean);
    const matched = context.locations.filter((location) => location.countryCode === "NO"
      && (nveMunicipalities[location.id] || []).map(normalize).some((municipality) => names.includes(municipality)));
    if (!names.length) { unmapped = true; norwayIds(context).forEach((locationId) => unavailable.add(locationId)); }
    else if (!matched.length) continue;
    if (activity === 0) { matched.forEach(({ id: locationId }) => unavailable.add(locationId)); continue; }
    if (![1, 2, 3, 4].includes(activity)) throw new Error("NVE warning has an unsupported activity level");
    if (!matched.length) continue;
    const starts = timestamp(raw.ValidFrom || raw.validFrom || raw.PublishTime || raw.publishTime, { norwayLocal: true });
    const ends = timestamp(raw.ValidTo || raw.validTo, { norwayLocal: true });
    const updated = timestamp(raw.LastUpdated || raw.lastUpdated || raw.PublishTime || raw.publishTime, { norwayLocal: true });
    if (starts >= ends || ends <= context.now.getTime() || starts >= context.now.getTime() + 86_400_000) continue;
    events.push(event({ id: `national:nve:${id}`, type: "flood", level: activity >= 4 ? "SEVERE" : activity === 3 ? "HIGH" : "ELEVATED",
      area: text(raw.MainText || raw.mainText || raw.WarningText || "Norwegian flood-warning area"), starts, ends, updated,
      geometry: { kind: "locations", ids: matched.map(({ id: locationId }) => locationId) }, sourceName: "NVE",
      sourceUrl: "https://www.varsom.no/en/flood-and-landslide-warning-service/", context }));
  }
  const all = norwayIds(context); const checked = all.filter((id) => !unavailable.has(id));
  return { status: unavailable.size ? "partial" : "ok", sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events, error: unavailable.size ? unmapped ? "NVE warning municipalities could not be mapped completely" : "NVE activity level 0 was retained as unavailable, not interpreted as all-clear" : null,
    limitationCode: unavailable.size ? unmapped ? "municipality_mapping_unavailable" : "unassessed_activity_level" : undefined, checkedLocationIds: checked, unavailableLocationIds: [...unavailable],
    removedEventPrefixes: unavailable.size ? [] : ["national:nve:"] };
}

type EaWarning = Row;
const eaFloodAreaGeometryCache = new Map<string, unknown>();
const MAX_EA_FLOOD_AREA_GEOMETRIES = 64;
const MAX_EA_FLOOD_EVENTS = 500;

function retainedEaGeometry(id: string, context: IngestionContext) {
  const frozen = context.state?.frozenEaFloodAreaGeometries[id];
  if (frozen?.length) return { type: "MultiPolygon", coordinates: frozen.map(({ coordinates }) => coordinates) };
  const coordinates = (context.state?.events || []).filter((item) => item.sourceId === "national-civil-alerts"
    && item.transportId === "ea-flood" && item.id.startsWith(`national:ea-flood:${id}:`) && item.geometry.kind === "polygon")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => item.geometry.kind === "polygon" ? item.geometry.coordinates : []);
  return coordinates.length ? { type: "MultiPolygon", coordinates } : null;
}

export function parseEaFloodWarnings(value: unknown, geometries: ReadonlyMap<string, unknown>, context: IngestionContext): NationalPartition {
  const records = Array.isArray((value as { items?: unknown })?.items) ? (value as { items: EaWarning[] }).items : null;
  if (!records || records.length > 2_000) throw new Error("Environment Agency response is not a bounded warning list");
  const events: NormalizedEvent[] = [];
  const missingGeometry = new Set<string>();
  const withdrawn = new Set<string>();
  for (const raw of records) {
    const id = text(raw.floodAreaID || raw.id || raw["@id"]?.toString().split("/").at(-1));
    const severity = Number(raw.severityLevel);
    if (!id || ![1, 2, 3, 4].includes(severity)) throw new Error("Environment Agency warning identity or severity is invalid");
    if (severity === 4) { withdrawn.add(id); continue; }
    const geometry = geometries.get(id);
    if (!geometry) { missingGeometry.add(id); continue; }
    const starts = timestamp(raw.timeRaised || raw.timeSeverityChanged);
    const updated = timestamp(raw.timeMessageChanged || raw.timeSeverityChanged || raw.timeRaised);
    const ends = context.now.getTime() + 30 * 60_000;
    for (const [index, coordinates] of polygonRings(geometry).entries()) events.push(event({ id: `national:ea-flood:${id}:${index}`, type: "flood",
      level: severity === 1 ? "SEVERE" : severity === 2 ? "HIGH" : "ELEVATED", area: text(raw.description || raw.eaAreaName || "England flood area"),
      starts, ends, updated, geometry: { kind: "polygon", coordinates }, sourceName: "Environment Agency",
      sourceUrl: "https://check-for-flooding.service.gov.uk/", context }));
  }
  const ids = context.locations.filter(({ id }) => englandIds.has(id)).map(({ id }) => id);
  const limited = events.length > MAX_EA_FLOOD_EVENTS;
  const partial = missingGeometry.size > 0 || limited;
  const boundedEvents = events.sort((left, right) => left.id.localeCompare(right.id)).slice(0, MAX_EA_FLOOD_EVENTS);
  return { status: partial ? "partial" : "ok", sourceUpdatedAt: boundedEvents.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events: boundedEvents, error: missingGeometry.size ? `${missingGeometry.size} active flood areas had no valid geometry`
      : limited ? `Environment Agency warning event limit of ${MAX_EA_FLOOD_EVENTS} was reached` : null,
    limitationCode: missingGeometry.size ? "flood_area_geometry_unavailable" : limited ? "warning_event_limit_reached" : undefined,
    checkedLocationIds: partial ? [] : ids,
    unavailableLocationIds: partial ? ids : [], removedEventPrefixes: partial
      ? [...withdrawn].map((id) => `national:ea-flood:${id}:`) : ["national:ea-flood:"] };
}

async function fetchEaPages(context: IngestionContext) {
  const all: EaWarning[] = []; const limit = 500;
  for (let page = 0; page < 4; page += 1) {
    const response = await fetchAllowlisted(context.fetch, `https://environment.data.gov.uk/flood-monitoring/id/floods?_limit=${limit}&_offset=${page * limit}`,
      ["environment.data.gov.uk"], 2, { signal: context.signal, maxBytes: 2 * 1024 * 1024, timeoutMs: 5_000, diagnosticsCategory: "ea_floods" });
    const payload = await readJsonWithLimit(response, 2 * 1024 * 1024) as { items?: unknown };
    if (!Array.isArray(payload.items)) throw new Error("Environment Agency page has no items");
    all.push(...payload.items as EaWarning[]);
    if (payload.items.length < limit) return all;
  }
  throw new Error("Environment Agency pagination exceeded four pages");
}

export async function fetchEaFloodWarnings(context: IngestionContext): Promise<NationalPartition> {
  const warnings = await fetchEaPages(context);
  const activeIds = [...new Set(warnings.filter((warning) => Number(warning.severityLevel) !== 4).map((warning) => text(warning.floodAreaID)).filter(Boolean))];
  const geometries = new Map<string, unknown>(activeIds.flatMap((id) => {
    const geometry = eaFloodAreaGeometryCache.get(id) || retainedEaGeometry(id, context);
    return geometry ? [[id, geometry] as const] : [];
  }));
  await mapConcurrent(activeIds.filter((id) => !geometries.has(id)), 8, async (id) => {
    if (context.signal?.aborted) return;
    try {
      const response = await fetchAllowlisted(context.fetch, `https://environment.data.gov.uk/flood-monitoring/id/floodAreas/${encodeURIComponent(id)}/polygon`,
        ["environment.data.gov.uk"], 2, { signal: context.signal, maxBytes: 512 * 1024, timeoutMs: 4_000, diagnosticsCategory: "ea_polygon" });
      const payload = await readJsonWithLimit(response, 512 * 1024) as Row;
      const geometry = payload.type === "Feature" ? payload.geometry : payload.items && typeof payload.items === "object" ? (payload.items as Row).geometry || payload.items : payload;
      polygonRings(geometry);
      if (eaFloodAreaGeometryCache.size >= MAX_EA_FLOOD_AREA_GEOMETRIES) eaFloodAreaGeometryCache.clear();
      eaFloodAreaGeometryCache.set(id, structuredClone(geometry));
      geometries.set(id, geometry);
    } catch { /* Missing geometry is reported as partial without discarding other areas. */ }
  });
  const frozen = [...geometries].sort(([left], [right]) => left.localeCompare(right)).slice(0, 100);
  return { ...parseEaFloodWarnings({ items: warnings }, geometries, context),
    frozenEaFloodAreaGeometries: Object.fromEntries(frozen.map(([id, geometry]) => [id,
      polygonRings(geometry).map((coordinates) => ({ kind: "polygon" as const, coordinates }))])),
  };
}

export async function fetchMetNorway(context: IngestionContext) {
  const response = await fetchAllowlisted(context.fetch, "https://api.met.no/weatherapi/metalerts/2.0/current.json", ["api.met.no"], 2,
    { maxBytes: 2 * 1024 * 1024, timeoutMs: 5_000, diagnosticsCategory: "met_norway" });
  return parseMetNorway(await readJsonWithLimit(response, 2 * 1024 * 1024), context);
}

export async function fetchNve(context: IngestionContext) {
  const start = context.now.toISOString().slice(0, 10); const end = new Date(context.now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const response = await fetchAllowlisted(context.fetch, `https://api01.nve.no/hydrology/forecast/flood/v1.0.10/api/Warning/2/${start}/${end}`,
    ["api01.nve.no"], 2, { maxBytes: 2 * 1024 * 1024, timeoutMs: 5_000, diagnosticsCategory: "nve_flood" });
  return parseNveWarnings(await readJsonWithLimit(response, 2 * 1024 * 1024), context);
}

function credentialBase(value: string | undefined, suffix: string) {
  if (!value) throw new Error("credential_not_configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix)) || url.username || url.password) throw new Error("configured_endpoint_not_allowlisted");
  return url;
}

export async function fetchMetOffice(context: IngestionContext): Promise<NationalPartition> {
  const key = process.env.MET_OFFICE_API_KEY; const base = credentialBase(process.env.MET_OFFICE_WARNINGS_FEED_URL, ".metoffice.gov.uk");
  if (!key) throw new Error("credential_not_configured");
  const response = await fetchAllowlisted(context.fetch, base.toString(), [base.hostname], 1, { maxBytes: 512 * 1024, timeoutMs: 4_000,
    diagnosticsCategory: "met_office_feed", headers: { "x-api-key": key } });
  const feed = (parser.parse(await response.text()) as { feed?: Row }).feed;
  const feedUpdated = timestamp(feed?.updated);
  const responseAge = Number(response.headers.get("age") || "0");
  if (feedUpdated > context.now.getTime() + 5 * 60_000 || !Number.isFinite(responseAge) || responseAge > 20 * 60) {
    throw new Error("Met Office warning feed is stale or future-dated");
  }
  const links = rows(feed?.link); const related = text(links.find((link) => text(link["@_rel"]) === "related")?.["@_href"]);
  const relatedUrl = new URL(related);
  if (relatedUrl.origin !== base.origin || !/^\/v1\.0\/objects\/issued\//.test(relatedUrl.pathname)) throw new Error("Met Office feed link is not allowlisted");
  const detail = await fetchAllowlisted(context.fetch, relatedUrl.toString(), [base.hostname], 1, { maxBytes: 2 * 1024 * 1024, timeoutMs: 4_000,
    diagnosticsCategory: "met_office_warnings", headers: { "x-api-key": key } });
  const document = await readJsonWithLimit(detail, 2 * 1024 * 1024) as { features?: Row[] };
  if (!Array.isArray(document.features) || document.features.length > 500) throw new Error("Met Office warning response is malformed");
  const events: NormalizedEvent[] = [];
  let limited = false;
  const features = document.features.slice().sort((left, right) => {
    const leftProperties = left.properties as Row | undefined; const rightProperties = right.properties as Row | undefined;
    return text(leftProperties?.warningId || leftProperties?.id || left.id).localeCompare(text(rightProperties?.warningId || rightProperties?.id || right.id));
  });
  for (const feature of features) {
    const properties = feature.properties as Row; const state = text(properties.warningStatus || properties.state || properties.status).toUpperCase();
    if (!["ISSUED", "UPDATED", "CANCELLED", "EXPIRED"].includes(state)) throw new Error("Met Office warning lifecycle is invalid");
    if (["CANCELLED", "EXPIRED"].includes(state)) continue;
    const starts = timestamp(properties.validFromDate || properties.validFrom || properties.onset);
    const ends = timestamp(properties.validToDate || properties.validTo || properties.expires);
    const updated = timestamp(properties.modifiedDate || properties.modified || properties.updated || properties.issuedAt);
    const hazardLevel = level(properties.warningLevel || properties.severity || properties.impact);
    const id = text(properties.warningId || properties.id || feature.id);
    const types = rows(properties.weatherType || properties.warningType || properties.event).map(text).filter(Boolean);
    if (!id || !hazardLevel || !types.length || starts >= ends) throw new Error("Met Office warning fields are invalid");
    const hazards = [...new Set(types.map(weatherHazard))].sort();
    for (const hazard of hazards) for (const [index, coordinates] of polygonRings(feature.geometry).entries()) {
      if (events.length >= 500) { limited = true; continue; }
      events.push(event({ id: `national:met-office:${id}:${hazard}:${index}`, type: hazard, level: hazardLevel,
        area: text(properties.headline || properties.area || "United Kingdom warning area"), starts, ends, updated,
        geometry: { kind: "polygon", coordinates }, sourceName: "Met Office", sourceUrl: "https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings", context }));
    }
  }
  const ids = context.locations.filter(({ countryCode }) => countryCode === "GB").map(({ id }) => id);
  return { status: limited ? "partial" : "ok", sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || new Date(feedUpdated).toISOString(), events,
    error: limited ? "Met Office warning event limit of 500 was reached" : null,
    limitationCode: limited ? "warning_event_limit_reached" : undefined, checkedLocationIds: limited ? [] : ids,
    unavailableLocationIds: limited ? ids : [], removedEventPrefixes: limited ? [] : ["national:met-office:"] };
}

export async function fetchNrw(context: IngestionContext): Promise<NationalPartition> {
  const key = process.env.NRW_FLOOD_API_KEY; const base = credentialBase(process.env.NRW_FLOOD_API_BASE_URL, ".naturalresources.wales");
  if (!key) throw new Error("credential_not_configured");
  const response = await fetchAllowlisted(context.fetch, base.toString(), [base.hostname], 1, { maxBytes: 2 * 1024 * 1024, timeoutMs: 4_000,
    diagnosticsCategory: "nrw_flood", headers: { "Ocp-Apim-Subscription-Key": key } });
  const document = await readJsonWithLimit(response, 2 * 1024 * 1024) as { features?: Row[] };
  if (!Array.isArray(document.features) || document.features.length > 500) throw new Error("NRW warning response is malformed");
  const events: NormalizedEvent[] = [];
  for (const feature of document.features) {
    const properties = feature.properties as Row; const severity = Number(properties.severityLevel || properties.severity);
    if (severity === 4) continue;
    if (![1, 2, 3].includes(severity)) throw new Error("NRW warning severity is invalid");
    const id = text(properties.id || properties.floodAreaID || feature.id); const updated = timestamp(properties.updated || properties.timeMessageChanged || properties.timeRaised);
    for (const [index, coordinates] of polygonRings(feature.geometry).entries()) events.push(event({ id: `national:nrw:${id}:${index}`, type: "flood",
      level: severity === 1 ? "SEVERE" : severity === 2 ? "HIGH" : "ELEVATED", area: text(properties.description || properties.area || "Wales flood area"),
      starts: updated, ends: context.now.getTime() + 30 * 60_000, updated, geometry: { kind: "polygon", coordinates }, sourceName: "Natural Resources Wales",
      sourceUrl: "https://naturalresources.wales/flooding/check-flood-warnings/?lang=en", context }));
  }
  const ids = context.locations.filter(({ id }) => ["gb-cardiff", "gb-eryri-national-park", "gb-pembrokeshire-coast-national-park", "gb-swansea"].includes(id)).map(({ id }) => id);
  return { status: "ok", sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(), events,
    error: null, checkedLocationIds: ids, unavailableLocationIds: [], removedEventPrefixes: ["national:nrw:"] };
}

export function expandedNationalFetcher(id: string) {
  return id === "met-norway-alerts" ? fetchMetNorway : id === "nve-flood" ? fetchNve : id === "ea-flood" ? fetchEaFloodWarnings
    : id === "met-office-nswws" ? fetchMetOffice : id === "nrw-flood" ? fetchNrw : null;
}

export function optionalCredentialConfigured(id: string, credentialEnvVar?: string | null) {
  if (id === "met-office-nswws") return Boolean(process.env.MET_OFFICE_API_KEY && process.env.MET_OFFICE_WARNINGS_FEED_URL);
  if (id === "nrw-flood") return Boolean(process.env.NRW_FLOOD_API_KEY && process.env.NRW_FLOOD_API_BASE_URL);
  return !credentialEnvVar || Boolean(process.env[credentialEnvVar]);
}
