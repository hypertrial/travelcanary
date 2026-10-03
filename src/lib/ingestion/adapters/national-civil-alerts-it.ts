import mappingJson from "../../../../data/italy-flood-zone-mapping.json";
import type { HazardLevel, NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted, fetchWithRetry } from "../fetch";
import type { IngestionContext } from "../types";
import { countryLocations, limitEvents, retainedCountryEvents, type NationalPartition } from "./national-civil-alerts-shared";

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

function italianLocalInstant(year: number, month: number, day: number, hour = 0, minute = 0) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
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

function italianDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function bulletinValidity(filename: string, now: Date) {
  const match = filename.match(/\/(\d{4})(\d{2})(\d{2})_\d{4}_(today|tomorrow)\.json$/);
  if (!match) throw new Error("Italian bulletin filename does not identify its validity period");
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (match[4] === "tomorrow" ? 1 : 0)));
  const starts = italianLocalInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
  const next = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
  const ends = italianLocalInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  if (ends <= now.getTime() || starts >= now.getTime() + 24 * 60 * 60_000) {
    return null;
  }
  return { date: day.toISOString().slice(0, 10).replaceAll("-", ""), startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString() };
}

function bulletinIssuance(filename: string, now: Date) {
  const match = filename.match(/\/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_(?:today|tomorrow)\.json$/)!;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error("Italian bulletin issuance is invalid");
  }
  const issued = italianLocalInstant(year, month, day, hour, minute);
  if (issued > now.getTime() + 5 * 60_000 || now.getTime() - issued > 36 * 60 * 60_000) throw new Error("Italian bulletin issuance is stale or future-dated");
  return new Date(issued).toISOString();
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
      id: `it:flood-bulletin:${italianDate(new Date(validity.startsAt)).replaceAll("-", "")}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
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
type CommitDetail = { files?: Array<{ filename?: unknown; status?: unknown }>; base_commit?: { sha?: unknown }; merge_base_commit?: { sha?: unknown } };

export async function fetchItPartition(context: IngestionContext): Promise<NationalPartition> {
  const budget = { remaining: 10 * 1024 * 1024 };
  const list = await fetchWithRetry(context.fetch, `${GITHUB_API}/commits?path=files/topojson&per_page=8`, {}, 1, 512 * 1024, budget, 2_000, "it_commits");
  const commits = await list.json() as Commit[];
  if (!Array.isArray(commits) || !commits.length || commits.length > 8) throw new Error("Italian bulletin commit list is empty or exceeds its limit");
  const commit = commits[0];
  const sha = String(commit.sha || "");
  if (commits.some(({ sha }) => !/^[a-f0-9]{40}$/.test(String(sha || "")))) throw new Error("Italian bulletin commit identifier is invalid");
  const updated = Date.parse(String(commit.commit?.committer?.date || ""));
  if (!Number.isFinite(updated) || updated > context.now.getTime() + 5 * 60_000 || context.now.getTime() - updated > 36 * 60 * 60_000) {
    throw new Error("Italian bulletin commit time is missing, stale, or future-dated");
  }
  const oldest = String(commits.at(-1)!.sha);
  const discovery = commits.length === 1 ? `commits/${sha}` : `compare/${oldest}...${sha}?per_page=1`;
  const response = await fetchWithRetry(context.fetch, `${GITHUB_API}/${discovery}`, {}, 1, 512 * 1024, budget, 2_000, "it_commit");
  const detail = await response.json() as CommitDetail;
  if (!Array.isArray(detail.files) || detail.files.length >= 300 || commits.length > 1
    && (detail.base_commit?.sha !== oldest || detail.merge_base_commit?.sha !== oldest)) throw new Error("Italian bulletin discovery is incomplete or truncated");
  const today = new Date(`${italianDate(context.now)}T00:00:00Z`);
  const required = [0, 1, 2].flatMap((offset) => {
    const date = new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const validity = bulletinValidity(`files/topojson/${date}_0000_today.json`, context.now);
    return validity ? [validity] : [];
  });
  // ponytail: inspect eight path commits; missing periods stay partial instead of unbounded history traversal.
  const selected = new Map<string, { filename: string; validity: NonNullable<ReturnType<typeof bulletinValidity>> }>();
  for (const file of detail.files) {
    const filename = String(file.filename || "");
    if (file.status === "removed" || !/^files\/topojson\/\d{8}_\d{4}_(?:today|tomorrow)\.json$/.test(filename)) continue;
    const validity = bulletinValidity(filename, context.now);
    if (validity && (!selected.has(validity.date) || filename > selected.get(validity.date)!.filename)) selected.set(validity.date, { filename, validity });
  }
  const periods = await Promise.all(required.map(async ({ date }) => {
    const file = selected.get(date);
    if (!file) return null;
    try {
      const issuedAt = bulletinIssuance(file.filename, context.now);
      const rawUrl = `https://raw.githubusercontent.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica/${sha}/${file.filename}`;
      const raw = await fetchAllowlisted(context.fetch, rawUrl, ["raw.githubusercontent.com"], 1, {
        maxBytes: 3 * 1024 * 1024, byteBudget: budget, timeoutMs: 3_000, diagnosticsCategory: "it_bulletin",
      });
      return { date, result: italianFloodBulletin(await raw.json(), context, issuedAt, file.validity) };
    } catch { return null; }
  }));
  const parsed = periods.filter((period) => period !== null);
  if (!parsed.length) throw new Error("Italian bulletin has no usable validity periods");
  const mappedIds = countryLocations(context, "IT").filter(({ id }) => mappings.some(({ locationId }) => locationId === id)).map(({ id }) => id);
  const missing = parsed.length !== required.length;
  const unavailable = new Set(missing ? mappedIds : parsed.flatMap(({ result }) => result.unavailableLocationIds || []));
  const complete = parsed.filter(({ result }) => result.status === "ok");
  const legacyIds = retainedCountryEvents(context, "IT", "it:flood-bulletin:").filter((event) =>
    /^it:flood-bulletin:\d{4}-\d{2}-\d{2}:/.test(event.id) && complete.some(({ date }) => {
      const validity = required.find((period) => period.date === date)!;
      return event.startsAt === validity.startsAt && event.endsAt === validity.endsAt;
    })).map(({ id }) => id);
  return {
    status: unavailable.size ? "partial" : "ok", sourceUpdatedAt: new Date(updated).toISOString(),
    events: limitEvents(parsed.flatMap(({ result }) => result.events)),
    checkedLocationIds: mappedIds.filter((id) => !unavailable.has(id)), unavailableLocationIds: [...unavailable].sort(),
    removedEventPrefixes: [...complete.map(({ date }) => `it:flood-bulletin:${date}:`), ...legacyIds],
    error: unavailable.size ? "Italian bulletin coverage is incomplete for the next 24 hours" : null,
  };
}
