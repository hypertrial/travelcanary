import mappingJson from "../../../../data/italy-flood-zone-mapping.json";
import type { HazardLevel, NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted, fetchWithRetry } from "../fetch";
import type { IngestionContext } from "../types";
import { countryLocations, limitEvents, type NationalPartition } from "./national-civil-alerts-shared";

const GITHUB_API = "https://api.github.com/repos/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica";
const OFFICIAL_URL = "https://mappe.protezionecivile.gov.it/it/mappe-rischi/bollettino-di-criticita/";
const RISK_FIELDS = ["Rappresentata nella mappa", "Per rischio idraulico", "Per rischio temporali", "Per rischio idrogeologico"] as const;
const mappings = mappingJson.mappings as Array<{ locationId: string; zoneNames: string[] }>;

type BulletinGeometry = { properties?: Record<string, unknown> };
type Bulletin = { type?: unknown; objects?: Record<string, { geometries?: BulletinGeometry[] }> };

function bulletinLevel(value: unknown): HazardLevel | null | "empty" {
  const text = String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
  if (text.includes("NESSUNA ALLERTA") || text.includes("ASSENZA DI FENOMENI")) return "empty";
  if (text.includes("ALLERTA ROSSA")) return "SEVERE";
  if (text.includes("ALLERTA ARANCIONE")) return "HIGH";
  if (text.includes("ALLERTA GIALLA")) return "ELEVATED";
  return null;
}

const levelRank: Record<HazardLevel, number> = { ELEVATED: 1, HIGH: 2, SEVERE: 3 };

function italianLocalInstant(year: number, month: number, day: number) {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let instant = targetAsUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
    instant += targetAsUtc - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }
  return instant;
}

function bulletinValidity(filename: string, now: Date) {
  const match = filename.match(/\/(\d{4})(\d{2})(\d{2})_\d{4}_(today|tomorrow)\.json$/);
  if (!match) throw new Error("Italian bulletin filename does not identify its validity period");
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (match[4] === "tomorrow" ? 1 : 0)));
  const starts = italianLocalInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
  const next = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
  const ends = italianLocalInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  if (ends <= now.getTime() || starts >= now.getTime() + 24 * 60 * 60_000) {
    throw new Error("Italian bulletin validity does not intersect the next 24 hours");
  }
  return { startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString() };
}

