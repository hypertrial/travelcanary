import type { NormalizedEvent } from "../../domain/schemas";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import { withFrAlertTlsFallback } from "./fr-alert-fetch";
import {
  capCircle, capPolygon, capSeverity, cleanText, countryLocations, limitEvents, matchingLocations, overlapsNextDay,
  retainedCountryEvents, structuredHazard, type NationalPartition,
} from "./national-civil-alerts-shared";

const ARCHIVE_LIMIT = 6 * 1024 * 1024;
const EXPORT_LIMIT = 2 * 1024 * 1024;
const ALERT_LIMIT = 250;
const ARCHIVE_URL = "https://fr-alert.gouv.fr/les-alertes";
const EXPORT_URL = "https://fr-alert.gouv.fr/export-alert";

type FrArchiveAlert = { created?: unknown; updated?: unknown; status?: unknown };
type FrExportArea = { descriptionZone?: unknown; polygone?: unknown; cercle?: unknown };
type FrExportInfo = Record<string, unknown> & { areas?: FrExportArea[] };
type FrExportAlert = Record<string, unknown> & { infos?: FrExportInfo[] };

function isResponseLimit(error: unknown): boolean {
  return /response exceeds \d+ bytes|byte budget exhausted/i.test(String(error));
}

function limitPartial(context: IngestionContext, message: string): NationalPartition {
  return {
    status: "partial", sourceUpdatedAt: context.now.toISOString(), events: [], error: message,
    checkedLocationIds: [], unavailableLocationIds: countryLocations(context, "FR").map(({ id }) => id),
  };
}

function archiveSettings(html: string): Record<string, unknown> {
  const scripts = [...html.matchAll(/<script[^>]*data-drupal-selector=["']drupal-settings-json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1]) as { alert_entity?: { alerts?: Record<string, unknown> } };
      if (parsed.alert_entity?.alerts && typeof parsed.alert_entity.alerts === "object") return parsed.alert_entity.alerts;
    } catch { /* try the next settings block */ }
  }
  throw new Error("FR-Alert archive settings are missing");
}

function archiveRecord(value: unknown): FrArchiveAlert {
  return (Array.isArray(value) ? value[0] : value || {}) as FrArchiveAlert;
}

function fieldValue(value: unknown): unknown {
  const firstValue = Array.isArray(value) ? value[0] : value;
  return firstValue && typeof firstValue === "object" && "value" in firstValue ? (firstValue as { value?: unknown }).value : firstValue;
}

function archiveTimestamp(identifier: string, value: unknown): number {
  const alert = archiveRecord(value);
  const raw = String(fieldValue(alert.created) || fieldValue(alert.updated) || "");
  const numeric = Number(raw || identifier.match(/^FR-ALERT\.(\d{10})/)?.[1]);
  return Number.isFinite(numeric) && numeric > 1_000_000_000
    ? numeric * (numeric < 100_000_000_000 ? 1_000 : 1)
    : Date.parse(raw);
}

export function parseFrArchive(html: string, now: Date): { identifiers: string[]; overflow: boolean } {
  const alerts = archiveSettings(html);
  const years = new Set([now.getUTCFullYear(), now.getUTCFullYear() - 1]);
  const identifiers = Object.entries(alerts).filter(([identifier, value]) => {
    const alert = archiveRecord(value);
    const status = cleanText(fieldValue(alert.status)).toLowerCase();
    const itemStatus = html.match(new RegExp(`id=["']${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-[^"']+)?["'][\\s\\S]{0,3000}?data-statut=["']([^"']+)`, "i"))?.[1];
    const actual = [status, cleanText(itemStatus).toLowerCase()].some((value) => ["actual", "reel", "réel"].includes(value));
    const timestamp = archiveTimestamp(identifier, value);
    const year = Number.isFinite(timestamp) ? new Date(timestamp).getUTCFullYear() : Number(identifier.match(/\.(20\d{2})\d*/)?.[1]);
    return identifier.startsWith("FR-ALERT.") && actual && years.has(year);
  }).sort((a, b) => archiveTimestamp(b[0], b[1]) - archiveTimestamp(a[0], a[1]) || a[0].localeCompare(b[0]))
    .map(([identifier]) => identifier);
  return { identifiers: identifiers.slice(0, ALERT_LIMIT), overflow: identifiers.length > ALERT_LIMIT };
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function frDate(value: unknown, timezone: unknown): number {
  const raw = cleanText(value);
  const direct = Date.parse(raw);
  if (/^\d{4}-\d\d-\d\dT/.test(raw) && Number.isFinite(direct)) return direct;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return Number.NaN;
  const utc = cleanText(typeof timezone === "object" && timezone ? (timezone as Record<string, unknown>).utc : timezone);
  const offset = utc.match(/UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  const offsetMinutes = offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] || 0)) : 0;
  return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) - offsetMinutes * 60_000;
}

