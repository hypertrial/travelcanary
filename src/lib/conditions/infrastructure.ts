import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import booleanIntersects from "@turf/boolean-intersects";
import { lineString, point, polygon } from "@turf/helpers";
import { z } from "zod";
import { locations } from "../data";
import { locationPolygon } from "../geospatial";
import { InfrastructureIncidentSchema, SystemConditionSchema, type InfrastructureIncident, type LocationConditions, type SystemCondition } from "../domain/conditions";
import { isAllowlistedHttpsUrl } from "../ingestion/fetch";
import { autobahnLocationsByRoad, infrastructureMapping, swedenLocationsByCounty } from "./infrastructure-mapping";

type InfrastructureResult = { locations: Record<string, InfrastructureIncident[]>; overflow: number };
const infrastructureCountries = ["FI", "SE", "NL", "DE", "CY", "MT"];
const emptyCountry = (country: string): Record<string, InfrastructureIncident[]> => Object.fromEntries(locations.filter((item) => item.countryCode === country).map(({ id }) => [id, []]));
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const iso = (value: unknown) => {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) throw new Error("Invalid infrastructure timestamp");
  return new Date(time).toISOString();
};
const isoUtc = (value: unknown) => {
  const text = String(value || "").trim();
  return iso(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
};
const hash = (...values: unknown[]) => createHash("sha256").update(values.map(String).join("\0")).digest("hex").slice(0, 24);
const priority: Record<InfrastructureIncident["kind"], number> = { "power-outage": 0, "water-supply-disruption": 1, "telecom-disruption": 2, "rail-disruption": 3, "district-heating-disruption": 4, "road-closure": 5, "road-disruption": 6 };
export function rankInfrastructure(result: Record<string, InfrastructureIncident[]>) {
  let overflow = 0;
  for (const id of Object.keys(result)) {
    result[id] = [...new Map(result[id].map((item) => [`${item.sourceId}:${item.id}`, item])).values()].sort((a, b) =>
      (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || priority[a.kind] - priority[b.kind]
      || Date.parse(a.startsAt) - Date.parse(b.startsAt) || Date.parse(b.sourceUpdatedAt || b.checkedAt) - Date.parse(a.sourceUpdatedAt || a.checkedAt) || a.id.localeCompare(b.id));
    overflow += Math.max(0, result[id].length - 3); result[id] = result[id].slice(0, 3);
  }
  return overflow;
}
function incident(input: z.input<typeof InfrastructureIncidentSchema>) { return InfrastructureIncidentSchema.parse(input); }
function currentExpiry(now: Date, end: string | null, hours = 2) { return new Date(Math.min(now.getTime() + hours * 3600000, end ? Date.parse(end) : Infinity)).toISOString(); }
function matchesFeature(country: string, feature: Parameters<typeof booleanIntersects>[0]) {
  return locations.filter((item) => item.countryCode === country && booleanIntersects(feature, locationPolygon(item)));
}

const krisKind = (text: string): InfrastructureIncident["kind"] | null => {
  const value = normalize(text);
  if (/\b(stromavbrott|elavbrott|power outage|electricity outage)\b/.test(value)) return "power-outage";
  if (/\b(drinksvatten|vattenleverans|vattenavbrott|begransad vattentillgang|water supply|boil water)\b/.test(value)) return "water-supply-disruption";
  if (/\b(telestorning|telefoni|telecom|mobile network)\b/.test(value)) return "telecom-disruption";
  if (/\b(tagtrafik|jarnvag|rail disruption|train disruption)\b/.test(value)) return "rail-disruption";
  if (/\b(avstangd vag|vag avstangd|road closed|transport disruption)\b/.test(value)) return "road-disruption";
  return null;
};
const excludedKris = /\b(test|ovning|exercise|historik|historical|aterstalld|avslutad|resolved|installt|cancelled|beredskap|prepare|galler inte langre|faran ar over)\b/;
export function parseKrisinformationInfrastructure(value: unknown, now: Date): InfrastructureResult {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Krisinformation infrastructure response is invalid");
  const result = emptyCountry("SE"); let parseable = 0;
  for (const raw of value) {
    const record = z.object({ Identifier: z.union([z.string(), z.number()]), Updated: z.string().optional(), Published: z.string(), Headline: z.string(), Preamble: z.string().optional(), BodyText: z.string().optional(), Web: z.string().url(), IsTest: z.boolean().optional(), Area: z.array(z.object({ Name: z.string().optional(), County: z.string().optional(), Description: z.string().optional() }).passthrough()).optional() }).passthrough().safeParse(raw);
    if (!record.success) continue;
    parseable += 1; const item = record.data; if (item.IsTest) continue;
    if (!isAllowlistedHttpsUrl(item.Web, ["krisinformation.se", "www.krisinformation.se"])) continue;
    const text = `${item.Headline} ${item.Preamble || ""} ${item.BodyText || ""}`; const normalized = normalize(text);
    if (excludedKris.test(normalized) || /\b(vma|viktigt meddelande|weather warning|vadervarning)\b/.test(normalized)) continue;
    const kind = krisKind(text); if (!kind) continue;
    const published = Date.parse(item.Published); const updated = Date.parse(item.Updated || item.Published);
    if (!Number.isFinite(published) || !Number.isFinite(updated) || published > now.getTime() + 300000
      || updated > now.getTime() + 300000 || now.getTime() - updated > 6 * 3600000) continue;
    const names = (item.Area || []).flatMap((area) => [area.Name, area.County, area.Description]).filter((name): name is string => Boolean(name)).map(normalize);
    const national = names.some((name) => /^(sweden|sverige|hela landet)$/.test(name));
    const reviewedCountyIds = new Set(names.flatMap((name) => swedenLocationsByCounty.get(name) || []));
    const matched = locations.filter((location) => location.countryCode === "SE" && (national || reviewedCountyIds.has(location.id)
      || location.sourceRegionCodes.meteoalarm.some((code) => code.startsWith("area:") && names.includes(normalize(code.slice(5))))));
    for (const location of matched) {
      const county = [...swedenLocationsByCounty].find(([name, ids]) => names.includes(name) && ids.includes(location.id))?.[0];
      const scopeLabel = county ? county.replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/ Lan$/, " Län") : "Reviewed Swedish region";
      result[location.id].push(incident({ id: `kris:${String(item.Identifier)}`, sourceId: "krisinformation-infrastructure", sourceUpdatedAt: new Date(updated).toISOString(), checkedAt: now.toISOString(), expiresAt: new Date(updated + 6 * 3600000).toISOString(), kind, status: "active", scope: national ? "country" : "region", scopeLabel: national ? "Sweden" : scopeLabel, startsAt: new Date(published).toISOString(), endsAt: null, estimatedRestorationAt: null, sourceUrl: item.Web }));
    }
  }
  if (value.length && !parseable) throw new Error("Krisinformation response contains no parseable records");
  return { locations: result, overflow: rankInfrastructure(result) };
}

const pointFromAutobahn = (item: Record<string, unknown>) => {
  const coordinate = item.coordinate as Record<string, unknown> | undefined;
  const lat = Number(coordinate?.lat ?? coordinate?.latitude); const lon = Number(coordinate?.long ?? coordinate?.lon ?? coordinate?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Invalid Autobahn coordinate");
  return point([lon, lat]);
};
export function parseAutobahnInfrastructure(value: unknown, roadId: string, kind: "closure" | "warning", now: Date): InfrastructureResult {
  const result = emptyCountry("DE"); const root = z.object({ [kind === "closure" ? "closure" : "warning"]: z.array(z.record(z.string(), z.unknown())).max(200) }).passthrough().parse(value);
  const records = root[kind === "closure" ? "closure" : "warning"]!;
  for (const item of records) {
    const id = String(item.identifier || item.id || "").trim(); if (!id) throw new Error("Autobahn record has no ID");
    const displayType = String(item.display_type || "");
    if (kind === "closure" ? !["CLOSURE", "CLOSURE_ENTRY_EXIT"].includes(displayType) : displayType !== "WARNING" || String(item.isBlocked).toLowerCase() !== "true") continue;
    const explicitUpdated = item.lastUpdate || item.updateTimestamp; const updated = explicitUpdated ? iso(explicitUpdated) : now.toISOString();
    if (Date.parse(updated) > now.getTime() + 300000 || explicitUpdated && now.getTime() - Date.parse(updated) > 86400000) continue;
    if (!item.startTimestamp && !item.start) continue;
    const start = iso(item.startTimestamp || item.start); const rawEnd = item.endTimestamp || item.end; const end = rawEnd ? iso(rawEnd) : null;
    if (Date.parse(start) > now.getTime() + 24 * 3600000 || (end && Date.parse(end) <= now.getTime())) continue;
    if (Date.parse(start) > now.getTime() && !end) continue;
    const rawGeometry = item.geometry as { type?: unknown; coordinates?: unknown } | undefined;
    const feature = rawGeometry?.type === "LineString" && Array.isArray(rawGeometry.coordinates)
      ? lineString(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(2).max(500).parse(rawGeometry.coordinates))
      : rawGeometry?.type === "Point" && Array.isArray(rawGeometry.coordinates)
        ? point(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).parse(rawGeometry.coordinates)) : pointFromAutobahn(item);
    for (const location of matchesFeature("DE", feature).filter(({ id }) => autobahnLocationsByRoad.get(roadId)?.includes(id))) result[location.id].push(incident({ id: `autobahn:${roadId}:${id}`, sourceId: "autobahn-traffic", sourceUpdatedAt: explicitUpdated ? updated : null, checkedAt: now.toISOString(), expiresAt: currentExpiry(now, end), kind: kind === "closure" ? "road-closure" : "road-disruption", status: Date.parse(start) > now.getTime() ? "planned" : "active", scope: "destination", scopeLabel: `${roadId} near ${location.name}`, startsAt: start, endsAt: end, estimatedRestorationAt: null, sourceUrl: `https://www.autobahn.de/verkehr` }));
  }
  return { locations: result, overflow: rankInfrastructure(result) };
}

const allObjects = (value: unknown, output: Record<string, unknown>[] = []) => {
  if (Array.isArray(value)) value.forEach((item) => allObjects(item, output));
  else if (value && typeof value === "object") { output.push(value as Record<string, unknown>); Object.values(value).forEach((item) => allObjects(item, output)); }
  return output;
};
export function parseNdwInfrastructure(xml: string, now: Date): InfrastructureResult {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || xml.length > 6 * 1024 * 1024) throw new Error("Unsupported NDW XML");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid NDW XML");
  const root = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml);
  const version3 = root.messageContainer !== undefined;
  let publication: Record<string, unknown>;
  if (version3) {
    const container = z.object({ "@_modelBaseVersion": z.literal("3"), payload: z.record(z.string(), z.unknown()) }).parse(root.messageContainer);
    publication = container.payload;
    if (publication["@_modelBaseVersion"] !== "3" || !/^(?:[A-Za-z_][\w.-]*:)?SituationPublication$/.test(String(publication["@_type"]))) throw new Error("Invalid NDW v3 publication");
    const published = Date.parse(iso(publication.publicationTime));
    if (published > now.getTime() + 300_000 || now.getTime() - published >= 2 * 3_600_000) throw new Error("Stale NDW v3 publication");
  } else {
    const model = z.object({ d2LogicalModel: z.record(z.string(), z.unknown()) }).parse(root).d2LogicalModel;
    publication = model.payloadPublication === undefined ? model : z.record(z.string(), z.unknown()).parse(model.payloadPublication);
  }
  if (publication.situation === undefined && (!/^(?:[A-Za-z_][\w.-]*:)?SituationPublication$/.test(String(publication["@_type"])) || !publication.publicationTime)) throw new Error("Invalid NDW situation publication");
  const situations = publication.situation === undefined ? [] : Array.isArray(publication.situation) ? publication.situation : [publication.situation];
  const records = situations.flatMap((situation) => {
    const parsed = z.object({ headerInformation: z.object({ informationStatus: z.string(), confidentiality: z.string().optional() }), situationRecord: z.union([
      z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())).min(1),
    ]) }).parse(situation);
    const header = parsed.headerInformation;
    if (String(header.informationStatus || "") !== "real" || version3 && header.confidentiality !== "noRestriction") return [];
    return (Array.isArray(parsed.situationRecord) ? parsed.situationRecord : [parsed.situationRecord]).map((item) => {
      if (typeof item["@_id"] !== "string" || !(item.situationRecordCreationTime || item.situationRecordVersionTime)) throw new Error("Invalid NDW situation record");
      return item;
    });
  });
  if (records.length > 2000) throw new Error("NDW record overflow");
  const result = emptyCountry("NL");
  for (const item of records) {
    const type = String(item["@_xsi:type"] || item["@_type"] || ""); const management = String(item.roadOrCarriagewayOrLaneManagementType || item.trafficConstrictionType || "");
    const closure = ["roadClosed", "carriagewayBlocked", "carriagewayClosures"].includes(management);
    const supportedWarning = String(item.safetyRelatedMessage).toLowerCase() === "true" && /Accident|GeneralObstruction|VehicleObstruction/.test(type);
    if (!closure && !supportedWarning) continue;
    const cause = item.cause as Record<string, unknown> | undefined;
    if (["roadMaintenance", "constructionWork"].includes(String(cause?.causeType || ""))
      || version3 && cause?.causeType === "other" && cause.causeDescription !== undefined
      || allObjects(item.obstructingVehicle).some((object) => object.vehicleType === "constructionOrMaintenanceVehicle")) continue;
    if (String(item.probabilityOfOccurrence || "certain") !== "certain") continue;
    const validity = (item.validity || {}) as Record<string, unknown>; const specification = (validity.validityTimeSpecification || {}) as Record<string, unknown>;
    if (!["active", "definedByValidityTimeSpec"].includes(String(validity.validityStatus || ""))) continue;
    if (version3) {
      if (Object.keys(specification).some((key) => !["overallStartTime", "overallEndTime", "validPeriod"].includes(key))) throw new Error("Unsupported NDW validity schedule");
      for (const period of specification.validPeriod === undefined ? [] : [specification.validPeriod].flat()) {
        const parsed = z.object({ startOfPeriod: z.string(), endOfPeriod: z.string().optional() }).strict().parse(period);
        if (iso(parsed.startOfPeriod) !== iso(specification.overallStartTime)
          || (parsed.endOfPeriod ? iso(parsed.endOfPeriod) : null) !== (specification.overallEndTime ? iso(specification.overallEndTime) : null)) throw new Error("Unsupported NDW validity schedule");
      }
    }
    const start = iso(specification.overallStartTime || item.situationRecordCreationTime); const rawEnd = specification.overallEndTime; const end = rawEnd ? iso(rawEnd) : null;
    const updated = iso(item.situationRecordVersionTime || item.situationRecordCreationTime);
    if (Date.parse(updated) > now.getTime() + 300000 || Date.parse(start) > now.getTime() + 24 * 3600000 || (end && Date.parse(end) <= now.getTime())) continue;
    const coordinate = allObjects(item).find((object) => object.latitude != null && object.longitude != null);
    const positionList = allObjects(item).find((object) => typeof object.posList === "string")?.posList;
    let feature;
    if (coordinate) {
      const lat = Number(coordinate.latitude); const lon = Number(coordinate.longitude); if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      feature = point([lon, lat]);
    } else if (typeof positionList === "string") {
      const values = positionList.trim().split(/\s+/).map(Number); if (values.length < 4 || values.length % 2 || values.some((number) => !Number.isFinite(number))) continue;
      feature = lineString(Array.from({ length: values.length / 2 }, (_, index) => [values[index * 2 + 1], values[index * 2]]));
    } else continue;
    for (const location of matchesFeature("NL", feature)) result[location.id].push(incident({ id: `ndw:${item["@_id"]}`, sourceId: "ndw-traffic", sourceUpdatedAt: updated, checkedAt: now.toISOString(), expiresAt: currentExpiry(now, end), kind: closure ? "road-closure" : "road-disruption", status: Date.parse(start) > now.getTime() ? "planned" : "active", scope: "destination", scopeLabel: `Road near ${location.name}`, startsAt: start, endsAt: end, estimatedRestorationAt: null, sourceUrl: "https://opendata.ndw.nu/" }));
  }
  return { locations: result, overflow: rankInfrastructure(result) };
}

