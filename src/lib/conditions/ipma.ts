import { createHash } from "node:crypto";
import { z } from "zod";
import mappingJson from "../../../data/ipma-condition-mapping.json";
import { locations } from "../data";
import { EarthquakeContextSchema, ObservationSchema, type LocationConditions, type Observation } from "../domain/conditions";
import { distanceKm, distanceToLocationKm } from "../geospatial";

const MappingSchema = z.object({ schemaVersion: z.literal(1), reviewedAt: z.string().date(), source: z.string().url(), documentation: z.string().url(), rule: z.string().min(20),
  mappings: z.array(z.object({ locationId: z.string(), stationId: z.string().regex(/^\d+$/), stationName: z.string().min(2),
    coordinates: z.tuple([z.number(), z.number()]), distanceKm: z.number().nonnegative().max(25) })).max(100),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, item] of value.mappings.entries()) {
    const location = locations.find(({ id }) => id === item.locationId);
    if (!location || location.countryCode !== "PT" || ids.has(item.locationId)
      || Math.abs(distanceKm(location.centroid, item.coordinates) - item.distanceKm) > 0.2) context.addIssue({ code: "custom", path: ["mappings", index], message: "Invalid IPMA station mapping" });
    ids.add(item.locationId);
  }
});
export const ipmaConditionMapping = MappingSchema.parse(mappingJson);
export const ipmaStationMappings = ipmaConditionMapping.mappings;
export const ipmaObservationEndpoint = "https://api.ipma.pt/open-data/observation/meteorology/stations/obs-surface.geojson";

const ipmaTime = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value) ? Date.parse(`${value}Z`) : NaN;
const validMeasurement = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value !== -99 && value >= min && value <= max ? value : null;
const observationRows = z.object({ type: z.literal("FeatureCollection"), features: z.array(z.object({ type: z.literal("Feature"),
  geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.object({ idEstacao: z.union([z.string(), z.number()]), time: z.string(), temperatura: z.unknown().optional(),
    intensidadeVento: z.unknown().optional(), precAcumulada: z.unknown().optional() }).passthrough(),
})).max(1000) });

export function parseIpmaObservations(value: unknown, now: Date) {
  const rows = observationRows.parse(value);
  const mappings = new Map(ipmaStationMappings.map((item) => [item.stationId, item]));
  const newest = new Map<string, { time: number; value: Record<string, unknown> }>();
  for (const feature of rows.features) {
    const stationId = String(feature.properties.idEstacao); const mapping = mappings.get(stationId); if (!mapping) continue;
    if (distanceKm(mapping.coordinates, feature.geometry.coordinates) > 0.25) throw new Error(`IPMA station coordinates changed: ${stationId}`);
    const time = ipmaTime(feature.properties.time);
    if (!Number.isFinite(time) || time > now.getTime() + 300_000 || now.getTime() - time > 2 * 3_600_000) continue;
    if (!newest.get(stationId) || newest.get(stationId)!.time < time) newest.set(stationId, { time, value: feature.properties });
  }
  const observations = new Map<string, Observation>();
  for (const mapping of ipmaStationMappings) {
    const row = newest.get(mapping.stationId); if (!row) continue;
    const temperature = validMeasurement(row.value.temperatura, -100, 65);
    const wind = validMeasurement(row.value.intensidadeVento, 0, 150);
    const rainfall = validMeasurement(row.value.precAcumulada, 0, 1000);
    const measurements = [temperature === null ? null : { metric: "temperature" as const, value: temperature, unit: "°C" as const },
      wind === null ? null : { metric: "wind" as const, value: wind, unit: "m/s" as const },
      rainfall === null ? null : { metric: "rainfall" as const, value: rainfall, unit: "mm" as const }].filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!measurements.length) continue;
    const observedAt = new Date(row.time).toISOString();
    observations.set(mapping.locationId, ObservationSchema.parse({ sourceId: "ipma-observations", sourceUpdatedAt: observedAt,
      checkedAt: now.toISOString(), expiresAt: new Date(row.time + 2 * 3_600_000).toISOString(), observedAt,
      stationId: mapping.stationId, stationName: mapping.stationName, sourceUrl: ipmaObservationEndpoint,
      distanceKm: mapping.distanceKm, qualityStatus: "provisional", measurements }));
  }
  return observations;
}

const earthquakeFeed = z.object({ idArea: z.union([z.literal(3), z.literal(7)]), updateDate: z.string(), owner: z.literal("IPMA"),
  data: z.array(z.object({ sismoId: z.string().optional(), time: z.string(), lat: z.string(), lon: z.string(), magnitud: z.string(), dataUpdate: z.string().optional() }).passthrough()).max(1000) });

export function parseIpmaEarthquakes(values: unknown[], now: Date) {
  const output: Record<string, LocationConditions["earthquakes"]> = {};
  for (const raw of values) {
    const feed = earthquakeFeed.parse(raw); const sourceUrl = `https://api.ipma.pt/open-data/observation/seismic/${feed.idArea}.json`;
    const updated = ipmaTime(feed.updateDate);
    const sourceUpdatedAt = Number.isFinite(updated) && updated <= now.getTime() + 300_000 ? new Date(updated).toISOString() : null;
    for (const row of feed.data) {
      const occurred = ipmaTime(row.time); const latitude = Number(row.lat); const longitude = Number(row.lon); const magnitude = Number(row.magnitud);
      if (!Number.isFinite(occurred) || occurred > now.getTime() + 300_000 || now.getTime() - occurred > 24 * 3_600_000
        || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
        || !Number.isFinite(magnitude) || magnitude < 3 || magnitude > 10) continue;
      for (const location of locations.filter(({ countryCode }) => countryCode === "PT")) {
        const proximity = distanceToLocationKm([longitude, latitude], location);
        if (proximity > 100) continue;
        const id = row.sismoId?.trim() || createHash("sha256").update(`${row.time}|${row.lat}|${row.lon}|${row.magnitud}`).digest("hex").slice(0, 24);
        const record = EarthquakeContextSchema.parse({ sourceId: "ipma-seismic", sourceUpdatedAt, checkedAt: now.toISOString(),
          expiresAt: new Date(occurred + 24 * 3_600_000).toISOString(), id, occurredAt: new Date(occurred).toISOString(),
          magnitude, distanceKm: Math.round(proximity * 10) / 10, sourceUrl });
        (output[location.id] ||= []).push(record);
      }
    }
  }
  for (const id of Object.keys(output)) output[id] = output[id].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id)).slice(0, 3);
  return output;
}