function frPolygons(info: FrExportInfo) {
  const flatten = (value: unknown): unknown[] => Array.isArray(value) ? value.flatMap(flatten) : value ? [value] : [];
  return (Array.isArray(info.areas) ? info.areas : []).flatMap((area) => [
    ...flatten(area.polygone).map(capPolygon),
    ...flatten(area.cercle).map(capCircle),
  ]);
}

function isDuplicativeCategory(info: FrExportInfo): boolean {
  const category = cleanText(info.categorie || info["catégorie"] || info.category)
    .normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return ["met", "meteorologique", "weather", "geo", "geophysique", "flood", "inondation", "fire", "incendie"].includes(category);
}

export function parseFrExports(value: unknown, context: IngestionContext): { events: NormalizedEvent[]; invalid: number; unavailableLocationIds: string[] } {
  const exported = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Object.keys(value).every((key) => /^\d+$/.test(key))
      ? Object.values(value)
      : null;
  if (!exported) throw new Error("FR-Alert export is not a record collection");
  const locations = countryLocations(context, "FR");
  let events: NormalizedEvent[] = [];
  let invalid = 0;
  let parseable = 0;
  const unavailable = new Set<string>();
  const records = (exported as FrExportAlert[]).slice().sort((a, b) => frDate(a.dateEmission || a.sent, a.fuseauHoraire) - frDate(b.dateEmission || b.sent, b.fuseauHoraire)
    || cleanText(a.identifiant || a.identifier).localeCompare(cleanText(b.identifiant || b.identifier)));
  recordSourceDiagnostics(context, { recordsExamined: records.length });
  for (const raw of records) {
    const identifier = cleanText(raw.identifiant || raw.identifier);
    const production = cleanText(raw.status).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    const msgType = cleanText(raw.msgType || raw.typeMessage).toLowerCase();
    if (!identifier || !["reel", "actual"].includes(production)) {
      invalid += 1; locations.forEach(({ id }) => unavailable.add(id)); continue;
    }
    const references = cleanText(raw.references || raw.reference).split(/[\s,]+/).filter((part) => part.startsWith("FR-ALERT."));
    if (references.length) events = events.filter((event) => !references.some((reference) => event.id.startsWith(`fr-alert:${reference}:`)));
    if (["cancel", "cancellation", "annulation"].includes(msgType)) { parseable += 1; continue; }
    const infos = Array.isArray(raw.infos) ? raw.infos : [];
    if (infos.length === 0) { invalid += 1; locations.forEach(({ id }) => unavailable.add(id)); continue; }
    let recordParsed = false;
    for (const info of infos) {
      let affectedIds: string[] | null = null;
      try {
        const severity = capSeverity(info["sévérité"] || info.severite || info.severity || info.niveau);
        const timezone = info.fuseauHoraire || raw.fuseauHoraire;
        const starts = frDate(info.dateEffective || info.effective || info.dateDébut, timezone);
        const ends = frDate(info["dateExpiré"] || info.dateExpire || info.expires, timezone);
        const updated = frDate(raw.dateEmission || raw.sent || info.dateEffective, timezone);
        if (Number.isFinite(starts) && Number.isFinite(ends) && Math.max(starts, ends) <= context.now.getTime()) {
          recordParsed = true;
          continue;
        }
        const areas = frPolygons(info);
        if (areas.length) affectedIds = matchingLocations(areas, locations).map(({ id }) => id);
        const headline = cleanText(info.titre || info.headline);
        if (!severity || !Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends || !Number.isFinite(updated) || !areas.length || headline.length < 3) throw new Error("Incomplete FR-Alert record");
        recordParsed = true;
        if (!overlapsNextDay(starts, ends, context.now) || isDuplicativeCategory(info)) continue;
        const affected = locations.filter(({ id }) => affectedIds!.includes(id));
        const hazard = structuredHazard([info.categorie, info["catégorie"], info.category, info.eventCode, info.evenement, info["événement"]]);
        const explanation = (cleanText(info.description || info.consigne) || headline).slice(0, 500);
        const action = (cleanText(info.instruction || info.consigne) || "Follow instructions from French authorities and monitor FR-Alert for updates.").slice(0, 300);
        const areaLabel = cleanText(first((info.areas || [])[0]?.descriptionZone));
        for (const location of affected) events.push({
          id: `fr-alert:${identifier}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
          type: hazard, level: severity, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE",
          headline: headline.slice(0, 180), explanation, action, affectedArea: (areaLabel || location.name).slice(0, 200),
          geometry: { kind: "locations", ids: [location.id] }, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(),
          sourceUpdatedAt: new Date(updated).toISOString(), checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(),
          sourceName: "FR-Alert", sourceUrl: ARCHIVE_URL, confidence: "HIGH",
        });
      } catch {
        invalid += 1;
        (affectedIds || locations.map(({ id }) => id)).forEach((id) => unavailable.add(id));
      }
    }
    if (recordParsed) parseable += 1;
  }
  if (exported.length > 0 && parseable === 0) throw new Error("FR-Alert export contains no parseable records");
  return { events: limitEvents(events), invalid, unavailableLocationIds: [...unavailable].sort() };
}

export async function fetchFrPartition(context: IngestionContext): Promise<NationalPartition> {
  const locations = countryLocations(context, "FR");
  const fetchImpl = withFrAlertTlsFallback(context.fetch);
  const head = await fetchWithRetry(fetchImpl, ARCHIVE_URL, { method: "HEAD" }, 2, 128 * 1024, undefined, 8_000);
  const modifiedHeader = head.headers.get("last-modified");
  const modified = modifiedHeader && Number.isFinite(Date.parse(modifiedHeader)) ? new Date(modifiedHeader).toISOString() : null;
  const previous = context.state?.sourcePartitions.nationalCivilAlerts.FR;
  const previousUpdated = previous?.sourceUpdatedAt;
  if (modified && previous?.status === "ok" && previousUpdated === modified) return {
    status: "ok", sourceUpdatedAt: modified, events: retainedCountryEvents(context, "FR", "fr-alert:"), error: null,
    checkedLocationIds: locations.map(({ id }) => id), unavailableLocationIds: [],
  };
  let archiveResponse: Response;
  try { archiveResponse = await fetchWithRetry(fetchImpl, ARCHIVE_URL, {}, 2, ARCHIVE_LIMIT, undefined, 12_000); }
  catch (error) {
    if (isResponseLimit(error)) return limitPartial(context, "FR-Alert archive response limit reached");
    throw error;
  }
  const archive = parseFrArchive(await archiveResponse.text(), context.now);
  if (archive.identifiers.length === 0) return {
    status: "ok", sourceUpdatedAt: modified || context.now.toISOString(), events: [], error: null,
    checkedLocationIds: locations.map(({ id }) => id), unavailableLocationIds: [],
  };
  let exported: Response;
  try {
    exported = await fetchWithRetry(fetchImpl, EXPORT_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(archive.identifiers),
    }, 1, EXPORT_LIMIT, undefined, 25_000);
  } catch (error) {
    if (isResponseLimit(error)) return limitPartial(context, "FR-Alert export response limit reached");
    throw error;
  }
  const parsed = parseFrExports(await exported.json(), context);
  const partial = archive.overflow || parsed.invalid > 0;
  if (partial) return {
    status: "partial", sourceUpdatedAt: modified || context.now.toISOString(),
    events: archive.overflow ? [] : parsed.events.filter((event) => event.geometry.kind === "locations" && event.geometry.ids.every((id) => !parsed.unavailableLocationIds.includes(id))),
    error: archive.overflow ? "FR-Alert archive limit reached" : `${parsed.invalid} FR-Alert records were invalid`,
    checkedLocationIds: archive.overflow ? [] : locations.map(({ id }) => id).filter((id) => !parsed.unavailableLocationIds.includes(id)),
    unavailableLocationIds: archive.overflow ? locations.map(({ id }) => id) : parsed.unavailableLocationIds,
  };
  return {
    status: "ok", sourceUpdatedAt: modified || parsed.events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events: parsed.events, error: null, checkedLocationIds: locations.map(({ id }) => id), unavailableLocationIds: [],
  };
}