export function italianFloodBulletin(
  value: unknown,
  context: IngestionContext,
  sourceUpdatedAt = context.now.toISOString(),
  validity = { startsAt: context.now.toISOString(), endsAt: new Date(context.now.getTime() + 24 * 60 * 60_000).toISOString() },
): NationalPartition {
  const bulletin = value as Bulletin;
  if (bulletin?.type !== "Topology" || !bulletin.objects || typeof bulletin.objects !== "object") throw new Error("Italian bulletin is not a Topology document");
  const geometries = Object.values(bulletin.objects).flatMap(({ geometries: items }) => items || []);
  if (geometries.length < 150) throw new Error("Italian bulletin does not contain the complete warning-zone set");
  const byZone = new Map<string, HazardLevel | "empty">();
  let invalid = 0;
  for (const geometry of geometries) {
    const name = String(geometry.properties?.["Nome zona"] || "").trim();
    if (!name) { invalid += 1; continue; }
    const values = RISK_FIELDS.map((field) => bulletinLevel(geometry.properties?.[field]));
    if (values.some((level) => level === null)) { invalid += 1; continue; }
    const active = values.filter((level): level is HazardLevel => level !== "empty" && level !== null)
      .sort((a, b) => levelRank[b] - levelRank[a])[0];
    byZone.set(name, active || "empty");
  }
  if (!byZone.size || invalid > Math.max(5, Math.floor(geometries.length * 0.05))) throw new Error("Italian bulletin contains undocumented zone or severity records");
  const knownLocations = new Map(countryLocations(context, "IT").map((location) => [location.id, location]));
  const checkedLocationIds: string[] = [];
  const unavailableLocationIds: string[] = [];
  const events: NormalizedEvent[] = [];
  for (const mapping of mappings) {
    const location = knownLocations.get(mapping.locationId);
    if (!location) continue;
    const levels = mapping.zoneNames.map((name) => byZone.get(name));
    if (levels.some((level) => level === undefined)) { unavailableLocationIds.push(location.id); continue; }
    checkedLocationIds.push(location.id);
    const level = levels.filter((item): item is HazardLevel => item !== "empty" && item !== undefined)
      .sort((a, b) => levelRank[b] - levelRank[a])[0];
    if (!level) continue;
    events.push({
      id: `it:flood-bulletin:${sourceUpdatedAt.slice(0, 10)}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
      type: "flood", level, timing: Date.parse(validity.startsAt) > context.now.getTime() ? "UPCOMING" : "ACTIVE", headline: `Official flood warning affects ${location.name}`,
      explanation: "Italian Civil Protection reports hydrogeological or hydraulic warning conditions for this official warning zone.",
      action: "Follow local civil-protection instructions and avoid flooded or fast-flowing areas.", affectedArea: location.name,
      geometry: { kind: "locations", ids: [location.id] }, startsAt: validity.startsAt, endsAt: validity.endsAt,
      sourceUpdatedAt, checkedAt: context.now.toISOString(), expiresAt: validity.endsAt,
      sourceName: "Italian Civil Protection national flood bulletin", sourceUrl: OFFICIAL_URL, confidence: "HIGH",
    });
  }
  return {
    status: unavailableLocationIds.length ? "partial" : "ok", sourceUpdatedAt, events: limitEvents(events),
    error: unavailableLocationIds.length ? `${unavailableLocationIds.length} destinations could not be matched to the complete zone set` : null,
    checkedLocationIds, unavailableLocationIds,
  };
}

type Commit = { sha?: unknown; commit?: { committer?: { date?: unknown } } };
type CommitDetail = { files?: Array<{ filename?: unknown; status?: unknown; raw_url?: unknown }> };

export async function fetchItPartition(context: IngestionContext): Promise<NationalPartition> {
  const list = await fetchWithRetry(context.fetch, `${GITHUB_API}/commits?path=files/topojson&per_page=1`, {}, 2, 512 * 1024, undefined, 5_000, "it_commits");
  const commits = await list.json() as Commit[];
  if (!Array.isArray(commits) || !commits.length) throw new Error("Italian bulletin commit list is empty");
  const commit = commits[0];
  const sha = String(commit.sha || "");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Italian bulletin commit identifier is invalid");
  const response = await fetchWithRetry(context.fetch, `${GITHUB_API}/commits/${sha}`, {}, 1, 512 * 1024, undefined, 4_000, "it_commit");
  const detail = await response.json() as CommitDetail;
  const file = (detail.files || []).find(({ filename, status }) => status !== "removed"
    && /^files\/topojson\/\d{8}_\d{4}_(?:today|tomorrow)\.json$/.test(String(filename || "")));
  if (!file || typeof file.raw_url !== "string") throw new Error("Latest Italian topology commit does not contain a current bulletin JSON");
  const filename = String(file.filename);
  const rawUrl = `https://raw.githubusercontent.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica/${sha}/${filename}`;
  const raw = await fetchAllowlisted(context.fetch, rawUrl, ["raw.githubusercontent.com"], 1, {
    maxBytes: 3 * 1024 * 1024, diagnosticsCategory: "it_bulletin",
  });
  const updated = Date.parse(String(commit.commit?.committer?.date || ""));
  if (!Number.isFinite(updated) || updated > context.now.getTime() + 5 * 60_000 || context.now.getTime() - updated > 36 * 60 * 60_000) {
    throw new Error("Italian bulletin commit time is missing, stale, or future-dated");
  }
  return italianFloodBulletin(await raw.json(), context, new Date(updated).toISOString(), bulletinValidity(filename, context.now));
}
