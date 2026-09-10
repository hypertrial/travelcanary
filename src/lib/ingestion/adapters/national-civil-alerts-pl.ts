import mapping from "../../../../data/imgw-hydrology-mapping.json";
import type { HazardLevel, NormalizedEvent } from "../../domain/schemas";
import { fetchWithRetry } from "../fetch";
import type { IngestionContext } from "../types";
import { limitEvents, retainedCountryEvents, type NationalPartition } from "./national-civil-alerts-shared";

export const IMGW_HYDRO_URL = "https://danepubliczne.imgw.pl/api/data/hydro/";
export const IMGW_BULLETIN_DIRECTORY = "https://danepubliczne.imgw.pl/data/current/ost_hydro/";
const MAX_CURRENT_BULLETINS = 32;

type ImgRow = Record<string, unknown>;
const mappedIds = mapping.mappings.map(({ locationId }) => locationId).sort();
const stations = new Map<string, Array<typeof mapping.mappings[number]>>();
for (const item of mapping.mappings) for (const id of item.stationIds) stations.set(id, [...(stations.get(id) || []), item]);
const normalize = (value: unknown) => String(value || "").toLocaleLowerCase("pl").replace(/ł/g, "l")
  .normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
const VOIVODESHIP_TOKENS = new Set([
  "dolnoslaskie", "kujawsko pomorskie", "lubelskie", "lodzkie", "malopolskie", "mazowieckie",
  "podkarpackie", "podlaskie", "pomorskie", "slaskie", "swietokrzyskie", "warminsko mazurskie",
  "wielkopolskie", "zachodniopomorskie",
]);

function polishLocalTime(value: unknown): number {
  const text = String(value || "").trim();
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!local) return Date.parse(text);
  const target = local.slice(1).map(Number);
  const targetAsUtc = Date.UTC(target[0], target[1] - 1, target[2], target[3], target[4], target[5]);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let instant = targetAsUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
    const renderedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += targetAsUtc - renderedAsUtc;
  }
  return instant;
}

function imgwMeasurementTime(value: unknown): number {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? Date.parse(`${text.replace(" ", "T")}Z`)
    : Date.parse(text);
}

