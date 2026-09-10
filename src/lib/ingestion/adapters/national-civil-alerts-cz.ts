import mapping from "../../../../data/chmi-hydrology-mapping.json";
import type { HazardLevel, NormalizedEvent } from "../../domain/schemas";
import { fetchWithRetry, mapConcurrent } from "../fetch";
import type { IngestionContext } from "../types";
import { limitEvents, retainedCountryEvents, type NationalPartition } from "./national-civil-alerts-shared";

export const CHMI_STATION_BASE = "https://opendata.chmi.cz/hydrology/now/data/";
export const CHMI_FLASH_URL = "https://opendata.chmi.cz/hydrology/product/data/flash_flood/risk_FF_web.json";
const mappedIds = mapping.mappings.map(({ locationId }) => locationId).sort();
type Station = typeof mapping.mappings[number]["stations"][number];
const numericField = (value: unknown) => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export function parseChmiStation(value: unknown, station: Station, context: IngestionContext): { value: number; updatedAt: string; level: HazardLevel } | null {
  if (![station.spa1, station.spa2, station.spa3].every(Number.isFinite) || station.spa1 >= station.spa2 || station.spa2 >= station.spa3) throw new Error("CHMI station SPA thresholds are invalid");
  const objects = value && typeof value === "object" ? (value as { objList?: unknown }).objList : null;
  if (!Array.isArray(objects)) throw new Error("CHMI station response has no objList");
  const object = objects.find((item) => item && typeof item === "object" && (item as { objID?: unknown }).objID === station.objID) as { tsList?: unknown } | undefined;
  if (!object || !Array.isArray(object.tsList)) throw new Error("CHMI station object changed");
  const series = object.tsList.find((item) => item && typeof item === "object" && (item as { tsConID?: unknown }).tsConID === station.kind) as { tsData?: unknown } | undefined;
  if (!series || !Array.isArray(series.tsData)) throw new Error("CHMI matching H/Q series is missing");
  const observations = series.tsData.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { dt?: unknown; value?: unknown };
    const time = Date.parse(String(row.dt || "")); const numeric = numericField(row.value);
    return Number.isFinite(time) && numeric !== null ? [{ time, numeric }] : [];
  }).sort((a, b) => b.time - a.time);
  const newest = observations[0];
  if (!newest || newest.time > context.now.getTime() + 5 * 60_000 || context.now.getTime() - newest.time > 2 * 60 * 60_000) throw new Error("CHMI station series is stale or future-dated");
  if (newest.numeric < station.spa1) return null;
  return { value: newest.numeric, updatedAt: new Date(newest.time).toISOString(), level: newest.numeric >= station.spa2 ? "HIGH" : "ELEVATED" };
}

export function parseChmiFlashFlood(value: unknown, context: IngestionContext): NormalizedEvent[] {
  if (!value || typeof value !== "object") throw new Error("CHMI flash-flood response is not an object");
  const envelope = value as { datumVytvoreni?: unknown; data?: unknown };
  const data = envelope.data;
  if (!data || typeof data !== "object") throw new Error("CHMI flash-flood response has no data");
  const record = data as Record<string, unknown>;
  if (!record.report || typeof record.report !== "object" || Array.isArray(record.report)) throw new Error("CHMI flash-flood report metadata is missing");
  const updated = Date.parse(String(envelope.datumVytvoreni || ""));
  if (!Number.isFinite(updated) || updated > context.now.getTime() + 5 * 60_000 || context.now.getTime() - updated > 30 * 60_000) throw new Error("CHMI flash-flood product is stale or future-dated");
  const collections = Object.entries(record).filter(([key]) => key !== "report");
  if (!collections.length) return [];
  if (collections.length !== 1 || !Array.isArray(collections[0][1])) throw new Error("CHMI flash-flood collection contract changed");
  const expiresAt = new Date(updated + 30 * 60_000).toISOString();
  return collections[0][1].flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error("CHMI flash-flood area is malformed");
    const area = raw as { name?: unknown; kod_orp_ruian?: unknown; riziko_grid?: unknown; riziko_povodi?: unknown; riziko_vysledne?: unknown; riziko_popis?: unknown };
    const name = String(area.name || "").trim(); const areaId = String(area.kod_orp_ruian || "").trim();
    const classes = [area.riziko_grid, area.riziko_povodi, area.riziko_vysledne].map(Number);
    if (!name || !areaId || classes.some((degree) => !Number.isInteger(degree)) || typeof area.riziko_popis !== "string") throw new Error("CHMI flash-flood area contract changed");
    if (classes.some((riskClass) => ![0, 1, 2, 3].includes(riskClass))) throw new Error("CHMI flash-flood risk class is undocumented");
    const degree = classes[2];
    if (degree === 0) return [];
    if (![1, 2, 3].includes(degree)) throw new Error("CHMI flash-flood degree is undocumented");
    const level = ({ 1: "ELEVATED", 2: "HIGH", 3: "SEVERE" } as const)[degree as 1 | 2 | 3];
    return mapping.mappings.flatMap((item) => item.orpCodes.includes(areaId) ? [{
      id: `cz:bulletin:${areaId}:${index}:${item.locationId}`, sourceId: "national-civil-alerts" as const, providerId: "national-civil-alerts" as const,
      type: "flood" as const, level, timing: "ACTIVE" as const, headline: `An official degree ${degree} flash-flood warning affects ${name}.`,
      explanation: "CHMI reports a structured nonzero flash-flood risk class for this area.", action: "Follow CHMI and local authority instructions and avoid flood-prone routes.",
      affectedArea: name, geometry: { kind: "locations" as const, ids: [item.locationId] }, startsAt: new Date(updated).toISOString(), endsAt: expiresAt,
      sourceUpdatedAt: new Date(updated).toISOString(), checkedAt: context.now.toISOString(), expiresAt, sourceName: "CHMI flash-flood warning", sourceUrl: CHMI_FLASH_URL, confidence: "HIGH" as const,
    }] : []);
  });
}

