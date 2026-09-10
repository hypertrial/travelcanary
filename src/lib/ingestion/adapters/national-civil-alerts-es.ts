import type { NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import { type NationalPartition } from "./national-civil-alerts-shared";

const host = "analisi.transparenciacatalunya.cat";
export const cataloniaLocationIds = ["es-barcelona", "es-badalona", "es-l-hospitalet-de-llobregat", "es-sabadell", "es-terrassa"] as const;
type Plan = { plaacronim?: unknown; planom?: unknown; plafase?: unknown; plaactivat?: unknown; fasedatahora?: unknown; comunicatpdf?: unknown; descripcio?: unknown };

function normalizedPhase(value: unknown) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toUpperCase();
}

function cataloniaTimestamp(value: unknown): number {
  const text = String(value || "").trim();
  const local = text.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  if (!local) return /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
  const [, day, month, year, hour, minute] = local;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  // Validate both CET/CEST candidates by round-tripping; reject impossible or
  // ambiguous civil times instead of depending on the server's timezone.
  const candidates = [1, 2].map((offset) => utc - offset * 60 * 60_000).filter((instant) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}` === text;
  });
  return candidates.length === 1 ? candidates[0] : NaN;
}

export function cataloniaPartition(value: unknown, context: IngestionContext): NationalPartition {
  if (!Array.isArray(value)) throw new Error("Catalonia plan-status response is not an array");
  const scoped = context.locations.filter(({ id }) => cataloniaLocationIds.includes(id as typeof cataloniaLocationIds[number]));
  const events: NormalizedEvent[] = [];
  const removed = new Set<string>();
  let invalid = 0;
  for (const plan of (value as Plan[]).slice(0, 100)) {
    const phase = normalizedPhase(plan.plafase);
    if (!["ALERTA", "EMERGENCIA", "PREALERTA"].includes(phase)) continue;
    const id = String(plan.plaacronim || plan.planom || "").trim();
    const updated = cataloniaTimestamp(plan.fasedatahora);
    if (!id || !Number.isFinite(updated) || updated > context.now.getTime() + 5 * 60_000) { invalid += 1; continue; }
    if (phase === "PREALERTA") { removed.add(`catalonia-plan:${id}`); continue; }
    const expiresAt = new Date(context.now.getTime() + 30 * 60_000).toISOString();
    const documentUrl = typeof plan.comunicatpdf === "object" && plan.comunicatpdf !== null
      ? (plan.comunicatpdf as { url?: unknown }).url : plan.comunicatpdf;
    const sourceUrl = typeof documentUrl === "string" && /^https:\/\//.test(documentUrl) ? documentUrl : "https://interior.gencat.cat/ca/arees_dactuacio/proteccio_civil/";
    events.push({
      id: `catalonia-plan:${id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts", type: "civil-emergency", level: "ELEVATED", timing: "ACTIVE",
      headline: `${String(plan.planom || id).slice(0, 140)} is in ${String(plan.plafase).toUpperCase()} phase.`,
      explanation: `${String(plan.descripcio || "Catalonia civil protection reports an active emergency-plan phase.").slice(0, 430)} This is context only, not monitored civil-warning coverage.`,
      action: "Check Catalonia Civil Protection updates and follow instructions from local authorities.", affectedArea: "Five catalog destinations in Catalonia",
      geometry: { kind: "locations", ids: scoped.map(({ id: locationId }) => locationId).sort() }, startsAt: new Date(updated).toISOString(), endsAt: expiresAt,
      sourceUpdatedAt: new Date(updated).toISOString(), checkedAt: context.now.toISOString(), expiresAt, sourceName: "Protecció Civil de Catalunya", sourceUrl, confidence: "HIGH",
    });
  }
  const overflow = value.length > 100;
  recordSourceDiagnostics(context, { recordsExamined: value.length, targetsScheduled: scoped.length, targetsCompleted: invalid || overflow ? 0 : scoped.length, matchedLocations: events.length ? scoped.length : 0, overflowCode: overflow ? "catalonia_record_limit" : undefined });
  const partial = invalid > 0 || overflow;
  return { status: partial ? "partial" : "ok", sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(), events: events.sort((a, b) => a.id.localeCompare(b.id)), error: partial ? `${invalid} malformed Catalonia records${overflow ? "; input limit reached" : ""}` : null, checkedLocationIds: partial ? [] : scoped.map(({ id }) => id), unavailableLocationIds: partial ? scoped.map(({ id }) => id) : [], removedEventPrefixes: partial ? [...removed].sort() : ["catalonia-plan:"] };
}

export async function fetchEsPartition(context: IngestionContext) {
  const url = `https://${host}/resource/wj9c-j6vf.json?$limit=101`;
  const response = await fetchAllowlisted(context.fetch, url, [host], 3, { maxBytes: 512 * 1024, diagnosticsCategory: "catalonia" });
  return cataloniaPartition(await response.json(), context);
}
