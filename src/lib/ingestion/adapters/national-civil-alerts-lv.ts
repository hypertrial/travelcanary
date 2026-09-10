import { z } from "zod";
import { polygon } from "@turf/helpers";
import type { NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import { countryLocations, matchingLocations, overlapsNextDay, type NationalPartition } from "./national-civil-alerts-shared";

export const latviaResources = {
  warnings: "59c111fb-8c9a-4a63-8284-0a64a2920681",
  polygons: "01dc7d3c-34e5-4cc3-8f1a-aaf022872a02",
  warningMunicipalities: "995139f7-ec05-489a-b2bb-732d5cf7ca7b",
  municipalities: "50aba289-6571-4ba7-9331-a7c1f5f9e19e",
} as const;
export const latviaWarningUrl = "https://data.gov.lv/dati/dataset/hidrometeorologiskie-bridinajumi";
const packageUrl = "https://data.gov.lv/dati/api/3/action/package_show?id=hidrometeorologiskie-bridinajumi";
const numeric = z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number)]);
const id = numeric.pipe(z.number().int().positive());
const warningSchema = z.object({ WEATHER_WARNING_EV_ID: id, PARADIBA_EN: z.string(), INTENSITY_EN: z.string(),
  TIME_FROM: z.string(), TIME_TILL: z.string(), REGIONS_EN: z.string(), TEKSTS_EN: z.string() });
const pointSchema = z.object({ WEATHER_WARNING_EV_ID: id, POLIGON_ID: id, NPK: id,
  LAT: numeric.pipe(z.number().min(-90).max(90)), LON: numeric.pipe(z.number().min(-180).max(180)) });