export async function fetchCzPartition(context: IngestionContext): Promise<NationalPartition> {
  const uniqueStations = new Map(mapping.mappings.flatMap((item) => item.stations.map((station) => [station.objID, station] as const)));
  const stationResults = await mapConcurrent([...uniqueStations.values()].slice(0, 64), 4, async (station) => {
    try {
      const value = await fetchWithRetry(context.fetch, `${CHMI_STATION_BASE}${station.objID}.json`, {}, 2, 64 * 1024, undefined, 4_000, "chmi_stations").then((response) => response.json());
      return { station, observation: parseChmiStation(value, station, context), error: null };
    } catch (error) { return { station, observation: null, error }; }
  });
  const stationFailures = stationResults.filter(({ error }) => error).length;
  const failedStationIds = new Set(stationResults.filter(({ error }) => error).map(({ station }) => station.objID));
  const stationUnavailableIds = mapping.mappings.filter((item) => item.stations.some(({ objID }) => failedStationIds.has(objID))).map(({ locationId }) => locationId);
  const observations = new Map(stationResults.flatMap(({ station, observation }) => observation ? [[station.objID, { station, ...observation }] as const] : []));
  const expiresAt = new Date(context.now.getTime() + 30 * 60_000).toISOString();
  const stationEvents: NormalizedEvent[] = mapping.mappings.flatMap((item) => {
    const best = item.stations.flatMap((station) => observations.get(station.objID) ? [observations.get(station.objID)!] : []).sort((a, b) => b.value - a.value)[0];
    if (!best) return [];
    const location = context.locations.find(({ id }) => id === item.locationId); if (!location) return [];
    return [{ id: `cz:measurement:${best.station.objID}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts", type: "flood", level: best.level, timing: "ACTIVE",
      headline: `${best.station.stream} at ${best.station.name} has crossed an official flood threshold.`, explanation: `CHMI reports ${best.value} ${best.station.kind === "H" ? "cm" : "m³/s"} at a reviewed station near ${location.name}.`,
      action: "Avoid affected waterways and follow CHMI and local authority instructions.", affectedArea: `${location.name} and ${best.station.stream}`, geometry: { kind: "locations", ids: [location.id] },
      startsAt: best.updatedAt, endsAt: expiresAt, sourceUpdatedAt: best.updatedAt, checkedAt: context.now.toISOString(), expiresAt, sourceName: "CHMI hydrology", sourceUrl: `${CHMI_STATION_BASE}${best.station.objID}.json`, confidence: "HIGH" } satisfies NormalizedEvent];
  });
  const bulletin = await fetchWithRetry(context.fetch, CHMI_FLASH_URL, {}, 2, 512 * 1024, undefined, 5_000, "chmi_flash")
    .then((response) => response.json()).then((value) => ({ events: parseChmiFlashFlood(value, context), error: null })).catch((error) => ({ events: retainedCountryEvents(context, "CZ", "cz:bulletin:"), error }));
  const partial = stationFailures > 0 || Boolean(bulletin.error);
  const unavailableLocationIds = [...new Set([...(bulletin.error ? mappedIds : []), ...stationUnavailableIds])].sort();
  const retainedMeasurements = stationFailures ? retainedCountryEvents(context, "CZ", "cz:measurement:")
    .filter((event) => [...failedStationIds].some((id) => event.id.startsWith(`cz:measurement:${id}:`))) : [];
  const events = limitEvents([...stationEvents, ...bulletin.events, ...retainedMeasurements]);
  const removedEventPrefixes = [
    ...(!bulletin.error ? ["cz:bulletin:"] : []),
    ...stationResults.filter(({ error }) => !error).map(({ station }) => `cz:measurement:${station.objID}:`),
  ];
  return { status: partial ? "partial" : "ok", sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || context.now.toISOString(), events,
    error: [stationFailures ? `${stationFailures} CHMI station requests failed` : null, bulletin.error ? String(bulletin.error) : null].filter(Boolean).join("; ").slice(0, 300) || null,
    checkedLocationIds: mappedIds.filter((id) => !unavailableLocationIds.includes(id)), unavailableLocationIds, removedEventPrefixes };
}
