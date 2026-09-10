import { z } from "zod";
import mappingJson from "../../../data/opw-hydro-mapping.json";
import { locations } from "../data";
import { ObservationSchema, type Observation } from "../domain/conditions";
import { distanceKm, distanceToLocationKm } from "../geospatial";

const MappingSchema = z.object({
  schemaVersion: z.literal(1), reviewedAt: z.string().date(), source: z.literal("https://waterlevel.ie/geojson/latest/"),
  evidence: z.array(z.string().url()).min(3), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  qualityDecision: z.string().min(40),
  mappings: z.array(z.object({ locationId: z.string(), stationId: z.string().regex(/^\d{5}$/), stationName: z.string(),
    waterBody: z.string(), coordinates: z.tuple([z.number(), z.number()]), stationUrl: z.string().url(),
    gaugeZeroMalinHeadMetres: z.number().finite(), rationale: z.string().min(20),
  })).max(20),
}).superRefine((value, context) => {
  const ids = new Set<string>(); const stations = new Set<string>();
  for (const item of value.mappings) {
    const location = locations.find(({ id }) => id === item.locationId);
    if (!location || location.countryCode !== "IE" || distanceToLocationKm(item.coordinates, location) > 0.1
      || Number(item.stationId) < 1 || Number(item.stationId) > 41000 || ids.has(item.locationId) || stations.has(item.stationId)
      || item.stationUrl !== `https://waterlevel.ie/${item.stationId.padStart(10, "0")}/`) {
      context.addIssue({ code: "custom", message: "Invalid OPW station mapping" });
    }
    ids.add(item.locationId); stations.add(item.stationId);
  }
});
export const opwHydroMapping = MappingSchema.parse(mappingJson);
export const opwHydroMappings = opwHydroMapping.mappings;
export const opwHydroEndpoint = opwHydroMapping.source;

const RowSchema = z.object({ type: z.literal("Feature"), geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.object({ station_ref: z.string().regex(/^\d{10}$/), sensor_ref: z.literal("0001"), station_name: z.string(),
    datetime: z.string(), value: z.string(), err_code: z.number().int() }),
});

export function parseOpwHydrology(input: unknown, now: Date): Map<string, Observation> {
  const collection = z.object({ type: z.literal("FeatureCollection"), features: z.array(z.unknown()).max(4000) }).parse(input);
  const mappings = new Map(opwHydroMappings.map((item) => [item.stationId.padStart(10, "0"), item]));
  const seen = new Map<string, string>();
  const output = new Map<string, Observation>();
  for (const feature of collection.features) {
    const candidate = feature as { properties?: { station_ref?: string; sensor_ref?: string } } | null;
    const mapping = mappings.get(candidate?.properties?.station_ref || "");
    if (!mapping || candidate?.properties?.sensor_ref !== "0001") continue;
    const row = RowSchema.parse(feature); const data = row.properties;
    if (distanceKm(mapping.coordinates, row.geometry.coordinates) > 0.25 || data.station_name !== mapping.stationName) throw new Error("OPW station contract changed");
    const key = `${data.station_ref}:${data.datetime}`;
    const signature = JSON.stringify([data.value, data.err_code]);
    if (seen.has(key) && seen.get(key) !== signature) throw new Error("Conflicting OPW observations");
    seen.set(key, signature);
    // 99 is displayed by the official live site, not a claim of validated quality.
    if (data.err_code !== 99 || !/^-?\d+(?:\.\d+)?$/.test(data.value) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(data.datetime)) continue;
    const value = Number(data.value); const observed = Date.parse(data.datetime);
    if (!Number.isFinite(value) || Math.abs(value) > 1000 || !Number.isFinite(observed)
      || new Date(observed).toISOString() !== data.datetime.replace("Z", ".000Z")
      || observed > now.getTime() + 300_000 || now.getTime() - observed >= 2 * 3_600_000) continue;
    const previous = output.get(mapping.stationId);
    if (previous && Date.parse(previous.observedAt) >= observed) continue;
    output.set(mapping.stationId, ObservationSchema.parse({ sourceId: "opw-hydro", sourceUpdatedAt: new Date(observed).toISOString(),
      observedAt: new Date(observed).toISOString(), checkedAt: now.toISOString(), expiresAt: new Date(observed + 2 * 3_600_000).toISOString(),
      stationId: mapping.stationId, stationName: `${mapping.waterBody} — ${mapping.stationName}`, sourceUrl: mapping.stationUrl,
      distanceKm: Math.round(distanceKm(locations.find(({ id }) => id === mapping.locationId)!.centroid, mapping.coordinates) * 10) / 10,
      datum: "Local staff-gauge zero", qualityCode: "99", qualityStatus: "provisional",
      measurements: [{ metric: "water-level", value, unit: "m" }],
    }));
  }
  return output;
}
