import { XMLParser } from "fast-xml-parser";
import bootstrapJson from "../../../../data/lu-alert-bootstrap.json";
import type { NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted, fetchWithRetry, mapConcurrent } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import {
  capPolygon, capSeverity, cleanText, countryLocations, limitEvents, matchingLocations, overlapsNextDay,
  retainedCountryEvents, structuredHazard, type NationalPartition,
} from "./national-civil-alerts-shared";

const DATASET_URL = "https://data.public.lu/api/1/datasets/alertes-du-systeme-lu-alert/";
const OFFICIAL_URL = "https://data.public.lu/fr/datasets/alertes-du-systeme-lu-alert/";
const METADATA_LIMIT = 512 * 1024;
const RESOURCE_LIMIT = 128 * 1024;
const RUN_LIMIT = 6 * 1024 * 1024;
const RESOURCE_COUNT_LIMIT = 100;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });

type LuResource = { title?: unknown; url?: unknown; last_modified?: unknown; type?: unknown; format?: unknown };
type LuMetadata = { last_update?: unknown; resources?: LuResource[] };
type LuBootstrap = { schemaVersion: 1; generatedAt: string; processedResourceWatermark: string; alerts: string[] };
type CapInfo = Record<string, unknown> & { area?: unknown };
type CapAlert = Record<string, unknown> & { info?: unknown };
type ParsedCap = { identifier: string; msgType: string; references: string[]; sent: number; events: NormalizedEvent[]; affectedIds: string[]; ignored: boolean };

class LuParseError extends Error {
  constructor(message: string, readonly affectedIds: string[]) { super(message); }
}

function array<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function capInfos(alert: CapAlert): CapInfo[] {
  return array(alert.info as CapInfo | CapInfo[]).sort((a, b) => {
    const rank = (value: unknown) => {
      const language = cleanText(value).toLowerCase();
      if (language.startsWith("en")) return 0;
      if (language.startsWith("fr")) return 1;
      if (language.startsWith("de")) return 2;
      return 3;
    };
    return rank(a.language) - rank(b.language);
  });
}

function referenceIdentifiers(value: unknown): string[] {
  return cleanText(value).split(/\s+/).map((reference) => reference.split(","))
    .filter((parts) => parts.length >= 2).map((parts) => parts[1]).filter(Boolean);
}

function eventCodes(info: CapInfo): unknown[] {
  return array(info.eventCode as Record<string, unknown> | Record<string, unknown>[]).flatMap((code) => [code?.valueName, code?.value]);
}

function isDuplicativeCategory(info: CapInfo): boolean {
  const categories = array(info.category as unknown | unknown[]).map((value) => cleanText(value).toLowerCase());
  return categories.some((value) => ["met", "geo", "fire"].includes(value));
}

