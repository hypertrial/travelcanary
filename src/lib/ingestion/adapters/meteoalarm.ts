import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { PartitionedSourceResultSchema, type CountryCode, type HazardLevel, type NormalizedEvent, type PartitionedSourceResult } from "../../domain/schemas";
import { eventAffectsLocation } from "../../geospatial";
import { eventCopy, weatherHazard } from "../templates";
import { fetchAllowlisted, fetchWithRetry, isAllowlistedHttpsUrl, mapConcurrent, withFetchByteBudget } from "../fetch";
import { MAX_EVENTS_PER_PARTITION } from "../limits";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";
import { fetchIfrcMeteoAlarmFallback } from "./ifrc-meteoalarm";
import { fetchNationalWeatherFallback, nationalWeatherFallbackDisabled } from "./national-weather-fallback";
import { meteoalarmFallbackSystem } from "../../national-warning-sources";

export const meteoAlarmFeedSlugs: Record<CountryCode, string> = {
  AT: "austria", BE: "belgium", BG: "bulgaria", HR: "croatia", CY: "cyprus", CZ: "czechia", DK: "denmark", EE: "estonia",
  FI: "finland", FR: "france", DE: "germany", GR: "greece", HU: "hungary", IE: "ireland", IT: "italy", LV: "latvia",
  LT: "lithuania", LU: "luxembourg", MT: "malta", NL: "netherlands", PL: "poland", PT: "portugal", RO: "romania",
  SK: "slovakia", SI: "slovenia", ES: "spain", SE: "sweden", CH: "switzerland",
};

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
type XmlRecord = Record<string, unknown>;
type CapSupplement = { references: string[]; instructions: string[] };
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_CAP_BYTES = 512 * 1024;
const MAX_RUN_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES_PER_FEED = 2_000;
const MAX_SUPPLEMENT_URLS = 256;
const MAX_FEED_AGE_MS = 2 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function stringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object" && "#text" in value) return stringValue((value as XmlRecord)["#text"]);
  return "";
}

