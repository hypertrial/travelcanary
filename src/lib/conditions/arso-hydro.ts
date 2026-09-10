import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import mappingJson from "../../../data/arso-hydro-mapping.json";
import { locations } from "../data";
import { ObservationSchema, type Observation } from "../domain/conditions";
import { distanceKm, distanceToLocationKm } from "../geospatial";

const MappingSchema = z.object({
  schemaVersion: z.literal(1), reviewedAt: z.string().date(), source: z.string().url(), documentation: z.string().url(),
  licenseUrl: z.string().url(), rule: z.string().min(40), mappings: z.array(z.object({
    locationId: z.string(), stationId: z.string().regex(/^\d+$/), stationName: z.string().min(2), waterBody: z.string().min(2),
    coordinates: z.tuple([z.number(), z.number()]), distanceKm: z.number().nonnegative().max(100), rationale: z.string().min(20),
  })).max(100),
}).superRefine((value, context) => {
  const pairs = new Set<string>(); const counts = new Map<string, number>();
  for (const [index, item] of value.mappings.entries()) {
    const location = locations.find(({ id }) => id === item.locationId); const pair = `${item.locationId}:${item.stationId}`;
    counts.set(item.locationId, (counts.get(item.locationId) || 0) + 1);
    if (!location || location.countryCode !== "SI" || pairs.has(pair) || counts.get(item.locationId)! > 3
      || distanceToLocationKm(item.coordinates, location) > 0.1
      || Math.abs(distanceKm(location.centroid, item.coordinates) - item.distanceKm) > 0.2) {
      context.addIssue({ code: "custom", path: ["mappings", index], message: "Invalid ARSO hydrology mapping" });
    }
    pairs.add(pair);
  }
});

export const arsoHydroMapping = MappingSchema.parse(mappingJson);
export const arsoHydroMappings = arsoHydroMapping.mappings;
export const arsoHydroEndpoint = arsoHydroMapping.source;

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
const decimal = (value: unknown, min: number, max: number) => {
  if (value === "" || value == null) return null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid ARSO measurement");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error("Implausible ARSO measurement");
  return parsed;
};
const cet = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(value)
  ? Date.parse(`${value.replace(" ", "T")}:00+01:00`) : NaN;
const decodeNumericEntities = (value: string) => value.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (match, hex: string | undefined, decimal: string | undefined) => {
  const codePoint = Number.parseInt(hex || decimal || "", hex ? 16 : 10);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? String.fromCodePoint(codePoint) : match;
});

export function parseArsoHydrology(xml: string, now: Date): Map<string, Observation> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported ARSO XML");
  const root = (parser.parse(xml) as { arsopodatki?: Record<string, unknown> }).arsopodatki;
  if (!root || root["@_verzija"] !== "1.5" || root.vir !== "Agencija RS za okolje") throw new Error("Invalid ARSO hydrology contract");
  const rows = array(root.postaja);
  if (!rows.length || rows.length > 512) throw new Error("Invalid ARSO station count");
  const mappings = new Map(arsoHydroMappings.map((item) => [item.stationId, item]));
  const output = new Map<string, Observation>();
  for (const input of rows) {
    const row = z.object({
      "@_sifra": z.string(), "@_wgs84_dolzina": z.string(), "@_wgs84_sirina": z.string(), "@_kota_0": z.string().optional(),
      reka: z.string(), merilno_mesto: z.string(), datum_cet: z.string(), vodostaj: z.string().optional(), pretok: z.string().optional(),
      temp_vode: z.string().optional(), prvi_vv_vodostaj: z.string().optional(), prvi_vv_pretok: z.string().optional(),
    }).passthrough().parse(input);
    const mapping = mappings.get(row["@_sifra"]); if (!mapping) continue;
    const coordinates: [number, number] = [Number(row["@_wgs84_dolzina"]), Number(row["@_wgs84_sirina"])];
    if (!coordinates.every(Number.isFinite) || distanceKm(mapping.coordinates, coordinates) > 0.25
      || decodeNumericEntities(row.reka) !== mapping.waterBody) throw new Error(`ARSO station contract changed: ${mapping.stationId}`);
    const observed = cet(row.datum_cet);
    if (!Number.isFinite(observed) || observed > now.getTime() + 300_000 || now.getTime() - observed >= 2 * 3_600_000) continue;
    const level = decimal(row.vodostaj, -1_000, 20_000); const flow = decimal(row.pretok, 0, 100_000);
    const temperature = decimal(row.temp_vode, -5, 45); const firstLevel = decimal(row.prvi_vv_vodostaj, -1_000, 20_000);
    const firstFlow = decimal(row.prvi_vv_pretok, 0, 100_000);
    const measurements = [
      level == null ? null : { metric: "water-level" as const, value: level, unit: "cm" as const, ...(firstLevel != null && level >= firstLevel ? { qualifier: "above-reference" as const } : {}) },
      flow == null ? null : { metric: "discharge" as const, value: flow, unit: "m³/s" as const, ...(firstFlow != null && flow >= firstFlow ? { qualifier: "above-reference" as const } : {}) },
      temperature == null ? null : { metric: "water-temperature" as const, value: temperature, unit: "°C" as const },
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!measurements.length) continue;
    const observedAt = new Date(observed).toISOString(); const gaugeZero = decimal(row["@_kota_0"], -500, 5_000);
    output.set(mapping.stationId, ObservationSchema.parse({ sourceId: "arso-hydro", sourceUpdatedAt: observedAt,
      checkedAt: now.toISOString(), expiresAt: new Date(observed + 2 * 3_600_000).toISOString(), observedAt,
      stationId: mapping.stationId, stationName: mapping.stationName, sourceUrl: arsoHydroEndpoint,
      distanceKm: mapping.distanceKm, ...(gaugeZero == null ? {} : { datum: `ARSO gauge zero ${gaugeZero} m` }),
      qualityStatus: "provisional", measurements }));
  }
  return output;
}
