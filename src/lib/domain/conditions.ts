import { conditionsV2SourceIds, conditionSourceIds } from "./contract-identities";
import { z } from "zod";

export { conditionSourceIds } from "./contract-identities";

// Deliberately separate from hazard schemas: conditions and infrastructure context cannot become alerts.
export const ConditionSourceIdV2Schema = z.enum(conditionsV2SourceIds);
const countryScopedSources: Partial<Record<z.infer<typeof ConditionSourceIdV2Schema>, readonly string[]>> = {
  digitraffic: ["FI"], "krisinformation-infrastructure": ["SE"], "ndw-traffic": ["NL"], "autobahn-traffic": ["DE"],
  "eac-power": ["CY"], "enemalta-power": ["MT"], "pse-energy-compass": ["PL"], "rws-water": ["NL"], "arso-hydro": ["SI"],
  "opw-hydro": ["IE"], "ipma-observations": ["PT"], "ipma-seismic": ["PT"],
};
export function conditionSourceAppliesToCountry(id: z.infer<typeof ConditionSourceIdV2Schema>, countryCode: string) {
  return !countryScopedSources[id] || countryScopedSources[id]!.includes(countryCode);
}
export const conditionSourceIdsV1 = ["open-meteo-weather", "open-meteo-air", "open-meteo-marine", "met-norway", "awc-metar", "ipma-observations", "ipma-seismic", "ign-seismic", "arso-hydro", "opw-hydro", "rws-water", "vmm-water", "lhmt-hydro", "syke-hydro", "cyprus-air", "nimh-hydro", "digitraffic", "smhi-water"] as const;
const ConditionSourceIdV1Schema = z.enum(conditionSourceIdsV1);
const timestamp = z.string().datetime({ offset: true });
const https = z.string().max(1000).url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Conditions links must use HTTPS without credentials");
const metadata = { sourceId: ConditionSourceIdV2Schema, sourceUpdatedAt: timestamp.nullable(), checkedAt: timestamp, expiresAt: timestamp };
const boundedValues = (min: number, max: number) => z.array(z.number().min(min).max(max).nullable()).min(1).max(25);
const forecastBase = z.object({ ...metadata, startAt: timestamp, stepMinutes: z.literal(60) });
export const WeatherForecastSchema = forecastBase.extend({
  temperature: boundedValues(-100, 65), precipitationProbability: boundedValues(0, 100), precipitation: boundedValues(0, 1000),
  wind: boundedValues(0, 150), gusts: boundedValues(0, 200), weatherCode: z.array(z.number().int().min(0).max(99).nullable()).min(1).max(25),
});
export const AirForecastSchema = forecastBase.extend({ aqi: boundedValues(0, 1000), pm25: boundedValues(0, 10000), pm10: boundedValues(0, 10000), dust: boundedValues(0, 10000), uv: boundedValues(0, 30) });
export const MarineForecastSchema = forecastBase.extend({ waveHeight: boundedValues(0, 40), wavePeriod: boundedValues(0, 60), seaTemperature: boundedValues(-5, 45) });
const MeasurementSchema = z.object({
  metric: z.enum(["temperature", "wind", "visibility", "water-level", "discharge", "water-temperature", "pm25", "pm10", "no2", "ozone", "rainfall"]),
  value: z.number().finite(), unit: z.enum(["°C", "m/s", "km", "m", "cm", "m³/s", "µg/m³", "mm"]),
  qualifier: z.enum(["at-least", "above-reference"]).optional(),
}).superRefine((value, context) => {
  const units = { temperature: ["°C"], wind: ["m/s"], visibility: ["km"], "water-level": ["m", "cm"], discharge: ["m³/s"], "water-temperature": ["°C"], pm25: ["µg/m³"], pm10: ["µg/m³"], no2: ["µg/m³"], ozone: ["µg/m³"], rainfall: ["mm"] };
  if (!units[value.metric].includes(value.unit)) context.addIssue({ code: "custom", message: "Incompatible measurement unit" });
  if (!["temperature", "water-temperature", "water-level"].includes(value.metric) && value.value < 0) context.addIssue({ code: "custom", message: "Negative measurement" });
});
export const ObservationSchema = z.object({
  ...metadata, observedAt: timestamp, stationId: z.string().min(1).max(100), stationName: z.string().min(1).max(120),
  sourceUrl: https, distanceKm: z.number().nonnegative().max(100).optional(), datum: z.string().min(1).max(100).optional(),
  qualityCode: z.string().min(1).max(20).optional(), qualityStatus: z.enum(["provisional", "checked", "final"]).optional(),
  daily: z.boolean().optional(), measurements: z.array(MeasurementSchema).min(1).max(8),
});
export const EarthquakeContextSchema = z.object({
  ...metadata, id: z.string().min(1).max(150), occurredAt: timestamp, magnitude: z.number().min(3).max(10),
  distanceKm: z.number().nonnegative().max(100), sourceUrl: https,
});
const LegacyDisruptionSchema = z.object({
  ...metadata, sourceId: ConditionSourceIdV1Schema, id: z.string().min(1).max(150), startsAt: timestamp, endsAt: timestamp.nullable(),
  kind: z.enum(["road-closed", "major-interruption"]), sourceUrl: https,
});
export const InfrastructureIncidentSchema = z.object({
  ...metadata, id: z.string().min(1).max(180),
  kind: z.enum(["power-outage", "water-supply-disruption", "telecom-disruption", "rail-disruption", "road-closure", "road-disruption", "district-heating-disruption"]),
  status: z.enum(["active", "planned"]), scope: z.enum(["destination", "region", "country"]), scopeLabel: z.string().min(1).max(120),
  startsAt: timestamp, endsAt: timestamp.nullable(), estimatedRestorationAt: timestamp.nullable(),
  affectedCustomers: z.number().int().nonnegative().max(100_000_000).optional(), sourceUrl: https,
});
export const SystemConditionSchema = z.object({
  ...metadata, id: z.string().min(1).max(180), kind: z.literal("electricity-use-advisory"), state: z.enum(["reduce-use", "limit-use"]),
  scope: z.literal("country"), scopeLabel: z.string().min(1).max(120), startsAt: timestamp, endsAt: timestamp, sourceUrl: https,
});
const limitationSchema = z.enum(["update-pending", "source-unavailable", "no-representative-station", "outside-product", "partial-data", "disabled"]);
const locationBase = {
  weather: WeatherForecastSchema.optional(), airQuality: AirForecastSchema.optional(), marine: MarineForecastSchema.optional(),
  observations: z.array(ObservationSchema).max(3).default([]), rivers: z.array(ObservationSchema).max(3).default([]),
  earthquakes: z.array(EarthquakeContextSchema).max(3).default([]), limitations: z.array(limitationSchema).max(6).default([]),
};
export const LocationConditionsV1Schema = z.object({ ...locationBase, disruptions: z.array(LegacyDisruptionSchema).max(3).default([]) });
export const LocationConditionsV2Schema = z.object({ ...locationBase,
  infrastructureIncidents: z.array(InfrastructureIncidentSchema).max(3).default([]), systemConditions: z.array(SystemConditionSchema).max(1).default([]),
});
export const AttributionSchema = z.object({
  name: z.string().min(2).max(120), officialUrl: https, license: z.string().min(2).max(120), licenseUrl: https,
  notice: z.string().min(2).max(500), logo: z.string().regex(/^\/sources\/[a-z0-9-]+\.(?:png|svg)$/).optional(),
});
export const PublicConditionSourceHealthSchema = z.object({ status: z.enum(["ok", "partial", "failed", "disabled"]), checkedAt: timestamp, limitationCode: z.string().regex(/^[a-z0-9_]+$/).max(60).nullable() });