function boundedText(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function entryPriority(raw: XmlRecord) {
  const lifecycle = messageType(raw);
  if (lifecycle.startsWith("cancel")) return 5;
  if (lifecycle === "update") return 4;
  return severityLevel(stringValue(raw.severity)) === "SEVERE" ? 3
    : severityLevel(stringValue(raw.severity)) === "HIGH" ? 2 : 1;
}

function feedEntries(xml: string): { feed: XmlRecord; entries: XmlRecord[]; totalEntries: number; overflow: boolean } {
  const document = parser.parse(xml) as { feed?: XmlRecord };
  if (!document.feed) throw new Error("MeteoAlarm document has no Atom feed");
  const allEntries = array(document.feed.entry as XmlRecord | XmlRecord[] | undefined);
  const entries = allEntries.length <= MAX_ENTRIES_PER_FEED
    ? allEntries
    : allEntries.map((entry, index) => ({ entry, index })).sort((a, b) => (
      entryPriority(b.entry) - entryPriority(a.entry)
      || Date.parse(stringValue(b.entry.updated || b.entry.sent || 0)) - Date.parse(stringValue(a.entry.updated || a.entry.sent || 0))
      || a.index - b.index
    )).slice(0, MAX_ENTRIES_PER_FEED).map(({ entry }) => entry);
  return { feed: document.feed, entries, totalEntries: allEntries.length, overflow: allEntries.length > entries.length };
}

function feedUpdatedAt(feed: XmlRecord, checkedAt: Date) {
  const updated = Date.parse(String(feed.updated || ""));
  if (!Number.isFinite(updated) || updated > checkedAt.getTime() + MAX_FUTURE_SKEW_MS || checkedAt.getTime() - updated > MAX_FEED_AGE_MS) {
    throw new Error("MeteoAlarm feed update time is missing, stale, or future-dated");
  }
  return updated;
}

function sourceUrl(raw: XmlRecord): string {
  const links = array(raw.link as XmlRecord | XmlRecord[] | undefined);
  return String(links.find((link) => link["@_type"] === "application/cap+xml")?.["@_href"] || links[0]?.["@_href"] || "https://meteoalarm.org/");
}

function messageType(raw: XmlRecord): string {
  return stringValue(raw.message_type || raw.msgType || "Alert").toLowerCase();
}

function hasValidAlertPayload(raw: XmlRecord): boolean {
  const startsAt = stringValue(raw.onset || raw.effective || raw.published);
  const endsAt = stringValue(raw.expires);
  const updatedAt = stringValue(raw.updated || raw.sent || startsAt);
  const geocodes = array(raw.geocode as XmlRecord | XmlRecord[] | undefined);
  const severity = stringValue(raw.severity);
  return Boolean(
    (severityLevel(severity) || ["minor", "unknown"].includes(severity.toLowerCase()))
    && stringValue(raw.identifier || raw.id)
    && startsAt
    && endsAt
    && !Number.isNaN(Date.parse(startsAt))
    && !Number.isNaN(Date.parse(endsAt))
    && !Number.isNaN(Date.parse(updatedAt))
    && Date.parse(startsAt) < Date.parse(endsAt)
    && (geocodes.some((item) => stringValue(item.value)) || stringValue(raw.areaDesc)),
  );
}

function referencedIdentifiers(value: unknown): string[] {
  return array(value as unknown | unknown[] | undefined)
    .flatMap((item) => stringValue(item).split(/\s+/))
    .map((reference) => reference.includes(",") ? reference.split(",")[1]?.trim() : reference.trim())
    .filter((identifier): identifier is string => Boolean(identifier));
}

function isEmergencyInstruction(instruction: string): boolean {
  return /\b(evacuat(?:e|ion)|leave (?:the )?area|shelter immediately|emergency instructions?)\b/i.test(instruction);
}

export const meteoAlarmCapHosts = ["feeds.meteoalarm.org", "meteoalarm.org", "www.meteoalarm.org"] as const;

export async function fetchMeteoAlarmCap(fetchImpl: typeof fetch, initialUrl: string, byteBudget?: { remaining: number }): Promise<Response> {
  return fetchAllowlisted(fetchImpl, initialUrl, meteoAlarmCapHosts, 3, {
    maxBytes: MAX_CAP_BYTES, byteBudget, diagnosticsCategory: "cap",
  });
}

export function parseMeteoAlarmCapSupplement(xml: string): CapSupplement {
  const document = parser.parse(xml) as { alert?: XmlRecord };
  if (!document.alert) throw new Error("MeteoAlarm CAP document has no alert");
  const infos = array(document.alert.info as XmlRecord | XmlRecord[] | undefined);
  return {
    references: referencedIdentifiers(document.alert.references),
    instructions: infos.flatMap((info) => array(info.instruction as unknown | unknown[] | undefined).map(stringValue)).filter(Boolean),
  };
}

function couldAffectCurrentWindow(raw: XmlRecord, checkedAt?: Date) {
  if (!checkedAt) return true;
  const startsAt = stringValue(raw.onset || raw.effective || raw.published);
  const endsAt = stringValue(raw.expires);
  const starts = Date.parse(startsAt);
  const ends = Date.parse(endsAt);
  return Number.isNaN(starts) || Number.isNaN(ends)
    || (ends > checkedAt.getTime() && starts < checkedAt.getTime() + 24 * 60 * 60 * 1000);
}

export function meteoAlarmSupplementUrls(xml: string, checkedAt?: Date): string[] {
  const { feed, entries } = feedEntries(xml);
  if (checkedAt) feedUpdatedAt(feed, checkedAt);
  return [...new Set(entries.filter((raw) => {
    const lifecycle = messageType(raw);
    const isLifecycleRecord = lifecycle === "update" || lifecycle.startsWith("cancel");
    const needsLifecycleReferences = isLifecycleRecord
      && referencedIdentifiers(raw.references).length === 0
      && (lifecycle.startsWith("cancel") || couldAffectCurrentWindow(raw, checkedAt));
    const needsEmergencyReview = severityLevel(stringValue(raw.severity)) === "SEVERE"
      && weatherHazard(stringValue(raw.event || raw.title || "weather")) === "wildfire"
      && couldAffectCurrentWindow(raw, checkedAt);
    return needsLifecycleReferences || needsEmergencyReview;
  }).map(sourceUrl).filter((url) => isAllowlistedHttpsUrl(url, meteoAlarmCapHosts)))];
}

function severityLevel(value: string): HazardLevel | null {
  const severity = value.toLowerCase();
  if (severity.includes("extreme")) return "SEVERE";
  if (severity.includes("severe")) return "HIGH";
  if (severity.includes("moderate") || severity.includes("yellow")) return "ELEVATED";
  return null;
}

export function normalizeMeteoAlarmArea(value: string) {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return normalized ? `area:${normalized}` : null;
}

export function parseMeteoAlarmFeed(
  xml: string,
  countryCode: CountryCode,
  checkedAt: Date,
  supplements: ReadonlyMap<string, CapSupplement> = new Map(),
): { events: NormalizedEvent[]; updatedAt: string | null; invalid: number; supersededIdentifiers: string[]; recordsExamined: number; overflow: boolean } {
  const { feed, entries, totalEntries, overflow } = feedEntries(xml);
  const updated = feedUpdatedAt(feed, checkedAt);
  const superseded = new Set<string>();
  let parseable = 0;
  let invalid = 0;
  for (const raw of entries) {
    const lifecycle = messageType(raw);
    if (stringValue(raw.status) !== "Actual" || stringValue(raw.scope) !== "Public") continue;
    if (lifecycle.startsWith("cancel")) {
      if (stringValue(raw.identifier || raw.id) || referencedIdentifiers(raw.references).length) parseable += 1;
      else invalid += 1;
    } else if (hasValidAlertPayload(raw)) {
      parseable += 1;
    } else {
      invalid += 1;
    }
    if (lifecycle !== "update" && !lifecycle.startsWith("cancel")) continue;
    if (lifecycle === "update" && !hasValidAlertPayload(raw)) continue;
    const supplement = supplements.get(sourceUrl(raw));
    for (const identifier of [...referencedIdentifiers(raw.references), ...(supplement?.references || [])]) superseded.add(identifier);
  }
  if (entries.length > 0 && parseable === 0) throw new Error("MeteoAlarm feed contains no parseable alert records");
  const events: NormalizedEvent[] = [];
  for (const raw of entries) {
    const structuredLevel = severityLevel(stringValue(raw.severity));
    const status = stringValue(raw.status);
    const scope = stringValue(raw.scope);
    const lifecycle = messageType(raw);
    if (!structuredLevel || status !== "Actual" || scope !== "Public" || lifecycle.startsWith("cancel") || !hasValidAlertPayload(raw)) continue;
    const identifier = stringValue(raw.identifier || raw.id);
    if (!identifier || superseded.has(identifier)) continue;
    const startsAt = String(raw.onset || raw.effective || raw.published || "");
    const endsAt = String(raw.expires || "");
    if (!startsAt || !endsAt || Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) continue;
    if (Date.parse(startsAt) >= Date.parse(endsAt)) continue;
    if (Date.parse(endsAt) <= checkedAt.getTime() || Date.parse(startsAt) >= checkedAt.getTime() + 24 * 60 * 60 * 1000) continue;
    const geocodes = array(raw.geocode as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const codes = geocodes.map((item) => String(item.value || "")).filter(Boolean).map((code) => {
      const normalized = code.replace(/^GR/, "EL");
      return normalized.toLowerCase() === "country" ? `${countryCode}:country` : normalized;
    });
    const sourceArea = String(raw.areaDesc || "").trim();
    const area = sourceArea || countryCode;
    const areaCode = sourceArea ? normalizeMeteoAlarmArea(sourceArea) : null;
    if (areaCode) codes.push(areaCode);
    // A missing regional code and area label is not proof that the alert covers the whole country.
    if (codes.length === 0) continue;
    const type = weatherHazard(stringValue(raw.event || raw.title || "weather"));
    const url = sourceUrl(raw);
    const instructions = [
      ...array(raw.instruction as unknown | unknown[] | undefined).map(stringValue),
      ...(supplements.get(url)?.instructions || []),
    ];
    const wildfireEmergency = type === "wildfire" && instructions.some(isEmergencyInstruction);
    const level = type === "wildfire" && structuredLevel === "SEVERE" && !wildfireEmergency ? "HIGH" : structuredLevel;
    const upcoming = Date.parse(startsAt) > checkedAt.getTime();
    const copy = eventCopy(type, level, area, upcoming);
    events.push({
      id: `meteoalarm:${identifier}:${createHash("sha256").update(JSON.stringify([...new Set(codes)].sort())).digest("hex").slice(0, 12)}`,
      sourceId: "meteoalarm", providerId: "meteoalarm", type, level, timing: upcoming ? "UPCOMING" : "ACTIVE",
      headline: boundedText(copy.headline, 180), explanation: boundedText(copy.explanation, 500), action: boundedText(copy.action, 300),
      affectedArea: boundedText(area, 200),
      geometry: { kind: "regions", countryCode, codes },
      startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
      sourceUpdatedAt: new Date(stringValue(raw.updated || raw.sent || startsAt)).toISOString(), checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(endsAt).toISOString(), sourceName: "MeteoAlarm", sourceUrl: url, confidence: "HIGH",
    });
  }
  return {
    events: events.slice(0, MAX_EVENTS_PER_PARTITION),
    updatedAt: new Date(updated).toISOString(),
    invalid,
    supersededIdentifiers: [...superseded],
    recordsExamined: totalEntries,
    overflow: overflow || events.length > MAX_EVENTS_PER_PARTITION,
  };
}

export class MeteoAlarmAdapter implements SourceAdapter {
  readonly id = "meteoalarm" as const;
  readonly cadence = "fast" as const;

  async fetch(context: IngestionContext): Promise<PartitionedSourceResult> {
    const checkedAt = context.now.toISOString();
    const byteBudget = { remaining: MAX_RUN_BYTES };
    const feeds = await mapConcurrent(Object.entries(meteoAlarmFeedSlugs) as [CountryCode, string][], 10, async ([countryCode, slug]) => {
      try {
        const response = await fetchWithRetry(
          context.fetch,
          `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`,
          {}, 3, MAX_FEED_BYTES, byteBudget, 5_000, "atom",
        );
        return { countryCode, xml: await response.text(), error: null };
      } catch (error) {
        return { countryCode, xml: null, error: (error instanceof Error ? error.message : "MeteoAlarm feed failed").slice(0, 300) };
      }
    });

    const supplementCountries = new Map<string, Set<CountryCode>>();
    for (const feed of feeds) {
      if (!feed.xml) continue;
      try {
        for (const url of meteoAlarmSupplementUrls(feed.xml, context.now)) {
          const countries = supplementCountries.get(url) || new Set<CountryCode>();
          countries.add(feed.countryCode);
          supplementCountries.set(url, countries);
        }
      } catch {
        // The final country parse below owns malformed-feed status.
      }
    }
    const allSupplementUrls = [...supplementCountries.keys()];
    const supplementUrls = allSupplementUrls.slice(0, MAX_SUPPLEMENT_URLS);
    const omittedSupplementUrls = allSupplementUrls.slice(MAX_SUPPLEMENT_URLS);
    const supplementOverflowCountries = new Set(omittedSupplementUrls.flatMap((url) => [...(supplementCountries.get(url) || [])]));
    if (omittedSupplementUrls.length) recordSourceDiagnostics(context, { overflowCode: "meteoalarm_supplement_limit" });
    recordSourceDiagnostics(context, { targetsScheduled: supplementUrls.length });
    const supplements = new Map<string, CapSupplement>();
    await mapConcurrent(supplementUrls, 4, async (url) => {
      try {
        const detail = await fetchMeteoAlarmCap(context.fetch, url, byteBudget);
        supplements.set(url, parseMeteoAlarmCapSupplement(await detail.text()));
      } catch {
        // The country feed remains authoritative if an optional CAP detail cannot be loaded.
      } finally {
        recordSourceDiagnostics(context, { targetsCompleted: 1 });
      }
    });

    const partitions = Object.fromEntries(feeds.map((feed) => {
      if (!feed.xml) return [feed.countryCode, { status: "failed", sourceUpdatedAt: null, events: [], error: feed.error }];
      try {
        const parsed = parseMeteoAlarmFeed(feed.xml, feed.countryCode, context.now, supplements);
        recordSourceDiagnostics(context, {
          recordsExamined: parsed.recordsExamined,
          ...(parsed.overflow ? { overflowCode: "meteoalarm_entry_or_event_limit" } : {}),
        });
        const partialReasons = [
          parsed.invalid ? `${parsed.invalid} MeteoAlarm records were invalid` : null,
          parsed.overflow ? "MeteoAlarm feed exceeded its bounded record limit" : null,
          supplementOverflowCountries.has(feed.countryCode) ? "MeteoAlarm CAP supplement queue exceeded its bounded limit" : null,
        ].filter(Boolean);
        return [feed.countryCode, {
          status: partialReasons.length ? "partial" : "ok", sourceUpdatedAt: parsed.updatedAt, events: parsed.events,
          error: partialReasons.join("; ").slice(0, 300) || null,
          removedEventPrefixes: parsed.supersededIdentifiers.map((identifier) => `meteoalarm:${identifier}:`),
        }];
      } catch (error) {
        return [feed.countryCode, {
          status: "failed", sourceUpdatedAt: null, events: [],
          error: (error instanceof Error ? error.message : "MeteoAlarm feed was malformed").slice(0, 300),
        }];
      }
    }));
    const failedCountries = (Object.entries(partitions) as [CountryCode, { status: string; events: NormalizedEvent[]; error: string | null }][]).filter(([, partition]) => partition.status === "failed").map(([countryCode]) => countryCode);
    const primaryPartitions = structuredClone(partitions);
    const nationallyRecovered = new Set<CountryCode>();
    await mapConcurrent(failedCountries.filter((countryCode) => meteoalarmFallbackSystem(countryCode)), 2, async (countryCode) => {
      try {
        const recovered = await withFetchByteBudget(byteBudget, () => fetchNationalWeatherFallback(countryCode, context));
        if (!recovered) return;
        nationallyRecovered.add(countryCode);
        partitions[countryCode] = {
          status: "partial", sourceUpdatedAt: recovered.sourceUpdatedAt, events: recovered.events,
          removedEventPrefixes: recovered.removedEventPrefixes,
          error: `Primary MeteoAlarm feed failed; ${countryCode} national authority fallback succeeded`, limitationCode: "national_authority_fallback",
          transports: { [recovered.transportId]: { status: "ok", sourceUpdatedAt: recovered.sourceUpdatedAt, error: null } },
        };
      } catch (error) {
        const system = meteoalarmFallbackSystem(countryCode)!.id;
        partitions[countryCode].transports = { [system]: {
          status: "failed", sourceUpdatedAt: null,
          error: (error instanceof Error ? error.message : "National weather fallback failed").slice(0, 300),
        } };
      }
    });
    const ifrcCountries = failedCountries.filter((countryCode) => !nationallyRecovered.has(countryCode));
    const fallback = await fetchIfrcMeteoAlarmFallback(ifrcCountries, context).catch((error) => {
      for (const countryCode of ifrcCountries) {
        partitions[countryCode].transports ||= {};
        partitions[countryCode].transports["ifrc-meteoalarm"] = {
          status: "failed", sourceUpdatedAt: null,
          error: (error instanceof Error ? error.message : "IFRC fallback failed").slice(0, 300),
        };
      }
      return null;
    });
    if (fallback) for (const countryCode of ifrcCountries) {
      const recovered = fallback.get(countryCode) || { events: [], supersededIdentifiers: [] };
      partitions[countryCode] = { status: "partial", sourceUpdatedAt: recovered.events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || checkedAt, events: recovered.events,
        transports: partitions[countryCode].transports,
        removedEventPrefixes: recovered.supersededIdentifiers.map((identifier) => `meteoalarm:${identifier}:`),
        error: `Primary MeteoAlarm feed failed; IFRC Alert Hub fallback checked ${recovered.events.length} originating alert${recovered.events.length === 1 ? "" : "s"}`, limitationCode: "ifrc_fallback" };
    }
    for (const countryCode of Object.keys(partitions) as CountryCode[]) {
      const partition = partitions[countryCode]; const primary = primaryPartitions[countryCode];
      const tag = (events: NormalizedEvent[], transportId: string) => events.map((event) => ({ ...event, transportId }));
      partition.transports ||= {};
      partition.transports["meteoalarm-primary"] = { status: primary.status, sourceUpdatedAt: primary.sourceUpdatedAt,
        error: primary.error, events: tag(primary.events, "meteoalarm-primary"), removedEventPrefixes: primary.removedEventPrefixes || [] };
      if (nationallyRecovered.has(countryCode)) {
        const id = meteoalarmFallbackSystem(countryCode)!.id;
        Object.assign(partition.transports[id], { events: tag(partition.events, id), removedEventPrefixes: partition.removedEventPrefixes || [] });
      } else if (partition.limitationCode === "ifrc_fallback") {
        partition.transports["ifrc-meteoalarm"] = { status: "ok", sourceUpdatedAt: partition.sourceUpdatedAt, error: null,
          events: tag(partition.events, "ifrc-meteoalarm"), removedEventPrefixes: partition.removedEventPrefixes || [] };
      }
      if (primary.status === "ok") {
        // Complete primary replacement retires alternative delivery, never a second warning provider.
        for (const id of Object.keys(context.state?.partitionTransports.meteoalarm[countryCode] || {})) {
          if ([meteoalarmFallbackSystem(countryCode)?.id, "ifrc-meteoalarm"].includes(id)) partition.transports[id] = {
            status: "disabled", sourceUpdatedAt: null, events: [], error: null,
          };
        }
      }
      const nationalFallback = meteoalarmFallbackSystem(countryCode);
      if (nationalFallback && nationalWeatherFallbackDisabled(countryCode)) partition.transports[nationalFallback.id] = {
        status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "runtime_transport_disabled",
      };
    }
    const result = PartitionedSourceResultSchema.parse({ sourceId: this.id, checkedAt, partitions });
    const events = Object.values(result.partitions).flatMap((partition) => partition.events);
    recordSourceDiagnostics(context, {
      matchedLocations: context.locations.filter((location) => events.some((event) => eventAffectsLocation(event, location))).length,
    });
    return result;
  }
}
