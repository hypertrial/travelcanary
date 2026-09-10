import { polygon } from "@turf/helpers";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext } from "../types";
import { nationalWarningSources } from "../../national-warning-sources";
import {
  countryLocations,
  limitEvents,
  matchingLocations,
  overlapsNextDay,
  partitionFailure,
  type NationalPartition,
} from "./national-civil-alerts-shared";
import type { HazardLevel, NormalizedEvent } from "../../domain/schemas";

export const AT_ALERT_LIST_URL = "https://warnung.at-alert.at/api/rpc/alert/list";
const PRODUCTION_LEVELS = ["AlertLevel1", "AlertLevel2", "AlertLevel3", "AlertLevel4"] as const;
const REJECTED_LEVELS = new Set(["Exercise", "MonthlyTest", "Test"]);
const levelByAlert: Record<(typeof PRODUCTION_LEVELS)[number], HazardLevel> = {
  AlertLevel1: "SEVERE",
  AlertLevel2: "HIGH",
  AlertLevel3: "HIGH",
  AlertLevel4: "ELEVATED",
};
const INPUT_LIMIT = 100;

type AtAlert = {
  consolidation_identifier?: unknown;
  alert_level?: unknown;
  title?: unknown;
  description?: unknown;
  begin_date?: unknown;
  end_date?: unknown;
  sender?: unknown;
  polygons?: unknown;
  geometry?: unknown;
};

function unwrapJson(value: unknown): unknown {
  return value && typeof value === "object" && "json" in value ? (value as { json: unknown }).json : value;
}

function alertAreas(alert: AtAlert) {
  const rawPolygons = Array.isArray(alert.polygons) ? alert.polygons : [];
  const geometry = alert.geometry && typeof alert.geometry === "object" ? alert.geometry as { type?: unknown; coordinates?: unknown } : null;
  const rings = geometry?.type === "Polygon" && Array.isArray(geometry.coordinates)
    ? geometry.coordinates
    : geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)
      ? geometry.coordinates.flat()
      : rawPolygons;
  if (!Array.isArray(rings) || rings.length === 0) throw new Error("AT-Alert record has no geometry");
  return rings.map((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("AT-Alert polygon is incomplete");
    const points = ring.map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) throw new Error("AT-Alert coordinate is invalid");
      const first = Number(pair[0]);
      const second = Number(pair[1]);
      if (!Number.isFinite(first) || !Number.isFinite(second)) throw new Error("AT-Alert coordinate is invalid");
      const [longitude, latitude] = Math.abs(first) <= 90 && Math.abs(second) > 90 ? [second, first] : [first, second];
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("AT-Alert coordinate is out of range");
      return [longitude, latitude] as [number, number];
    });
    if (points[0][0] !== points.at(-1)![0] || points[0][1] !== points.at(-1)![1]) points.push(points[0]);
    if (points.length < 4) throw new Error("AT-Alert polygon must be a closed ring");
    return polygon([points]);
  });
}

export function atAlertPartition(value: unknown, context: IngestionContext): NationalPartition {
  const payload = unwrapJson(value) as { totalCount?: unknown; alerts?: unknown };
  if (!payload || !Array.isArray(payload.alerts)) throw new Error("AT-Alert response has no alert list");
  const austrian = countryLocations(context, "AT");
  const records = [...payload.alerts] as AtAlert[];
  const overflow = Number(payload.totalCount) > INPUT_LIMIT || records.length > INPUT_LIMIT;
  const limited = records.slice(0, INPUT_LIMIT).sort((a, b) => String(a.consolidation_identifier).localeCompare(String(b.consolidation_identifier)));
  const unavailable = new Set<string>(overflow ? austrian.map(({ id }) => id) : []);
  const events: NormalizedEvent[] = [];
  let parseable = 0;
  let invalid = 0;
  for (const alert of limited) {
    const id = String(alert.consolidation_identifier || "").trim();
    const alertLevel = String(alert.alert_level || "").trim();
    if (REJECTED_LEVELS.has(alertLevel) || alertLevel === "Amber") {
      parseable += 1;
      continue;
    }
    const level = levelByAlert[alertLevel as keyof typeof levelByAlert];
    const startsAt = Date.parse(String(alert.begin_date || ""));
    const endsAt = Date.parse(String(alert.end_date || ""));
    const headline = String(alert.title || "").trim();
    let areas;
    try { areas = alertAreas(alert); } catch { areas = null; }
    if (!id || !level || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt || headline.length < 3 || !areas) {
      invalid += 1;
      austrian.forEach(({ id: locationId }) => unavailable.add(locationId));
      continue;
    }
    parseable += 1;
    if (!overlapsNextDay(startsAt, endsAt, context.now)) continue;
    const affected = matchingLocations(areas, austrian);
    const expiresAt = new Date(endsAt).toISOString();
    for (const location of affected) {
      events.push({
        id: `at-alert:${id}:${location.id}`, sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
        type: "civil-emergency", level, timing: startsAt > context.now.getTime() ? "UPCOMING" : "ACTIVE",
        headline: headline.slice(0, 180),
        explanation: String(alert.description || "An official AT-Alert public warning applies to this area.").slice(0, 500),
        action: "Follow instructions from Austrian authorities and monitor AT-Alert for updates.",
        affectedArea: location.name, geometry: { kind: "locations", ids: [location.id] },
        startsAt: new Date(startsAt).toISOString(), endsAt: expiresAt, sourceUpdatedAt: new Date(startsAt).toISOString(),
        checkedAt: context.now.toISOString(), expiresAt,
        sourceName: "AT-Alert", sourceUrl: "https://warnung.at-alert.at/", confidence: "HIGH",
      });
    }
  }
  if (records.length > 0 && parseable === 0) throw new Error("AT-Alert response contains no parseable records");
  recordSourceDiagnostics(context, { recordsExamined: records.length });
  const checkedLocationIds = austrian.map(({ id }) => id).filter((id) => !unavailable.has(id));
  return {
    status: invalid || overflow ? "partial" : "ok",
    sourceUpdatedAt: events.map((event) => event.sourceUpdatedAt).sort().at(-1) || context.now.toISOString(),
    events: overflow ? [] : limitEvents(events),
    error: overflow ? "AT-Alert input limit reached" : invalid ? `${invalid} AT-Alert records were invalid` : null,
    checkedLocationIds, unavailableLocationIds: [...unavailable].sort(),
  };
}

export async function fetchAtPartition(context: IngestionContext): Promise<NationalPartition> {
  try {
    const response = await fetchWithRetry(context.fetch, nationalWarningSources.AT.endpoint || AT_ALERT_LIST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        json: { limit: INPUT_LIMIT, offset: 0, alertLevels: [...PRODUCTION_LEVELS] },
      }),
    }, 3, 1024 * 1024);
    return atAlertPartition(await response.json(), context);
  } catch (error) {
    return partitionFailure(context, "AT", error);
  }
}