const joinSchema = z.object({ WEATHER_WARNING_EV_ID: id, NOV_ID: id });
const municipalitySchema = z.object({ NOV_ID: id, NOSAUKUMS_EN: z.string().min(1) });
// Exact named cities in the authority's municipality table. Regional destinations
// use warning polygons; city radii never borrow a neighbouring municipality's alert.
const cities: Record<string, { id: number; name: string }> = {
  "lv-daugavpils": { id: 36, name: "Daugavpils" }, "lv-jelgava": { id: 38, name: "Jelgava" },
  "lv-jurmala": { id: 39, name: "Jurmala" }, "lv-liepaja": { id: 40, name: "Liepaja" }, "lv-riga": { id: 43, name: "Riga" },
};
const localClock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Riga", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export function rigaWarningTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) throw new Error("Unsupported Latvian local timestamp");
  const naive = Date.parse(`${value}Z`);
  const candidates = [120, 180].map((offset) => naive - offset * 60_000).filter((time) => {
    if (!Number.isFinite(time)) return false;
    const p = Object.fromEntries(localClock.formatToParts(time).map((part) => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === value;
  });
  if (candidates.length !== 1) throw new Error("Ambiguous or nonexistent Latvian local timestamp");
  return candidates[0];
}

export type LatvianTables = { -readonly [K in keyof typeof latviaResources]: unknown[] };
export function parseLatvianWarnings(tables: LatvianTables, context: IngestionContext, sourceUpdatedAt: string): NationalPartition {
  const locations = countryLocations(context, "LV");
  const updated = Date.parse(sourceUpdatedAt);
  if (!Number.isFinite(updated) || updated > context.now.getTime() + 300_000) throw new Error("Invalid Latvian source update time");
  const warnings = z.array(warningSchema).max(500).parse(tables.warnings);
  const points = z.array(pointSchema).max(40_000).parse(tables.polygons);
  const joins = z.array(joinSchema).max(5000).parse(tables.warningMunicipalities);
  const municipalities = z.array(municipalitySchema).max(100).parse(tables.municipalities);
  const municipalityIds = new Set(municipalities.map((m) => m.NOV_ID));
  if (municipalityIds.size !== municipalities.length || Object.values(cities).some((c) => !municipalities.some((m) => m.NOV_ID === c.id && m.NOSAUKUMS_EN === c.name))) {
    throw new Error("Latvian municipality mapping changed");
  }
  const warningIds = new Set(warnings.map((w) => w.WEATHER_WARNING_EV_ID));
  if (warningIds.size !== warnings.length) throw new Error("Duplicate Latvian warning identity");
  if (points.some((p) => !warningIds.has(p.WEATHER_WARNING_EV_ID)) || joins.some((j) => !warningIds.has(j.WEATHER_WARNING_EV_ID) || !municipalityIds.has(j.NOV_ID))) {
    throw new Error("Inconsistent Latvian warning-table generation");
  }
  const events: NormalizedEvent[] = [];
  let invalid = 0;
  for (const warning of warnings) {
    // This transport is deliberately restricted to the documented water-level class.
    if (warning.PARADIBA_EN !== "Water level") continue;
    try {
      const starts = rigaWarningTime(warning.TIME_FROM);
      const ends = rigaWarningTime(warning.TIME_TILL);
      if (ends <= starts) throw new Error("Invalid Latvian validity range");
      if (!overlapsNextDay(starts, ends, context.now)) continue;
      const level = ({ Yellow: "ELEVATED", Orange: "HIGH", Red: "SEVERE" } as const)[warning.INTENSITY_EN as "Yellow" | "Orange" | "Red"];
      if (!level) throw new Error("Unreviewed Latvian warning intensity");
      const warningJoins = joins.filter((j) => j.WEATHER_WARNING_EV_ID === warning.WEATHER_WARNING_EV_ID);
      const warningPoints = points.filter((p) => p.WEATHER_WARNING_EV_ID === warning.WEATHER_WARNING_EV_ID);
      if (!warningJoins.length || !warningPoints.length) throw new Error("Latvian warning is missing geographic joins");
      const rings = new Map<number, typeof points>();
      for (const point of warningPoints) {
        const ring = rings.get(point.POLIGON_ID) || [];
        ring.push(point);
        rings.set(point.POLIGON_ID, ring);
      }
      const areas = [...rings.values()].map((rows) => {
        rows.sort((a, b) => a.NPK - b.NPK);
        if (rows.length < 4 || rows.some((p, i) => p.NPK !== i + 1)) throw new Error("Incomplete Latvian polygon sequence");
        const ring = rows.map((p) => [p.LON, p.LAT]);
        if (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]) throw new Error("Open Latvian polygon ring");
        return polygon([ring]);
      });
      const matches = matchingLocations(areas, locations).filter((l) => !cities[l.id] || warningJoins.some((j) => j.NOV_ID === cities[l.id].id));
      for (const location of matches) events.push({
        id: `lv:hydrology:${warning.WEATHER_WARNING_EV_ID}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts", transportId: "lvgmc-flood",
        type: "flood", level, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE",
        headline: `An official ${warning.INTENSITY_EN.toLowerCase()} water-level warning affects ${location.name}.`,
        explanation: warning.TEKSTS_EN.trim().slice(0, 500) || "LVĢMC has issued a water-level warning for the affected area.",
        action: "Avoid affected floodplains and riverbanks. Follow LVĢMC and local authority instructions.",
        affectedArea: warning.REGIONS_EN.trim().slice(0, 200), geometry: { kind: "locations", ids: [location.id] },
        startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), expiresAt: new Date(ends).toISOString(),
        sourceUpdatedAt, checkedAt: context.now.toISOString(), sourceName: "LVĢMC · processed by TravelCanary", sourceUrl: latviaWarningUrl, confidence: "HIGH",
      });
    } catch { invalid += 1; }
  }
  if (events.length > 500) throw new Error("Latvian event limit exceeded");
  recordSourceDiagnostics(context, { recordsExamined: warnings.length + points.length + joins.length });
  return { status: invalid ? "partial" : "ok", sourceUpdatedAt, events,
    error: invalid ? `${invalid} Latvian hydrological warnings have incomplete validity or geometry` : null,
    checkedLocationIds: invalid ? [] : locations.map((l) => l.id), unavailableLocationIds: invalid ? locations.map((l) => l.id) : [] };
}

const datastoreSchema = z.object({ success: z.literal(true), result: z.object({ total: z.number().int().nonnegative(),
  total_was_estimated: z.boolean().optional(), records: z.array(z.record(z.string(), z.unknown())) }) });
const packageSchema = z.object({ success: z.literal(true), result: z.object({ resources: z.array(z.object({ id: z.string(), last_modified: z.string() })) }) });
export async function fetchLvPartition(context: IngestionContext): Promise<NationalPartition> {
  const byteBudget = { remaining: 4 * 1024 * 1024 };
  const deadline = Math.min(context.deadlineAt ?? Infinity, Date.now() + 8_000);
  const request = async (url: string, maxBytes: number) => {
    if (deadline - Date.now() < 1000) throw new Error("Latvian transport deadline exhausted");
    const response = await fetchAllowlisted(context.fetch, url, ["data.gov.lv"], 1, { maxBytes, byteBudget, timeoutMs: Math.min(3000, deadline - Date.now()), diagnosticsCategory: "lvgmc_flood" });
    return response.json();
  };
  const generation = async () => {
    const data = packageSchema.parse(await request(packageUrl, 32 * 1024));
    return Object.fromEntries(Object.entries(latviaResources).map(([name, id]) => {
      const resource = data.result.resources.find((r) => r.id === id);
      if (!resource) throw new Error("Missing Latvian dataset resource");
      // CKAN metadata timestamps are UTC; warning TIME_FROM/TIME_TILL are Latvian local time.
      const raw = resource.last_modified;
      const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`);
      if (!Number.isFinite(time) || time > context.now.getTime() + 300_000) throw new Error("Invalid CKAN modification timestamp");
      return [name, new Date(time).toISOString()];
    }));
  };
  const before = await generation();
  const tables = {} as LatvianTables;
  for (const [name, id] of Object.entries(latviaResources) as [keyof LatvianTables, string][]) {
    const maxRows = name === "polygons" ? 40_000 : name === "warningMunicipalities" ? 5000 : name === "warnings" ? 500 : 100;
    const rows: unknown[] = [];
    let total: number | undefined;
    do {
      const url = new URL("https://data.gov.lv/dati/api/3/action/datastore_search");
      url.search = new URLSearchParams({ resource_id: id, limit: String(Math.min(5000, maxRows)), offset: String(rows.length), sort: "_id asc" }).toString();
      const page = datastoreSchema.parse(await request(url.href, name === "polygons" ? 768 * 1024 : 256 * 1024)).result;
      if (page.total_was_estimated || page.total > maxRows || total !== undefined && total !== page.total
        || page.records.length > page.total - rows.length || !page.records.length && rows.length < page.total) throw new Error("Incomplete Latvian pagination");
      total = page.total;
      rows.push(...page.records);
    } while (rows.length < total);
    tables[name] = rows;
  }
  const after = await generation();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Latvian datasets changed during pagination");
  const result = parseLatvianWarnings(tables, context, before.warnings);
  if (Date.now() >= deadline) throw new Error("Latvian transport deadline exhausted");
  return result;
}