const infrastructureContracts: Partial<Record<ConditionSourceId, { country: string; kinds: readonly InfrastructureIncident["kind"][] }>> = {
  digitraffic: { country: "FI", kinds: ["road-closure", "road-disruption"] },
  "krisinformation-infrastructure": { country: "SE", kinds: ["power-outage", "water-supply-disruption", "telecom-disruption", "rail-disruption", "road-closure", "road-disruption", "district-heating-disruption"] },
  "ndw-traffic": { country: "NL", kinds: ["road-closure", "road-disruption"] },
  "autobahn-traffic": { country: "DE", kinds: ["road-closure", "road-disruption"] },
  "eac-power": { country: "CY", kinds: ["power-outage"] },
  "enemalta-power": { country: "MT", kinds: ["power-outage"] },
};

function validateLocation(value: z.infer<typeof LocationConditionsV2Schema>, generatedAt: string, countryCode: string, sources: Partial<Record<ConditionSourceId, z.infer<typeof AttributionSchema>>>, context: z.RefinementCtx, id: string) {
  for (const item of conditionRecords(value)) {
    if (!sources[item.sourceId]) context.addIssue({ code: "custom", path: ["sources", item.sourceId], message: "Missing attribution" });
    if (!conditionSourceAppliesToCountry(item.sourceId, countryCode)) context.addIssue({ code: "custom", path: ["locations", id], message: "Condition source does not apply to country" });
    if (Date.parse(item.expiresAt) <= Date.parse(item.checkedAt)) context.addIssue({ code: "custom", path: ["locations", id], message: "Invalid expiry" });
    if (Date.parse(item.checkedAt) > Date.parse(generatedAt) + 300000 || (item.sourceUpdatedAt && Date.parse(item.sourceUpdatedAt) > Date.parse(item.checkedAt) + 300000)) context.addIssue({ code: "custom", path: ["locations", id], message: "Future source time" });
    if ("observedAt" in item && (Date.parse(item.observedAt) > Date.parse(item.checkedAt) + 300000 || Date.parse(item.expiresAt) > Date.parse(item.observedAt) + (item.daily ? 24 : item.measurements.some((measurement) => ["pm25", "pm10", "no2", "ozone"].includes(measurement.metric)) ? 3 : 2) * 3600000)) context.addIssue({ code: "custom", path: ["locations", id], message: "Invalid observation age" });
  }
  for (const [field, allowed, hours] of [["weather", ["open-meteo-weather", "met-norway"], 6], ["airQuality", ["open-meteo-air"], 12], ["marine", ["open-meteo-marine"], 12]] as const) {
    const item = value[field];
    if (item && (!(allowed as readonly string[]).includes(item.sourceId) || Date.parse(item.expiresAt) > Date.parse(item.checkedAt) + hours * 3600000)) context.addIssue({ code: "custom", path: ["locations", id, field], message: "Invalid forecast source or expiry" });
  }
  for (const forecast of [value.weather, value.airQuality, value.marine]) {
    if (!forecast) continue;
    const lengths = Object.values(forecast).filter(Array.isArray).map((series) => series.length);
    if (new Set(lengths).size !== 1) context.addIssue({ code: "custom", path: ["locations", id], message: "Misaligned forecast series" });
    if (Date.parse(forecast.startAt) > Date.parse(generatedAt) + 3600000 || Date.parse(forecast.startAt) + (lengths[0] - 1) * 3600000 > Date.parse(forecast.checkedAt) + 25 * 3600000) context.addIssue({ code: "custom", path: ["locations", id], message: "Forecast exceeds current outlook" });
  }
  for (const item of value.earthquakes) if (!["ipma-seismic", "ign-seismic"].includes(item.sourceId) || Date.parse(item.occurredAt) > Date.parse(item.checkedAt) + 300000 || Date.parse(item.expiresAt) > Date.parse(item.occurredAt) + 86400000) context.addIssue({ code: "custom", path: ["locations", id], message: "Invalid earthquake context" });
  for (const item of value.infrastructureIncidents) {
    const end = item.endsAt ? Date.parse(item.endsAt) : null; const restore = item.estimatedRestorationAt ? Date.parse(item.estimatedRestorationAt) : null;
    const contract = infrastructureContracts[item.sourceId];
    if (!contract || contract.country !== countryCode || !contract.kinds.includes(item.kind)
      || Date.parse(item.startsAt) > Date.parse(item.checkedAt) + 24 * 3600000 + 300000
      || (item.status === "active" && Date.parse(item.startsAt) > Date.parse(item.checkedAt) + 300000)
      || (end !== null && (end <= Date.parse(item.startsAt) || Date.parse(item.expiresAt) > end)) || (restore !== null && restore <= Date.parse(item.startsAt))
      || (item.status === "planned" && Date.parse(item.startsAt) <= Date.parse(item.checkedAt) - 300000)) context.addIssue({ code: "custom", path: ["locations", id], message: "Invalid infrastructure incident" });
  }
  for (const item of value.systemConditions) if (item.sourceId !== "pse-energy-compass" || countryCode !== "PL" || item.scopeLabel !== "Poland"
    || Date.parse(item.startsAt) > Date.parse(item.checkedAt) + 24 * 3600000 + 300000 || Date.parse(item.endsAt) <= Date.parse(item.startsAt)
    || Date.parse(item.expiresAt) > Date.parse(item.endsAt)) context.addIssue({ code: "custom", path: ["locations", id], message: "Invalid system condition" });
}

