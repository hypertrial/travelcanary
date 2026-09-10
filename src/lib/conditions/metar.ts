import { z } from "zod";
import mappingJson from "../../../data/airport-condition-mapping.json";
import { ObservationSchema, type Observation } from "../domain/conditions";

export const airportMappings = mappingJson.mappings;
const rowSchema = z.object({ icaoId: z.string().regex(/^[A-Z0-9]{4}$/), obsTime: z.number().int().positive(),
  temp: z.number().min(-100).max(65).nullable().optional(), wspd: z.number().min(0).max(300).nullable().optional(),
  visib: z.union([z.number(), z.string()]).nullable().optional(), metarType: z.enum(["METAR", "SPECI"]),
});
export function parseMetars(value: unknown, now: Date): Map<string, Observation> {
  if (!Array.isArray(value) || value.length > 400) throw new Error("Invalid METAR response");
  const observations = new Map<string, Observation>();
  for (const input of value) {
    const parsed = rowSchema.safeParse(input);
    if (!parsed.success) continue;
    const row = parsed.data;
    const mapping = airportMappings.find(({ stationId }) => stationId === row.icaoId);
    const observed = row.obsTime * 1000;
    if (!mapping || observed > now.getTime() + 300_000 || now.getTime() - observed >= 2 * 3_600_000) continue;
    const measurements: Observation["measurements"] = [];
    if (row.temp != null) measurements.push({ metric: "temperature", value: row.temp, unit: "°C" });
    if (row.wspd != null) measurements.push({ metric: "wind", value: Math.round(row.wspd * 0.514444 * 10) / 10, unit: "m/s" });
    if (row.visib != null && /^\d+(?:\.\d+)?\+?$/.test(String(row.visib))) {
      const miles = Number.parseFloat(String(row.visib));
      if (miles >= 0 && miles <= 100) measurements.push({ metric: "visibility", value: Math.round(miles * 1.609344 * 10) / 10, unit: "km", ...(String(row.visib).endsWith("+") ? { qualifier: "at-least" as const } : {}) });
    }
    if (!measurements.length) continue;
    const observation = ObservationSchema.parse({ sourceId: "awc-metar", sourceUpdatedAt: new Date(observed).toISOString(), observedAt: new Date(observed).toISOString(),
      checkedAt: now.toISOString(), expiresAt: new Date(observed + 2 * 3_600_000).toISOString(), stationId: row.icaoId, stationName: mapping.name,
      sourceUrl: `https://aviationweather.gov/data/metar/?id=${row.icaoId}`, measurements });
    const previous = observations.get(row.icaoId);
    if (!previous || Date.parse(previous.observedAt) < observed) observations.set(row.icaoId, observation);
  }
  if (value.length && !observations.size) throw new Error("No current reviewed airport observations");
  return observations;
}
