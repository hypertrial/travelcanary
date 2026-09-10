import booleanIntersects from "@turf/boolean-intersects";
import { polygon } from "@turf/helpers";
import type { CountryCode, HazardLevel, HazardType, Location, NormalizedEvent, PartitionedSourceResult } from "../../domain/schemas";
import { locationPolygon } from "../../geospatial";
import { hazardLevelRank } from "../../hazard-lifecycle";
import type { IngestionContext } from "../types";

export type NationalPartition = PartitionedSourceResult["partitions"][CountryCode];

export function countryLocations(context: IngestionContext, countryCode: CountryCode): Location[] {
  return context.locations.filter((location) => location.countryCode === countryCode).sort((a, b) => a.id.localeCompare(b.id));
}

export function retainedCountryEvents(context: IngestionContext, countryCode: CountryCode, idPrefix: string): NormalizedEvent[] {
  const locationIds = new Set(countryLocations(context, countryCode).map(({ id }) => id));
  return (context.state?.events || []).filter((event): event is NormalizedEvent & { geometry: { kind: "locations"; ids: string[] } } => event.sourceId === "national-civil-alerts"
    && event.id.startsWith(idPrefix)
    && Date.parse(event.expiresAt) > context.now.getTime()
    && event.geometry.kind === "locations"
    && event.geometry.ids.some((id) => locationIds.has(id)));
}

export function capSeverity(value: unknown): HazardLevel | null {
  const normalized = String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
  if (normalized === "extreme") return "SEVERE";
  if (normalized === "severe") return "HIGH";
  if (["moderate", "minor", "unknown", "modere", "mineure", "inconnu"].includes(normalized)) return "ELEVATED";
  return null;
}

const SECURITY_CODES = new Set(["security", "securite", "law-enforcement", "terrorism", "military", "homeland", "civil-unrest", "armed-conflict"]);
const INDUSTRIAL_CODES = new Set(["industrial", "chemical", "hazmat", "hazardous-materials"]);
const NUCLEAR_CODES = new Set(["nuclear", "radiological", "radiation"]);

export function structuredHazard(values: unknown[]): HazardType {
  const flatten = (value: unknown): unknown[] => Array.isArray(value) ? value.flatMap(flatten)
    : value && typeof value === "object" ? Object.values(value).flatMap(flatten) : [value];
  const codes = values.flatMap(flatten).flatMap((value) => String(value || "").split(/[;,|]/))
    .map((value) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase())
    .filter(Boolean);
  const tokens = codes.flatMap((code) => [code, ...code.split(/[^a-z]+/)]);
  if (tokens.some((code) => NUCLEAR_CODES.has(code))) return "nuclear";
  if (tokens.some((code) => INDUSTRIAL_CODES.has(code))) return "industrial";
  if (tokens.some((code) => SECURITY_CODES.has(code))) return "security";
  return "civil-emergency";
}

export function cleanText(value: unknown): string {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function capPolygon(value: unknown) {
  const points = String(value || "").trim().split(/\s+/).map((pair) => {
    const [latitude, longitude] = pair.split(",").map(Number);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Invalid CAP polygon coordinate");
    return [longitude, latitude] as [number, number];
  });
  if (points.length < 4 || points[0][0] !== points.at(-1)![0] || points[0][1] !== points.at(-1)![1]) {
    throw new Error("CAP polygon must be a closed ring");
  }
  if (points.some(([longitude, latitude]) => Math.abs(latitude) > 90 || Math.abs(longitude) > 180)) {
    throw new Error("CAP polygon coordinate is out of range");
  }
  return polygon([points]);
}

export function capCircle(value: unknown) {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error("Invalid CAP circle");
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  const radiusKm = Number(match[3]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || radiusKm <= 0) throw new Error("Invalid CAP circle");
  const ring = Array.from({ length: 33 }, (_, index) => {
    const angle = (index % 32) / 32 * Math.PI * 2;
    return [
      longitude + Math.cos(angle) * radiusKm / (111.32 * Math.cos(latitude * Math.PI / 180)),
      latitude + Math.sin(angle) * radiusKm / 110.574,
    ] as [number, number];
  });
  return polygon([ring]);
}

export function matchingLocations(areas: ReturnType<typeof polygon>[], locations: Location[]): Location[] {
  return locations.filter((location) => areas.some((area) => {
    try { return booleanIntersects(area, locationPolygon(location)); } catch { return false; }
  }));
}

export function overlapsNextDay(startsAt: number, endsAt: number, now: Date): boolean {
  return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt < endsAt
    && endsAt > now.getTime() && startsAt < now.getTime() + 24 * 60 * 60_000;
}

export function limitEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const uniqueEvents = new Map<string, NormalizedEvent>();
  for (const event of events.slice().sort((a, b) => Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt)
    || a.id.localeCompare(b.id) || a.headline.localeCompare(b.headline))) {
    if (!uniqueEvents.has(event.id)) uniqueEvents.set(event.id, event);
  }
  const byLocation = new Map<string, NormalizedEvent[]>();
  for (const event of uniqueEvents.values()) {
    if (event.geometry.kind !== "locations") continue;
    for (const id of event.geometry.ids) byLocation.set(id, [...(byLocation.get(id) || []), event]);
  }
  const selected = new Map<string, NormalizedEvent>();
  for (const id of [...byLocation.keys()].sort()) for (const event of (byLocation.get(id) || [])
    .sort((a, b) => hazardLevelRank[b.level] - hazardLevelRank[a.level]
      || Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt) || a.id.localeCompare(b.id))
    .slice(0, 2)) selected.set(event.id, event);
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function partitionFailure(context: IngestionContext, countryCode: CountryCode, error: unknown): NationalPartition {
  return {
    status: "failed", sourceUpdatedAt: null, events: [], error: String(error).slice(0, 300),
    checkedLocationIds: [], unavailableLocationIds: countryLocations(context, countryCode).map(({ id }) => id),
  };
}