export const ConditionsV2Schema = z.object({
  schemaVersion: z.literal(2), catalogVersion: z.literal(2), countryCode: z.string().regex(/^[A-Z]{2}$/), generatedAt: timestamp,
  producerCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(), sources: z.partialRecord(ConditionSourceIdV2Schema, AttributionSchema),
  sourceHealth: z.partialRecord(ConditionSourceIdV2Schema, PublicConditionSourceHealthSchema),
  locations: z.record(z.string().regex(/^[a-z]{2}-[a-z0-9-]+$/), LocationConditionsV2Schema),
}).superRefine((value, context) => {
  if (Object.keys(value.locations).length > 600) context.addIssue({ code: "custom", path: ["locations"], message: "Too many destinations" });
  for (const id of Object.keys(value.sourceHealth)) {
    if (!value.sources[id as ConditionSourceId]) context.addIssue({ code: "custom", path: ["sourceHealth", id], message: "Health requires attribution" });
    if (!conditionSourceAppliesToCountry(id as ConditionSourceId, value.countryCode)) context.addIssue({ code: "custom", path: ["sourceHealth", id], message: "Condition source does not apply to country" });
  }
  for (const [id, location] of Object.entries(value.locations)) {
    if (!id.startsWith(`${value.countryCode.toLowerCase()}-`)) context.addIssue({ code: "custom", path: ["locations", id], message: "Wrong country" });
    validateLocation(location, value.generatedAt, value.countryCode, value.sources, context, id);
  }
});
const privateHealth = z.object({ checkedAt: timestamp, status: z.enum(["ok", "partial", "failed", "disabled"]), matched: z.number().int().nonnegative().max(600), code: z.string().regex(/^[a-z0-9_]+$/).max(60).nullable() });
const cacheControls = {
  attempts: z.record(z.string().max(120), timestamp).default({}), reservations: z.array(z.object({ at: timestamp, weight: z.number().int().min(1).max(400) })).max(8000).default([]),
  cooldownUntil: timestamp.nullable().default(null), cacheUntil: z.record(z.string().max(120), timestamp).default({}), lease: z.object({ id: z.string().uuid(), expiresAt: timestamp }).nullable().default(null),
};
export const ConditionsCacheV1Schema = z.object({ locations: z.record(z.string().regex(/^[a-z]{2}-[a-z0-9-]+$/), LocationConditionsV1Schema).default({}), health: z.partialRecord(ConditionSourceIdV1Schema, privateHealth).default({}), ...cacheControls });
export const ConditionsCacheV2Schema = z.object({ locations: z.record(z.string().regex(/^[a-z]{2}-[a-z0-9-]+$/), LocationConditionsV2Schema).default({}), health: z.partialRecord(ConditionSourceIdV2Schema, privateHealth).default({}), ...cacheControls }).superRefine((value, context) => {
  if (Object.keys(value.locations).length > 600 || Object.keys(value.attempts).length > 4000 || Object.keys(value.cacheUntil).length > 600) context.addIssue({ code: "custom", message: "Conditions cache exceeds catalog bounds" });
});