export function parseLuCap(xml: string, context: IngestionContext): ParsedCap {
  const parsed = parser.parse(xml) as { alert?: CapAlert };
  const alert = parsed.alert;
  if (!alert || typeof alert !== "object") throw new Error("CAP-LU alert root is missing");
  const identifier = cleanText(alert.identifier);
  const msgType = cleanText(alert.msgType).toLowerCase();
  const status = cleanText(alert.status).toLowerCase();
  const scope = cleanText(alert.scope).toLowerCase();
  const sent = Date.parse(cleanText(alert.sent));
  if (!identifier || !Number.isFinite(sent) || !["alert", "update", "cancel", "pause", "resume"].includes(msgType)) {
    throw new Error("CAP-LU alert is not a public production lifecycle record");
  }
  const references = referenceIdentifiers(alert.references);
  if (status !== "actual" || scope !== "public") return { identifier, msgType, references: [], sent, events: [], affectedIds: [], ignored: true };
  const infos = capInfos(alert);
  const testMarkers = infos.map((info) => array(info.parameter as Record<string, unknown> | Record<string, unknown>[])
    .filter((parameter) => cleanText(parameter?.valueName) === "urn:oasis:names:tc:emergency:cap:1.2:profile:cap-lu:1.0:cb-eu-level")
    .map((parameter) => cleanText(parameter.value)));
  if (testMarkers.some((values) => values.includes("TEST"))) {
    if (!testMarkers.every((values) => values.length > 0 && values.every((value) => value === "TEST"))) {
      throw new Error("CAP-LU test markers are inconsistent");
    }
    return { identifier, msgType, references: [], sent, events: [], affectedIds: [], ignored: true };
  }
  if (["cancel", "pause"].includes(msgType)) return { identifier, msgType, references, sent, events: [], affectedIds: [], ignored: false };
  const info = infos[0];
  if (!info) throw new Error("CAP-LU information block is missing");
  if (isDuplicativeCategory(info)) return { identifier, msgType, references, sent, events: [], affectedIds: [], ignored: true };
  const severity = capSeverity(info.severity);
  const starts = Date.parse(cleanText(info.effective || info.onset || alert.sent));
  const ends = Date.parse(cleanText(info.expires));
  const headline = cleanText(info.headline || info.event);
  const areaRecords = array(info.area as Record<string, unknown> | Record<string, unknown>[]);
  const areas = areaRecords.flatMap((area) => array(area.polygon as unknown | unknown[])).map(capPolygon);
  const countrywide = areas.length === 0 && areaRecords.some((area) => ["luxembourg", "grand-duche du luxembourg", "grand duchy of luxembourg", "grossherzogtum luxemburg"]
    .includes(cleanText(area.areaDesc).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()));
  const countryCatalog = countryLocations(context, "LU");
  const locations = countrywide ? countryCatalog : matchingLocations(areas, countryCatalog);
  if (!severity || !Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends || headline.length < 3 || (!countrywide && areas.length === 0)) {
    throw new LuParseError("CAP-LU information block is incomplete", locations.map(({ id }) => id));
  }
  if (!overlapsNextDay(starts, ends, context.now)) return { identifier, msgType, references, sent, events: [], affectedIds: locations.map(({ id }) => id), ignored: true };
  const hazard = structuredHazard([...eventCodes(info), info.category]);
  const explanation = (cleanText(info.description) || headline).slice(0, 500);
  const action = (cleanText(info.instruction) || "Follow instructions from Luxembourg authorities and monitor LU-Alert for updates.").slice(0, 300);
  const affectedArea = (cleanText(areaRecords[0]?.areaDesc) || "Luxembourg").slice(0, 200);
  return {
    identifier, msgType, references, sent, affectedIds: locations.map(({ id }) => id), ignored: false,
    events: locations.map((location) => ({
      id: `lu-alert:${identifier}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
      type: hazard, level: severity, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE",
      headline: headline.slice(0, 180), explanation, action, affectedArea,
      geometry: { kind: "locations", ids: [location.id] }, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(),
      sourceUpdatedAt: new Date(sent).toISOString(), checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(),
      sourceName: "LU-Alert", sourceUrl: OFFICIAL_URL, confidence: "HIGH",
    })),
  };
}

function applyLifecycle(existing: NormalizedEvent[], records: ParsedCap[], now: Date): NormalizedEvent[] {
  let events = existing.slice();
  for (const record of records.sort((a, b) => a.sent - b.sent || a.identifier.localeCompare(b.identifier))) {
    const superseded = new Set(record.references);
    if (superseded.size) events = events.filter((event) => ![...superseded].some((identifier) => event.id.startsWith(`lu-alert:${identifier}:`)));
    if (record.msgType === "cancel" || record.msgType === "pause" || record.ignored) continue;
    events = events.filter((event) => !event.id.startsWith(`lu-alert:${record.identifier}:`));
    events.push(...record.events);
  }
  return limitEvents(events.filter((event) => Date.parse(event.expiresAt) > now.getTime()));
}

function resourceTimestamp(resource: LuResource): number {
  return Date.parse(cleanText(resource.last_modified));
}

export async function fetchLuPartition(context: IngestionContext): Promise<NationalPartition> {
  const locations = countryLocations(context, "LU");
  const metadataResponse = await fetchWithRetry(context.fetch, DATASET_URL, {
    headers: { "X-Fields": "{last_update,resources{title,url,last_modified,type,format}}" },
  }, 3, METADATA_LIMIT);
  const metadata = await metadataResponse.json() as LuMetadata;
  const datasetUpdatedMs = Date.parse(cleanText(metadata.last_update));
  if (!Number.isFinite(datasetUpdatedMs) || !Array.isArray(metadata.resources)) throw new Error("LU-Alert dataset metadata is invalid");
  const datasetUpdated = new Date(datasetUpdatedMs).toISOString();
  const transport = context.state?.partitionTransports.nationalCivilAlerts.LU["lu-alert"];
  const previous = transport?.lastAttempt ? transport : context.state?.sourcePartitions.nationalCivilAlerts.LU;
  const previousUpdated = previous?.sourceUpdatedAt;
  if (previous?.status === "ok" && previousUpdated === datasetUpdated) return {
    status: "ok", sourceUpdatedAt: datasetUpdated, events: retainedCountryEvents(context, "LU", "lu-alert:"), error: null,
    checkedLocationIds: locations.map(({ id }) => id), unavailableLocationIds: [],
  };

  const bootstrap = bootstrapJson as LuBootstrap;
  const isFirstRun = !previousUpdated;
  const watermark = Date.parse(isFirstRun ? bootstrap.processedResourceWatermark : previousUpdated!);
  const eligible = metadata.resources.filter((resource) => {
    const url = cleanText(resource.url);
    return Number.isFinite(resourceTimestamp(resource))
      && /^https:\/\/download\.data\.public\.lu\//.test(url) && cleanText(resource.format).toLowerCase() === "xml";
  });
  const newResources = eligible.filter((resource) => resourceTimestamp(resource) > watermark);
  const continuingOverflow = previous?.status === "partial" && previous.error === "LU-Alert resource limit or deadline reached";
  const cutoff = isFirstRun || continuingOverflow || newResources.length > RESOURCE_COUNT_LIMIT ? watermark : watermark - 60 * 60_000;
  const candidates = eligible.filter((resource) => resourceTimestamp(resource) > cutoff)
    .sort((a, b) => resourceTimestamp(a) - resourceTimestamp(b) || cleanText(a.url).localeCompare(cleanText(b.url)));
  const selected = candidates.slice(0, RESOURCE_COUNT_LIMIT);
  let deadlineLimited = false;
  const byteBudget = { remaining: RUN_LIMIT };
  const fetched = await mapConcurrent(selected, 6, async (resource) => {
    if (context.deadlineAt && Date.now() > context.deadlineAt - 7_000) { deadlineLimited = true; return { resource, xml: null, error: "deadline", limited: true }; }
    try {
      const response = await fetchAllowlisted(context.fetch, cleanText(resource.url), ["download.data.public.lu"], 3, { maxBytes: RESOURCE_LIMIT, byteBudget });
      return { resource, xml: await response.text(), error: null, limited: false };
    } catch (error) {
      const message = String(error);
      return { resource, xml: null, error: message, limited: /response exceeds \d+ bytes|byte budget exhausted/i.test(message) };
    }
  });

  const records: ParsedCap[] = [];
  const failedResources = new Set<LuResource>();
  const unavailable = new Set<string>();
  let invalid = 0;
  const bootstrapXml = isFirstRun ? bootstrap.alerts : [];
  recordSourceDiagnostics(context, { recordsExamined: bootstrapXml.length + fetched.length });
  for (const xml of bootstrapXml) {
    try { records.push(parseLuCap(xml, context)); }
    catch (error) {
      invalid += 1;
      const affected = error instanceof LuParseError && error.affectedIds.length ? error.affectedIds : locations.map(({ id }) => id);
      affected.forEach((id) => unavailable.add(id));
    }
  }
  for (const item of fetched) {
    if (item.error || !item.xml) {
      invalid += 1;
      failedResources.add(item.resource);
      locations.forEach(({ id }) => unavailable.add(id));
      continue;
    }
    try { records.push(parseLuCap(item.xml, context)); }
    catch (error) {
      invalid += 1;
      failedResources.add(item.resource);
      const affected = error instanceof LuParseError && error.affectedIds.length ? error.affectedIds : locations.map(({ id }) => id);
      affected.forEach((id) => unavailable.add(id));
    }
  }
  if ((bootstrapXml.length + fetched.length) > 0 && records.length === 0 && invalid > 0 && !fetched.some(({ limited }) => limited)) {
    throw new Error("LU-Alert resources contain no parseable records");
  }

  const overflow = candidates.length > RESOURCE_COUNT_LIMIT || deadlineLimited;
  if (overflow) locations.forEach(({ id }) => unavailable.add(id));
  const checked = locations.map(({ id }) => id).filter((id) => !unavailable.has(id));
  const retained = retainedCountryEvents(context, "LU", "lu-alert:");
  // Successfully processed lifecycle records must survive even when catch-up is incomplete.
  const events = applyLifecycle(retained, records, context.now);
  const eventIds = new Set(events.map(({ id }) => id));
  const removedEventPrefixes = retained.filter(({ id }) => !eventIds.has(id)).map(({ id }) => id);
  const partial = invalid > 0 || overflow;
  let processedWatermark = watermark;
  if (partial) for (const item of fetched) {
    if (failedResources.has(item.resource)) break;
    processedWatermark = Math.max(processedWatermark, resourceTimestamp(item.resource));
  }
  return {
    status: partial ? "partial" : "ok",
    sourceUpdatedAt: partial ? new Date(processedWatermark).toISOString() : datasetUpdated,
    events, removedEventPrefixes, error: overflow ? "LU-Alert resource limit or deadline reached" : invalid ? `${invalid} CAP-LU resources were invalid` : null,
    checkedLocationIds: checked, unavailableLocationIds: [...unavailable].sort(),
  };
}