function numericField(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function parseImgwMeasurements(value: unknown, context: IngestionContext) {
  if (!Array.isArray(value)) throw new Error("IMGW hydrology response is not an array");
  const events: NormalizedEvent[] = [];
  const staleStationIds = new Set<string>();
  const usableStationIds = new Set<string>();
  let parseable = 0;
  let invalid = 0;
  for (const raw of value as ImgRow[]) {
    const stationId = String(raw.id_stacji || "").trim();
    const destinations = stations.get(stationId);
    if (!destinations) continue;
    const measuredAt = imgwMeasurementTime(raw.stan_wody_data_pomiaru);
    const water = numericField(raw.stan_wody);
    const warning = numericField(raw.stan_ostrzegawczy);
    const alarm = numericField(raw.stan_alarmowy);
    if (!Number.isFinite(measuredAt) || water === null || warning === null || alarm === null) {
      invalid += 1;
      continue;
    }
    parseable += 1;
    if (measuredAt > context.now.getTime() + 5 * 60_000 || context.now.getTime() - measuredAt > 2 * 60 * 60_000) {
      staleStationIds.add(stationId);
      continue;
    }
    usableStationIds.add(stationId);
    const level: HazardLevel | null = alarm > 0 && water >= alarm ? "HIGH" : warning > 0 && water >= warning ? "ELEVATED" : null;
    if (!level) continue;
    const expiresAt = new Date(context.now.getTime() + 30 * 60_000).toISOString();
    for (const destination of destinations) {
      const location = context.locations.find(({ id }) => id === destination.locationId);
      if (!location) continue;
      events.push({
        id: `pl:measurement:${stationId}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
        type: "flood", level, timing: "ACTIVE", headline: `${String(raw.rzeka || "A river")} at ${String(raw.stacja || stationId)} has crossed an official flood threshold.`,
        explanation: `IMGW reports ${water} cm, at or above the official ${level === "HIGH" ? "alarm" : "warning"} threshold for a reviewed station near ${location.name}.`,
        action: "Avoid affected riverbanks and follow IMGW and local authority instructions.", affectedArea: `${location.name} and the ${String(raw.rzeka || "nearby river")}`,
        geometry: { kind: "locations", ids: [location.id] }, startsAt: new Date(measuredAt).toISOString(), endsAt: expiresAt,
        sourceUpdatedAt: new Date(measuredAt).toISOString(), checkedAt: context.now.toISOString(), expiresAt,
        sourceName: "IMGW-PIB hydrology data · processed by TravelCanary", sourceUrl: IMGW_HYDRO_URL, confidence: "HIGH",
      });
    }
  }
  if (value.length && parseable === 0) throw new Error("IMGW response contains no parseable mapped measurements");
  const missingLocationIds = mapping.mappings.filter((item) => !item.stationIds.some((id) => usableStationIds.has(id))).map(({ locationId }) => locationId);
  const staleLocationIds = mapping.mappings.filter((item) => missingLocationIds.includes(item.locationId)
    && item.stationIds.some((id) => staleStationIds.has(id))).map(({ locationId }) => locationId);
  return { events, invalid, unavailableLocationIds: missingLocationIds.sort(), staleLocationIds: staleLocationIds.sort(), missingLocationIds: missingLocationIds.sort() };
}

function bulletinField(text: string, label: string) {
  return text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]+)`, "i"))?.[1]?.trim() || "";
}

function imgwBulletinTime(value: string): number {
  const polish = value.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s*-)?\s*(?:godz\.?\s*)?(\d{2}):(\d{2})$/i);
  return polish ? polishLocalTime(`${polish[3]}-${polish[2]}-${polish[1]} ${polish[4]}:${polish[5]}:00`) : polishLocalTime(value.replace(/\s*UTC$/i, "Z"));
}

function imgwValidity(text: string) {
  const match = text.match(/Wa[zż]no[sś][cć]\s*:\s*od\s+godz\.?\s*(\d{2}):(\d{2})\s+dnia\s+(\d{2})\.(\d{2})\.(\d{4})\s+do\s+godz\.?\s*(\d{2}):(\d{2})\s+dnia\s+(\d{2})\.(\d{2})\.(\d{4})/i);
  if (!match) throw new Error("IMGW bulletin has no documented validity window");
  const start = polishLocalTime(`${match[5]}-${match[4]}-${match[3]} ${match[1]}:${match[2]}:00`);
  const end = polishLocalTime(`${match[10]}-${match[9]}-${match[8]} ${match[6]}:${match[7]}:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("IMGW bulletin has an invalid validity window");
  return { start, end };
}

function includesToken(area: string, token: string) {
  return ` ${area} `.includes(` ${normalize(token)} `);
}

function bulletinMatches(area: string, tokens: string[]) {
  if (includesToken(area, tokens[0])) return true;
  const normalized = tokens.slice(1).map(normalize);
  const regions = normalized.filter((token) => VOIVODESHIP_TOKENS.has(token));
  const waters = normalized.filter((token) => !VOIVODESHIP_TOKENS.has(token));
  return regions.some((token) => includesToken(area, token)) && waters.some((token) => includesToken(area, token));
}

export function parseImgwBulletin(text: string, url: string, context: IngestionContext): NormalizedEvent[] {
  // IMGW shares this directory with ungraded, open-ended drought notices and
  // their cancellations. They are not part of this flood-only transport.
  if (normalize(bulletinField(text, "Zjawisko")) === "susza hydrologiczna") return [];
  const degree = Number(bulletinField(text, "Stopień"));
  if (![1, 2, 3].includes(degree)) throw new Error("IMGW bulletin has an undocumented degree");
  const area = bulletinField(text, "Obszar");
  const normalizedArea = normalize(area);
  if (!area) throw new Error("IMGW bulletin has no area");
  const issuedText = bulletinField(text, "Data i godzina wydania") || bulletinField(text, "Data wydania");
  const issuedAt = imgwBulletinTime(issuedText);
  if (!Number.isFinite(issuedAt) || issuedAt > context.now.getTime() + 5 * 60_000) throw new Error("IMGW bulletin has an invalid issue time");
  const validity = imgwValidity(text);
  if (validity.end <= context.now.getTime() || validity.start > context.now.getTime() + 24 * 60 * 60_000) return [];
  const sourceUpdatedAt = new Date(issuedAt).toISOString();
  const level = ({ 1: "ELEVATED", 2: "HIGH", 3: "SEVERE" } as const)[degree as 1 | 2 | 3];
  const endsAt = new Date(Math.min(validity.end, context.now.getTime() + 24 * 60 * 60_000)).toISOString();
  const startsAt = new Date(validity.start).toISOString();
  const number = normalize(bulletinField(text, "Ostrzeżenie hydrologiczne Nr") || bulletinField(text, "Numer ostrzeżenia") || url.split("/").at(-1)).replace(/\s/g, "-");
  const displayArea = area.slice(0, 200);
  return mapping.mappings.flatMap((item) => {
    if (!bulletinMatches(normalizedArea, item.bulletinTokens)) return [];
    const location = context.locations.find(({ id }) => id === item.locationId);
    if (!location) return [];
    return [{
      id: `pl:bulletin:${number || "current"}:${location.id}`, sourceId: "national-civil-alerts" as const, providerId: "national-civil-alerts" as const,
      type: "flood" as const, level, timing: validity.start > context.now.getTime() ? "UPCOMING" as const : "ACTIVE" as const, headline: `An official degree ${degree} hydrological warning affects ${location.name}.`,
      explanation: `IMGW has issued a structured hydrological warning for ${displayArea}.`, action: "Follow IMGW and local authority instructions and avoid affected waterways.",
      affectedArea: displayArea, geometry: { kind: "locations" as const, ids: [location.id] }, startsAt, endsAt,
      sourceUpdatedAt, checkedAt: context.now.toISOString(), expiresAt: endsAt, sourceName: "IMGW-PIB hydrological warning · processed by TravelCanary", sourceUrl: url, confidence: "HIGH" as const,
    }];
  });
}

export function currentImgwBulletinNames(html: string) {
  const names = [...new Set([...html.matchAll(/href=["']([^"']+\.TXT)["']/gi)].map((match) => match[1]))].sort();
  if (names.length > MAX_CURRENT_BULLETINS) throw new Error(`IMGW current bulletin directory exceeds the ${MAX_CURRENT_BULLETINS}-file completeness limit`);
  return names;
}

export async function fetchPlPartition(context: IngestionContext): Promise<NationalPartition> {
  const bytes = { remaining: 3 * 1024 * 1024 };
  const measurements = await fetchWithRetry(context.fetch, IMGW_HYDRO_URL, {}, 2, 1024 * 1024, bytes, 5_000, "imgw_measurements")
    .then((response) => response.json()).then((value) => parseImgwMeasurements(value, context)).catch((error) => ({ events: retainedCountryEvents(context, "PL", "pl:measurement:"), invalid: 0, unavailableLocationIds: mappedIds, staleLocationIds: [], missingLocationIds: mappedIds, error }));
  const bulletins = await fetchWithRetry(context.fetch, IMGW_BULLETIN_DIRECTORY, {}, 2, 256 * 1024, bytes, 5_000, "imgw_directory").then(async (response) => {
    const html = await response.text();
    const names = currentImgwBulletinNames(html);
    const settled = await Promise.allSettled(names.map(async (name) => {
      const url = new URL(name, IMGW_BULLETIN_DIRECTORY).toString();
      const text = await fetchWithRetry(context.fetch, url, {}, 1, 64 * 1024, bytes, 4_000, "imgw_bulletins").then((item) => item.text());
      return parseImgwBulletin(text, url, context);
    }));
    const failed = settled.filter(({ status }) => status === "rejected").length;
    return { events: settled.flatMap((item) => item.status === "fulfilled" ? item.value : []), error: failed ? new Error(`${failed} IMGW bulletins failed`) : null };
  }).catch((error) => ({ events: retainedCountryEvents(context, "PL", "pl:bulletin:"), error }));
  const unavailableLocationIds = [...new Set([...(bulletins.error ? mappedIds : []), ...measurements.unavailableLocationIds])].sort();
  const retainedMeasurements = !("error" in measurements) && measurements.unavailableLocationIds.length ? retainedCountryEvents(context, "PL", "pl:measurement:")
    .filter((event) => event.geometry.kind === "locations" && event.geometry.ids.some((id) => measurements.unavailableLocationIds.includes(id))) : [];
  const errors = [("error" in measurements) ? measurements.error : null, measurements.invalid ? `${measurements.invalid} IMGW measurements were malformed` : null,
    measurements.staleLocationIds.length ? `${measurements.staleLocationIds.length} IMGW mapped destinations had stale or future-dated measurements` : null,
    measurements.missingLocationIds.length ? `${measurements.missingLocationIds.length} IMGW mapped destinations had no usable measurement` : null, bulletins.error].filter(Boolean);
  // Clear only the successful subtransport, including healthy-empty results.
  const removedEventPrefixes = [
    ...(!bulletins.error ? ["pl:bulletin:"] : []),
    ...mapping.mappings.filter(({ locationId }) => !measurements.unavailableLocationIds.includes(locationId))
      .flatMap(({ stationIds, locationId }) => stationIds.map((id) => `pl:measurement:${id}:${locationId}`)),
  ];
  return {
    status: errors.length ? "partial" : "ok", sourceUpdatedAt: [...measurements.events, ...bulletins.events].map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events: limitEvents([...measurements.events, ...bulletins.events, ...retainedMeasurements]), error: errors.map(String).join("; ").slice(0, 300) || null,
    checkedLocationIds: mappedIds.filter((id) => !unavailableLocationIds.includes(id)), unavailableLocationIds, removedEventPrefixes,
  };
}