export type ConditionSourceId = z.infer<typeof ConditionSourceIdV2Schema>;
export type LocationConditions = z.infer<typeof LocationConditionsV2Schema>;
export type Conditions = z.infer<typeof ConditionsV2Schema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type InfrastructureIncident = z.infer<typeof InfrastructureIncidentSchema>;
export type SystemCondition = z.infer<typeof SystemConditionSchema>;
export type ConditionRecord = NonNullable<LocationConditions["weather"]> | NonNullable<LocationConditions["airQuality"]> | NonNullable<LocationConditions["marine"]> | Observation | z.infer<typeof EarthquakeContextSchema> | InfrastructureIncident | SystemCondition;
export function conditionRecords(location: LocationConditions): ConditionRecord[] {
  return [location.weather, location.airQuality, location.marine, ...location.observations, ...location.rivers, ...location.earthquakes, ...location.infrastructureIncidents, ...location.systemConditions].filter((item): item is ConditionRecord => Boolean(item));
}
export function emptyConditions(): LocationConditions { return LocationConditionsV2Schema.parse({}); }

export const CONDITIONS_COUNTRY_LIMIT = 128 * 1024;
export const CONDITIONS_TOTAL_LIMIT = 1.5 * 1024 * 1024;
export const CONDITIONS_CACHE_LIMIT = 2 * 1024 * 1024;

// Current public aliases; historical state readers use the versioned schemas.
export const ConditionSourceIdSchema = z.enum(conditionSourceIds);
export const ConditionsSchema = ConditionsV2Schema;
export const ConditionsCacheSchema = ConditionsCacheV2Schema;
export const LocationConditionsSchema = LocationConditionsV2Schema;