function parseWktFeature(value: string) {
  const numbers = (text: string) => text.trim().split(/\s+/).map(Number);
  if (/^POINT\s*\(/i.test(value)) { const [a, b] = numbers(value.replace(/^POINT\s*\(|\)$/gi, "")); return point(a > 30 ? [b, a] : [a, b]); }
  if (/^LINESTRING\s*\(/i.test(value)) return lineString(value.replace(/^LINESTRING\s*\(|\)$/gi, "").split(",").map((pair) => { const [a, b] = numbers(pair); return a > 30 ? [b, a] : [a, b]; }));
  throw new Error("Unsupported outage geometry");
}
export function parseEnemaltaInfrastructure(currentValue: unknown, plannedValue: unknown, now: Date): InfrastructureResult {
  const current = z.array(z.record(z.string(), z.unknown())).max(200).parse(currentValue); const planned = z.array(z.record(z.string(), z.unknown())).max(200).parse(plannedValue);
  const result = emptyCountry("MT");
  for (const item of current) {
    const geometryText = String(item.PolygonGeometry || "").trim(); if (!geometryText) throw new Error("Enemalta current outage has no geometry");
    const pairs = geometryText.split(",").map((pair) => pair.trim().split(/\s+/).map(Number));
    const geometry = pairs.length >= 3 && pairs.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
      ? polygon([[...pairs.map(([a, b]) => a > 30 ? [b, a] : [a, b]), pairs[0][0] > 30 ? [pairs[0][1], pairs[0][0]] : [pairs[0][0], pairs[0][1]]]]) : parseWktFeature(geometryText);
    if (!item.lastupdated) throw new Error("Enemalta current outage has no update time");
    const updated = iso(item.lastupdated); if (Date.parse(updated) > now.getTime() + 300000) continue;
    const affected = item.AffectedAccountNos == null ? undefined : Number(item.AffectedAccountNos); if (affected != null && (!Number.isInteger(affected) || affected < 0)) throw new Error("Invalid Enemalta customer count");
    for (const location of matchesFeature("MT", geometry)) result[location.id].push(incident({ id: `enemalta:current:${String(item.CaseID || item.id || hash(geometryText, updated))}`, sourceId: "enemalta-power", sourceUpdatedAt: updated, checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 2 * 3600000).toISOString(), kind: "power-outage", status: "active", scope: "destination", scopeLabel: location.name, startsAt: updated, endsAt: null, estimatedRestorationAt: null, affectedCustomers: affected, sourceUrl: "https://www.enemalta.com.mt/planned-power-cuts/" }));
  }
  for (const item of planned) {
    const start = iso(item.StartDate); const end = iso(item.EndDate); if (Date.parse(start) > now.getTime() + 24 * 3600000 || Date.parse(end) <= now.getTime()) continue;
    const transformers = z.array(z.record(z.string(), z.unknown())).max(500).parse(item.Transformers || []);
    const affected = item.AffectedAccountNos == null ? undefined : Number(item.AffectedAccountNos); if (affected != null && (!Number.isInteger(affected) || affected < 0)) throw new Error("Invalid Enemalta customer count");
    for (const transformer of transformers) {
      const geometry = parseWktFeature(String(transformer.GpsCoord || ""));
      for (const location of matchesFeature("MT", geometry)) result[location.id].push(incident({ id: `enemalta:planned:${String(item.CaseID || item.id || hash(start, end, transformer.GpsCoord))}`, sourceId: "enemalta-power", sourceUpdatedAt: null, checkedAt: now.toISOString(), expiresAt: end, kind: "power-outage", status: Date.parse(start) > now.getTime() ? "planned" : "active", scope: "destination", scopeLabel: location.name, startsAt: start, endsAt: end, estimatedRestorationAt: end, affectedCustomers: affected, sourceUrl: "https://www.enemalta.com.mt/planned-power-cuts/" }));
    }
  }
  return { locations: result, overflow: rankInfrastructure(result) };
}

const cyprusAliases = infrastructureMapping.cyprus;
function cyprusTime(value: string) {
  const cleaned = value.normalize("NFKD").toLowerCase().replaceAll(".", "").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm|πμ|μμ)?/);
  if (!match) throw new Error("Invalid EAC timestamp");
  let hour = Number(match[4]); const marker = match[6]; if (marker === "pm" || marker === "μμ") hour = hour % 12 + 12; else if (marker === "am" || marker === "πμ") hour %= 12;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Nicosia", timeZoneName: "longOffset", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const approximate = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), hour, Number(match[5])));
  const offset = formatter.formatToParts(approximate).find((part) => part.type === "timeZoneName")?.value.match(/GMT([+-]\d{2}):?(\d{2})/) || [];
  return new Date(approximate.getTime() - (Number(offset[1] || 0) * 60 + Math.sign(Number(offset[1] || 0)) * Number(offset[2] || 0)) * 60000).toISOString();
}
export function parseEacInfrastructure(html: string, district: string, now: Date): InfrastructureResult {
  if (html.length > 256 * 1024 || !/CURRENT OUTAGES \(FAULTS\)/i.test(html) || !/SCHEDULED INTERRUPTIONS/i.test(html)) throw new Error("EAC page contract changed");
  const result = emptyCountry("CY"); const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "|").replace(/&nbsp;|&#160;/gi, " ");
  const sections = text.split(/CURRENT OUTAGES \(FAULTS\)|SCHEDULED INTERRUPTIONS/i); if (sections.length < 3) throw new Error("EAC tables unavailable");
  for (const [index, section] of sections.slice(1, 3).entries()) {
    const rows = section.split(/\|+/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (let i = 0; i < rows.length - 2; i += 1) {
      const locality = normalize(rows[i]); if (!Object.values(cyprusAliases).some((aliases) => aliases.includes(locality))) continue;
      const times = rows.slice(i + 1, i + 8).filter((part) => /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/.test(part)); if (times.length < 2) continue;
      const start = cyprusTime(times[0]); const end = cyprusTime(times[1]); if (Date.parse(end) <= now.getTime() || Date.parse(start) > now.getTime() + 24 * 3600000) continue;
      const locationId = Object.entries(cyprusAliases).find(([, aliases]) => aliases.includes(locality))![0]; const location = locations.find(({ id }) => id === locationId)!;
      result[locationId].push(incident({ id: `eac:${hash(district, locality, start, end)}`, sourceId: "eac-power", sourceUpdatedAt: null, checkedAt: now.toISOString(), expiresAt: end, kind: "power-outage", status: index === 0 && Date.parse(start) <= now.getTime() ? "active" : "planned", scope: "destination", scopeLabel: location.name, startsAt: start, endsAt: end, estimatedRestorationAt: end, sourceUrl: `https://www.eac.com.cy/EN/RegulatedActivities/Distribution/PowerInterruptions/Pages/Faultsandscheduledinterruptions.aspx?District=${district}` }));
    }
  }
  return { locations: result, overflow: rankInfrastructure(result) };
}

export function parsePseEnergyCompass(value: unknown, now: Date): Record<string, SystemCondition[]> {
  const rows = z.union([z.array(z.record(z.string(), z.unknown())), z.object({ value: z.array(z.record(z.string(), z.unknown())) }).transform((item) => item.value)]).parse(value);
  if (rows.length > 100) throw new Error("PSE response overflow"); const result: Record<string, SystemCondition[]> = Object.fromEntries(locations.filter(({ countryCode }) => countryCode === "PL").map(({ id }) => [id, []]));
  for (const row of rows) {
    const code = Number(row.usage_fcst); if (![2, 3].includes(code) || row.is_active !== true) continue;
    const start = isoUtc(row.valid_from_ts_utc || row.period_utc || row.dtime_utc); const end = row.valid_to_ts_utc ? isoUtc(row.valid_to_ts_utc) : new Date(Date.parse(start) + 3600000).toISOString();
    const updated = row.publication_ts_utc ? isoUtc(row.publication_ts_utc) : row.publication_ts ? iso(row.publication_ts) : null;
    if (updated && Date.parse(updated) > now.getTime() + 300000 || Date.parse(end) <= now.getTime() || Date.parse(start) > now.getTime() + 24 * 3600000) continue;
    for (const location of locations.filter(({ countryCode }) => countryCode === "PL")) result[location.id].push(SystemConditionSchema.parse({ id: `pse:${start}:${code}`, sourceId: "pse-energy-compass", sourceUpdatedAt: updated, checkedAt: now.toISOString(), expiresAt: end, kind: "electricity-use-advisory", state: code === 3 ? "limit-use" : "reduce-use", scope: "country", scopeLabel: "Poland", startsAt: start, endsAt: end, sourceUrl: "https://www.energetycznykompas.pl/" }));
  }
  for (const id of Object.keys(result)) result[id] = result[id].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 1);
  return result;
}

export function mergeInfrastructure(previous: LocationConditions["infrastructureIncidents"], next: LocationConditions["infrastructureIncidents"], sourceId: InfrastructureIncident["sourceId"], complete: boolean) {
  const retained = complete ? previous.filter((item) => item.sourceId !== sourceId) : previous;
  return [...new Map([...retained, ...next].map((item) => [`${item.sourceId}:${item.id}`, item])).values()];
}

export const supportedInfrastructureCountries = infrastructureCountries;
