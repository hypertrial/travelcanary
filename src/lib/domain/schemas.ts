import { catalogV2CountryCodes, snapshotV10SourceIds, snapshotV10ProviderIds, countryCodes, sourceIds, providerIds } from "./contract-identities";
import { z } from "zod";
import delayedProvidersV2 from "../../../data/catalog-releases/2-delayed-providers.json";
import { conditionSourceIdsV1, ConditionsCacheV2Schema, ConditionsCacheV1Schema, InfrastructureIncidentSchema } from "./conditions";

export { countryCodes, sourceIds, providerIds } from "./contract-identities";

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Only HTTP(S) URLs are allowed");


export const CatalogV2CountryCodeSchema = z.enum(catalogV2CountryCodes);
export const LocationTypeSchema = z.enum(["capital", "city", "resort", "island", "park", "mountain", "coastal"]);
export const HazardLevelSchema = z.enum(["ELEVATED", "HIGH", "SEVERE"]);
export const TimingSchema = z.enum(["ACTIVE", "UPCOMING"]);
export const CoverageSchema = z.enum(["complete", "partial", "delayed"]);
export const DataHealthSchema = z.enum(["complete", "delayed", "stale"]);
export const SourceStatusSchema = z.enum(["ok", "partial", "delayed", "failed", "not_monitored"]);
export const ConfidenceSchema = z.enum(["HIGH", "MEDIUM"]);
export const CoverageStatusSchema = z.enum(["monitored", "partial", "not_monitored"]);
export const HazardTypeSchema = z.enum([
  "severe-weather", "flood", "extreme-heat", "extreme-cold", "wildfire", "fire-danger", "air-quality",
  "earthquake", "volcano", "drought", "snow-ice", "avalanche", "coastal", "civil-unrest", "security", "terrorism",
  "armed-conflict", "industrial", "nuclear", "civil-emergency",
]);
const snapshotV3SourceIds = ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep", "gdacs", "gfm", "emsc", "slf-avalanche", "euregio-avalanche", "effis-active-fire", "bbk-mowas", "national-civil-alerts"] as const;
const SnapshotV3SourceIdSchema = z.enum(snapshotV3SourceIds);
const snapshotV4SourceIds = [...snapshotV3SourceIds, "vigicrues", "foen-flood"] as const;
const SnapshotV4SourceIdSchema = z.enum(snapshotV4SourceIds);
const snapshotV5SourceIds = [...snapshotV4SourceIds, "ehyd-flood"] as const;
const SnapshotV5SourceIdSchema = z.enum(snapshotV5SourceIds);
const snapshotV6SourceIds = snapshotV5SourceIds.filter((id): id is Exclude<typeof snapshotV5SourceIds[number], "bbk-mowas" | "eurdep"> => id !== "bbk-mowas" && id !== "eurdep");
const SnapshotV6SourceIdSchema = z.enum(snapshotV6SourceIds);
export const SnapshotV10SourceIdSchema = z.enum(snapshotV10SourceIds);
const LegacySourceIdSchema = z.enum(["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"]);
const snapshotV2ProviderIds = [
  "meteoalarm", "usgs", "effis-fire-danger", "cems-rapid-mapping", "gdacs", "gfm", "emsc",
  "slf-avalanche", "euregio-avalanche", "effis-active-fire", "eea-aqi", "bbk-mowas", "gdelt", "eurdep",
] as const;
const SnapshotV2ProviderIdSchema = z.enum(snapshotV2ProviderIds);
const snapshotV3ProviderIds = [...snapshotV2ProviderIds, "national-civil-alerts"] as const;
const SnapshotV3ProviderIdSchema = z.enum(snapshotV3ProviderIds);
const snapshotV4ProviderIds = [...snapshotV3ProviderIds, "vigicrues", "foen-flood"] as const;
const SnapshotV4ProviderIdSchema = z.enum(snapshotV4ProviderIds);
const snapshotV5ProviderIds = [...snapshotV4ProviderIds, "ehyd-flood"] as const;
const SnapshotV5ProviderIdSchema = z.enum(snapshotV5ProviderIds);
const snapshotV6ProviderIds = snapshotV5ProviderIds.filter((id): id is Exclude<typeof snapshotV5ProviderIds[number], "bbk-mowas" | "eurdep"> => id !== "bbk-mowas" && id !== "eurdep");
const SnapshotV6ProviderIdSchema = z.enum(snapshotV6ProviderIds);
export const SnapshotV10ProviderIdSchema = z.enum(snapshotV10ProviderIds);
export const ProviderModeSchema = z.enum(["authoritative", "complementary", "fallback", "discovery", "disabled"]);
export const ProviderStatusSchema = z.enum(["ok", "partial", "delayed", "failed", "disabled"]);
const AggregateSourceIdSchema = z.enum(["usgs", "effis", "cems", "gdacs", "gdelt", "gfm", "emsc", "slf-avalanche", "euregio-avalanche", "effis-active-fire", "vigicrues", "foen-flood", "ehyd-flood", "eonet", "edo-drought", "fcdo-travel-advice"]);

export function providerIdForSourceId(sourceId: z.infer<typeof SnapshotV10SourceIdSchema>): z.infer<typeof SnapshotV10ProviderIdSchema> {
  const legacy = { meteoalarm: "meteoalarm", usgs: "usgs", effis: "effis-fire-danger", cems: "cems-rapid-mapping", eea: "eea-aqi", gdelt: "gdelt", "national-civil-alerts": "national-civil-alerts" } as const;
  const providerId = legacy[sourceId as keyof typeof legacy] || sourceId;
  return SnapshotV10ProviderIdSchema.parse(providerId);
}

const CoverageEntrySchema = z.object({ status: CoverageStatusSchema, providerIds: z.array(SnapshotV10ProviderIdSchema) });
export const CoverageMatrixSchema = z.object({
  schemaVersion: z.literal(2),
  countries: z.record(CatalogV2CountryCodeSchema, z.object({ hazards: z.record(HazardTypeSchema, CoverageEntrySchema) })),
  locationOverrides: z.record(z.string(), z.partialRecord(HazardTypeSchema, CoverageEntrySchema)).default({}),
});

const PositionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const RadiusGeometrySchema = z.object({ kind: z.literal("radius"), center: PositionSchema, radiusKm: z.number().positive().max(100) });
const PolygonRingsSchema = z.array(
  z.array(PositionSchema).min(4).refine(
    (ring) => ring[0][0] === ring.at(-1)?.[0] && ring[0][1] === ring.at(-1)?.[1],
    "Polygon rings must be closed",
  ),
).min(1);
const PolygonGeometrySchema = z.object({
  kind: z.literal("polygon"),
  coordinates: PolygonRingsSchema,
});
export const LocationGeometrySchema = z.discriminatedUnion("kind", [RadiusGeometrySchema, PolygonGeometrySchema]);

export const LocationSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(2),
  aliases: z.array(z.string().min(2)),
  country: z.string().min(2),
  countryCode: CatalogV2CountryCodeSchema,
  type: LocationTypeSchema,
  centroid: PositionSchema,
  isCoastal: z.boolean(),
  airQualitySamplePoints: z.array(PositionSchema).min(1).max(3),
  geometry: LocationGeometrySchema,
  timezone: z.string().min(3),
  sourceRegionCodes: z.object({
    meteoalarm: z.array(z.string().min(2)).min(1),
    slf: z.array(z.string().min(1)).default([]),
    euregio: z.array(z.string().min(1)).default([]),
    nationalCivilAlerts: z.array(z.string().min(1)).default([]),
  }),
  coverageRef: CatalogV2CountryCodeSchema,
  provenance: z.object({ name: HttpUrlSchema, license: z.string().min(2) }),
});

export const PublicLocationSchema = LocationSchema.pick({
  id: true, name: true, aliases: true, country: true, countryCode: true, type: true, centroid: true, isCoastal: true, timezone: true,
});

const NormalizedEventObjectSchema = z.object({
  id: z.string().min(1),
  sourceId: SnapshotV10SourceIdSchema,
  providerId: SnapshotV10ProviderIdSchema.optional(),
  type: HazardTypeSchema,
  level: HazardLevelSchema,
  timing: TimingSchema,
  headline: z.string().min(3).max(180),
  explanation: z.string().min(3).max(500),
  action: z.string().min(3).max(300),
  affectedArea: z.string().min(2).max(200),
  geometry: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("point"), coordinates: PositionSchema, radiusKm: z.number().positive().max(1000) }),
    z.object({ kind: z.literal("polygon"), coordinates: PolygonRingsSchema }),
    z.object({ kind: z.literal("regions"), countryCode: CatalogV2CountryCodeSchema, codes: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("locations"), ids: z.array(z.string().min(1)).min(1) }),
  ]),
  earthquake: z.object({
    ids: z.array(z.string().min(1).max(100)).max(20),
    coordinates: PositionSchema,
    magnitude: z.number().finite(),
  }).optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }),
  checkedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  sourceName: z.string().min(2),
  sourceUrl: HttpUrlSchema,
  confidence: ConfidenceSchema,
});

const hasValidEventRange = (event: { startsAt: string; endsAt: string }) => Date.parse(event.startsAt) < Date.parse(event.endsAt);
const validEventRange = { message: "Event end time must be after its start time", path: ["endsAt"] };

export const LegacyNormalizedEventSchema = NormalizedEventObjectSchema.refine(hasValidEventRange, validEventRange);
export const NormalizedEventV12Schema = NormalizedEventObjectSchema.extend({ providerId: SnapshotV10ProviderIdSchema, transportId: z.string().regex(/^[a-z0-9-]+$/).max(100).optional() })
  .refine(hasValidEventRange, validEventRange)
  .refine((event) => event.providerId === providerIdForSourceId(event.sourceId), {
    message: "Event provider must match its source adapter", path: ["providerId"],
  });

const PublicHazardV1Schema = NormalizedEventObjectSchema.omit({ sourceId: true, geometry: true, providerId: true, earthquake: true }).extend({
  affectedArea: z.object({ label: z.string().min(2).max(200) }),
}).refine(hasValidEventRange, validEventRange);
const PublicHazardV7Schema = PublicHazardV1Schema.safeExtend({ providerId: SnapshotV10ProviderIdSchema });
export const PublicEvidenceV10Schema = z.object({
  providerId: SnapshotV10ProviderIdSchema,
  sourceName: z.string().min(2),
  sourceUrl: HttpUrlSchema,
  sourceUpdatedAt: z.string().datetime({ offset: true }),
  checkedAt: z.string().datetime({ offset: true }),
  confidence: ConfidenceSchema,
}).strict();
export const PublicHazardV10Schema = PublicHazardV7Schema.safeExtend({
  evidence: z.array(PublicEvidenceV10Schema).min(1).max(5),
});

export const SourceHealthSchema = z.object({
  status: SourceStatusSchema,
  lastAttempt: z.string().datetime({ offset: true }).nullable(),
  lastSuccess: z.string().datetime({ offset: true }).nullable(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  nextExpectedUpdate: z.string().datetime({ offset: true }).nullable(),
  itemCount: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  error: z.string().max(300).nullable(),
});
export const PublicTransportStateSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(2).max(120),
  role: z.enum(["coverage", "fallback", "context", "blocked"]),
  status: z.enum(["ok", "partial", "delayed", "failed", "disabled"]),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  limitationCode: z.string().max(100).nullable(),
  officialUrl: HttpUrlSchema,
}).strict();

const PublicProviderPartitionStateSchema = z.object({
  status: z.enum(["ok", "partial", "delayed", "failed", "disabled"]),
  lastSuccess: z.string().datetime({ offset: true }).nullable(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  nextExpectedUpdate: z.string().datetime({ offset: true }).nullable(),
  limitationCode: z.string().max(100).nullable(),
  transports: z.array(PublicTransportStateSchema).max(4).optional(),
}).strict();

export const PublicProviderV10StateSchema = z.object({
  mode: ProviderModeSchema, status: ProviderStatusSchema,
  lastSuccess: z.string().datetime({ offset: true }).nullable(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  nextExpectedUpdate: z.string().datetime({ offset: true }).nullable(),
  limitationCode: z.string().max(100).nullable(),
  partitions: z.record(CatalogV2CountryCodeSchema, PublicProviderPartitionStateSchema).optional(),
}).strict();

const LegacyLocationBaseSchema = z.object({ coverage: CoverageSchema, coverageGaps: z.array(HazardTypeSchema) });
const NormalLocationStateSchema = LegacyLocationBaseSchema.extend({ level: z.literal("NORMAL"), hazards: z.tuple([]) });
const UnknownLocationStateSchema = LegacyLocationBaseSchema.extend({ level: z.literal("UNKNOWN"), hazards: z.tuple([]) });
const V8AlertLocationStateSchema = LegacyLocationBaseSchema.extend({
  level: HazardLevelSchema,
  timing: TimingSchema,
  hazards: z.array(PublicHazardV10Schema).min(1),
}).superRefine((state, context) => {
  if (state.level !== state.hazards[0].level) {
    context.addIssue({ code: "custom", path: ["level"], message: "Location level must match its leading hazard" });
  }
  if (state.timing !== state.hazards[0].timing) {
    context.addIssue({ code: "custom", path: ["timing"], message: "Location timing must match its leading hazard" });
  }
});
const V8LocationStateSchema = z.union([NormalLocationStateSchema, UnknownLocationStateSchema, V8AlertLocationStateSchema]);
const LocationBaseSchema = LegacyLocationBaseSchema.extend({ delayedHazards: z.array(HazardTypeSchema) });
const CurrentNormalLocationStateSchema = LocationBaseSchema.extend({ level: z.literal("NORMAL"), hazards: z.tuple([]) });
const CurrentUnknownLocationStateSchema = LocationBaseSchema.extend({ level: z.literal("UNKNOWN"), hazards: z.tuple([]) });
const AlertLocationStateSchema = LocationBaseSchema.extend({
  level: HazardLevelSchema,
  timing: TimingSchema,
  hazards: z.array(PublicHazardV10Schema).min(1),
}).superRefine((state, context) => {
  if (state.level !== state.hazards[0].level) {
    context.addIssue({ code: "custom", path: ["level"], message: "Location level must match its leading hazard" });
  }
  if (state.timing !== state.hazards[0].timing) {
    context.addIssue({ code: "custom", path: ["timing"], message: "Location timing must match its leading hazard" });
  }
});
export const LocationStateV10Schema = z.union([CurrentNormalLocationStateSchema, CurrentUnknownLocationStateSchema, AlertLocationStateSchema]);
const V7AlertLocationStateSchema = LegacyLocationBaseSchema.extend({
  level: HazardLevelSchema, timing: TimingSchema, hazards: z.array(PublicHazardV7Schema).min(1),
}).superRefine((state, context) => {
  if (state.level !== state.hazards[0].level) context.addIssue({ code: "custom", path: ["level"], message: "Location level must match its leading hazard" });
  if (state.timing !== state.hazards[0].timing) context.addIssue({ code: "custom", path: ["timing"], message: "Location timing must match its leading hazard" });
});
const V7LocationStateSchema = z.union([NormalLocationStateSchema, UnknownLocationStateSchema, V7AlertLocationStateSchema]);
const LegacyAlertLocationStateSchema = LegacyLocationBaseSchema.extend({
  level: HazardLevelSchema, timing: TimingSchema, hazards: z.array(PublicHazardV1Schema).min(1),
});
const LegacyLocationStateSchema = z.union([NormalLocationStateSchema, UnknownLocationStateSchema, LegacyAlertLocationStateSchema]);

export const SnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  valid: z.literal(true),
  dataHealth: DataHealthSchema,
  sources: z.record(LegacySourceIdSchema, SourceHealthSchema),
  locations: z.record(z.string(), LegacyLocationStateSchema),
}).superRefine((snapshot, context) => {
  if (Object.keys(snapshot.locations).length !== 500) {
    context.addIssue({ code: "custom", path: ["locations"], message: "Legacy snapshot must contain 500 locations" });
  }
});
const PublicHazardV2Schema = PublicHazardV1Schema.safeExtend({ providerId: SnapshotV2ProviderIdSchema });
const V2AlertLocationStateSchema = LegacyLocationBaseSchema.extend({
  level: HazardLevelSchema, timing: TimingSchema, hazards: z.array(PublicHazardV2Schema).min(1),
});
const SnapshotV2PartitionStateSchema = PublicProviderPartitionStateSchema.omit({ limitationCode: true }).extend({
  status: z.enum(["ok", "partial", "delayed", "failed"]),
});
const SnapshotV2ProviderStateSchema = PublicProviderV10StateSchema.omit({ partitions: true }).extend({
  partitions: z.record(CatalogV2CountryCodeSchema, SnapshotV2PartitionStateSchema).optional(),
});
export const SnapshotV2Schema = z.object({
  schemaVersion: z.literal(2), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV2ProviderIdSchema, SnapshotV2ProviderStateSchema),
  locations: z.record(z.string(), z.union([NormalLocationStateSchema, UnknownLocationStateSchema, V2AlertLocationStateSchema])),
}).superRefine((snapshot, context) => {
  if (Object.keys(snapshot.locations).length !== 500) context.addIssue({ code: "custom", path: ["locations"], message: "Legacy snapshot must contain 500 locations" });
  for (const id of snapshotV2ProviderIds) if (!snapshot.providers[id]) context.addIssue({ code: "custom", path: ["providers", id], message: "Provider state is required" });
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (id !== "meteoalarm" && provider.partitions) {
      context.addIssue({ code: "custom", path: ["providers", id, "partitions"], message: "Only MeteoAlarm may publish country partitions" });
    }
  }
});

const SnapshotV3PublicHazardSchema = PublicHazardV1Schema.safeExtend({ providerId: SnapshotV3ProviderIdSchema });
const SnapshotV3AlertLocationStateSchema = LegacyLocationBaseSchema.extend({
  level: HazardLevelSchema, timing: TimingSchema, hazards: z.array(SnapshotV3PublicHazardSchema).min(1),
}).superRefine((state, context) => {
  if (state.level !== state.hazards[0].level) context.addIssue({ code: "custom", path: ["level"], message: "Location level must match its leading hazard" });
  if (state.timing !== state.hazards[0].timing) context.addIssue({ code: "custom", path: ["timing"], message: "Location timing must match its leading hazard" });
});
const SnapshotV3LocationStateSchema = z.union([NormalLocationStateSchema, UnknownLocationStateSchema, SnapshotV3AlertLocationStateSchema]);
const snapshotV3PartitionedProviderIds = new Set<typeof snapshotV3ProviderIds[number]>(["meteoalarm", "eea-aqi", "national-civil-alerts"]);
export const SnapshotV3Schema = z.object({
  schemaVersion: z.literal(3), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV3ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), SnapshotV3LocationStateSchema),
}).superRefine((snapshot, context) => {
  if (Object.keys(snapshot.locations).length !== 500) context.addIssue({ code: "custom", path: ["locations"], message: "Legacy snapshot must contain 500 locations" });
  for (const id of snapshotV3ProviderIds) if (!snapshot.providers[id]) context.addIssue({ code: "custom", path: ["providers", id], message: "Provider state is required" });
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (!snapshotV3PartitionedProviderIds.has(id as typeof snapshotV3ProviderIds[number]) && provider.partitions) context.addIssue({ code: "custom", path: ["providers", id, "partitions"], message: "Provider does not support country partitions" });
    if (snapshotV3PartitionedProviderIds.has(id as typeof snapshotV3ProviderIds[number]) && (!provider.partitions || Object.keys(provider.partitions).length !== catalogV2CountryCodes.length)) context.addIssue({ code: "custom", path: ["providers", id, "partitions"], message: "Country-partitioned provider must publish all covered countries" });
  }
});

const partitionedProviderIds = new Set<ProviderId>(["meteoalarm", "eea-aqi", "national-civil-alerts"]);
function refineSnapshotProviders(
  snapshot: { locations: Record<string, unknown>; providers: Record<string, { partitions?: unknown }> },
  requiredIds: readonly string[],
  context: z.RefinementCtx,
  expectedLocations = 500,
) {
  const count = Object.keys(snapshot.locations).length;
  if (count !== expectedLocations) {
    context.addIssue({ code: "custom", path: ["locations"], message: `Snapshot must contain ${expectedLocations} locations` });
  }
  for (const id of requiredIds) if (!snapshot.providers[id]) context.addIssue({ code: "custom", path: ["providers", id], message: "Provider state is required" });
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (!partitionedProviderIds.has(id as ProviderId) && provider.partitions) {
      context.addIssue({ code: "custom", path: ["providers", id, "partitions"], message: "Provider does not support country partitions" });
    }
    if (partitionedProviderIds.has(id as ProviderId) && (!provider.partitions || Object.keys(provider.partitions as object).length !== catalogV2CountryCodes.length)) {
      context.addIssue({ code: "custom", path: ["providers", id, "partitions"], message: "Country-partitioned provider must publish all covered countries" });
    }
  }
}
export const SnapshotV4Schema = z.object({
  schemaVersion: z.literal(4), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV4ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), V7LocationStateSchema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV4ProviderIds, context));
export const SnapshotV5Schema = z.object({
  schemaVersion: z.literal(5), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV5ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), V7LocationStateSchema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV5ProviderIds, context));
export const SnapshotV6Schema = z.object({
  schemaVersion: z.literal(6), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV6ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), V7LocationStateSchema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV6ProviderIds, context));
export const SnapshotV7Schema = z.object({
  schemaVersion: z.literal(7), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV10ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), V7LocationStateSchema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV10ProviderIds, context));
export const SnapshotV8Schema = z.object({
  schemaVersion: z.literal(8), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV10ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), V8LocationStateSchema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV10ProviderIds, context));
export const SnapshotV9Schema = z.object({
  schemaVersion: z.literal(9), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV10ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), LocationStateV10Schema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV10ProviderIds, context));

export const SnapshotV10Schema = z.object({
  schemaVersion: z.literal(10), catalogVersion: z.literal(2), generatedAt: z.string().datetime({ offset: true }), valid: z.literal(true),
  dataHealth: DataHealthSchema, providers: z.record(SnapshotV10ProviderIdSchema, PublicProviderV10StateSchema),
  locations: z.record(z.string(), LocationStateV10Schema),
}).superRefine((snapshot, context) => refineSnapshotProviders(snapshot, snapshotV10ProviderIds, context, 503));

export function parseSnapshot(value: unknown) {
  const version = value && typeof value === "object" && "schemaVersion" in value ? (value as { schemaVersion?: unknown }).schemaVersion : null;
  if (version === 10) return SnapshotV10Schema.parse(value);
  if (version === 9) return upgradeSnapshotV9(SnapshotV9Schema.parse(value));
  if (version === 8) return upgradeSnapshotV9(upgradeSnapshotV8(SnapshotV8Schema.parse(value)));
  if (version === 7) return upgradeSnapshotV9(upgradeSnapshotV8(upgradeSnapshotV7(SnapshotV7Schema.parse(value))));
  if (version === 6) return upgradeSnapshotV9(upgradeSnapshotV8(upgradeSnapshotV7(upgradeSnapshotV6(SnapshotV6Schema.parse(value)))));
  if (version === 5) return upgradeSnapshotV9(upgradeSnapshotV8(upgradeSnapshotV7(upgradeSnapshotV6(upgradeSnapshotV5(SnapshotV5Schema.parse(value))))));
  if (version === 4) return upgradeSnapshotV9(upgradeSnapshotV8(upgradeSnapshotV7(upgradeSnapshotV6(upgradeSnapshotV5(upgradeSnapshotV4(SnapshotV4Schema.parse(value)))))));
  if (version === 3) return upgradeSnapshotV9(upgradeSnapshotV8(upgradeSnapshotV7(upgradeSnapshotV6(upgradeSnapshotV5(upgradeSnapshotV4(upgradeSnapshotV3(SnapshotV3Schema.parse(value))))))));
  const legacy = version === 2 ? SnapshotV2Schema.parse(value) : upgradeSnapshotV1(SnapshotV1Schema.parse(value));
  return upgradeSnapshotV9(upgradeSnapshotV8(upgradeSnapshotV7(upgradeSnapshotV6(upgradeSnapshotV5(upgradeSnapshotV4(upgradeSnapshotV3(upgradeSnapshotV2(legacy))))))));
}

function upgradeSnapshotV1(legacy: z.infer<typeof SnapshotV1Schema>): z.infer<typeof SnapshotV2Schema> {
  const legacyProvider = { meteoalarm: "meteoalarm", usgs: "usgs", effis: "effis-fire-danger", cems: "cems-rapid-mapping", eea: "eea-aqi", gdelt: "gdelt", eurdep: "eurdep" } as const;
  const mode = (id: typeof snapshotV2ProviderIds[number]): z.infer<typeof ProviderModeSchema> => ["gfm", "slf-avalanche", "euregio-avalanche", "effis-active-fire", "eea-aqi", "bbk-mowas", "gdelt", "eurdep"].includes(id) ? "disabled" : id === "gdacs" ? "discovery" : id === "emsc" ? "fallback" : id === "cems-rapid-mapping" ? "complementary" : "authoritative";
  const providers = Object.fromEntries(snapshotV2ProviderIds.map((id) => {
    const source = Object.entries(legacyProvider).find(([, provider]) => provider === id)?.[0] as keyof typeof legacy.sources | undefined;
    const health = source ? legacy.sources[source] : null;
    const disabled = mode(id) === "disabled";
    const status = disabled ? "disabled" : health?.status === "ok" || health?.status === "partial" || health?.status === "delayed" ? health.status : "failed";
    return [id, { mode: mode(id), status, lastSuccess: health?.lastSuccess || null, sourceUpdatedAt: health?.sourceUpdatedAt || null, nextExpectedUpdate: health?.nextExpectedUpdate || null, limitationCode: disabled ? "not_enabled_in_legacy_snapshot" : null }];
  }));
  const providerForLegacyHazard = (sourceName: string): typeof snapshotV2ProviderIds[number] => {
    const normalized = sourceName.trim().toLowerCase();
    if (normalized === "meteoalarm") return "meteoalarm";
    if (normalized === "usgs") return "usgs";
    if (normalized === "effis") return "effis-fire-danger";
    if (normalized === "copernicus ems") return "cems-rapid-mapping";
    throw new Error(`Unsupported legacy hazard source: ${sourceName}`);
  };
  const locations = Object.fromEntries(Object.entries(legacy.locations).map(([id, state]) => [id, state.level === "NORMAL" || state.level === "UNKNOWN" ? state : { ...state, hazards: state.hazards.map((hazard) => ({ ...hazard, providerId: providerForLegacyHazard(hazard.sourceName) })) }]));
  return SnapshotV2Schema.parse({ schemaVersion: 2, generatedAt: legacy.generatedAt, valid: true, dataHealth: legacy.dataHealth, providers, locations });
}

function upgradeSnapshotV2(legacy: z.infer<typeof SnapshotV2Schema>): z.infer<typeof SnapshotV3Schema> {
  const disabledPartition = (limitationCode: string) => ({
    status: "disabled" as const, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, limitationCode,
  });
  const providers = Object.fromEntries(snapshotV3ProviderIds.map((id) => {
    if (id === "national-civil-alerts") return [id, {
      mode: "authoritative", status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "not_available_in_snapshot_v2",
      partitions: Object.fromEntries(catalogV2CountryCodes.map((code) => [code, disabledPartition("not_available_in_snapshot_v2")])),
    }];
    const previous = legacy.providers[id as typeof snapshotV2ProviderIds[number]];
    if (id === "meteoalarm") {
      const fallback = { status: previous.status === "disabled" ? "failed" as const : previous.status, lastSuccess: previous.lastSuccess, sourceUpdatedAt: previous.sourceUpdatedAt, nextExpectedUpdate: previous.nextExpectedUpdate, limitationCode: null };
      const partitions = previous.partitions
        ? Object.fromEntries(catalogV2CountryCodes.map((code) => [code, { ...previous.partitions![code], limitationCode: null }]))
        : Object.fromEntries(catalogV2CountryCodes.map((code) => [code, fallback]));
      return [id, { ...previous, partitions }];
    }
    if (id === "eea-aqi") {
      const partition = previous.status === "disabled"
        ? disabledPartition(previous.limitationCode || "not_available_in_snapshot_v2")
        : { status: previous.status, lastSuccess: previous.lastSuccess, sourceUpdatedAt: previous.sourceUpdatedAt, nextExpectedUpdate: previous.nextExpectedUpdate, limitationCode: previous.limitationCode };
      return [id, { ...previous, partitions: Object.fromEntries(catalogV2CountryCodes.map((code) => [code, partition])) }];
    }
    return [id, previous];
  }));
  return SnapshotV3Schema.parse({ ...legacy, schemaVersion: 3, providers });
}

function upgradeSnapshotV3(legacy: z.infer<typeof SnapshotV3Schema>): z.infer<typeof SnapshotV4Schema> {
  const providers = Object.fromEntries(snapshotV4ProviderIds.map((id) => {
    const previous = legacy.providers[id as typeof snapshotV3ProviderIds[number]];
    return [id, previous || {
      mode: id === "foen-flood" || id === "vigicrues" ? "authoritative" : "disabled",
      status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "not_yet_checked",
    }];
  }));
  return SnapshotV4Schema.parse({ ...legacy, schemaVersion: 4, providers });
}

function upgradeSnapshotV4(legacy: z.infer<typeof SnapshotV4Schema>): z.infer<typeof SnapshotV5Schema> {
  const providers = Object.fromEntries(snapshotV5ProviderIds.map((id) => {
    const previous = legacy.providers[id as typeof snapshotV4ProviderIds[number]];
    return [id, previous || {
      mode: id === "ehyd-flood" ? "authoritative" : "disabled",
      status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "not_yet_checked",
    }];
  }));
  return SnapshotV5Schema.parse({ ...legacy, schemaVersion: 5, providers });
}

function upgradeSnapshotV5(legacy: z.infer<typeof SnapshotV5Schema>): z.infer<typeof SnapshotV6Schema> {
  const providers = Object.fromEntries(Object.entries(legacy.providers).filter(([id]) => id !== "bbk-mowas" && id !== "eurdep"));
  return SnapshotV6Schema.parse({ ...legacy, schemaVersion: 6, providers });
}

function upgradeSnapshotV6(legacy: z.infer<typeof SnapshotV6Schema>): z.infer<typeof SnapshotV7Schema> {
  const emptyProvider = (mode: "complementary") => ({
    mode, status: "disabled" as const, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, limitationCode: "not_available_in_snapshot_v6",
  });
  const providers = Object.fromEntries(snapshotV10ProviderIds.map((id) => [
    id, legacy.providers[id as keyof typeof legacy.providers] || emptyProvider("complementary"),
  ]));
  return SnapshotV7Schema.parse({ ...legacy, schemaVersion: 7, providers });
}

function upgradeSnapshotV7(legacy: z.infer<typeof SnapshotV7Schema>): z.infer<typeof SnapshotV8Schema> {
  const locations = Object.fromEntries(Object.entries(legacy.locations).map(([id, state]) => [
    id,
    state.level === "NORMAL" || state.level === "UNKNOWN" ? state : {
      ...state,
      hazards: state.hazards.map((hazard) => ({
        ...hazard,
        evidence: [{
          providerId: hazard.providerId,
          sourceName: hazard.sourceName,
          sourceUrl: hazard.sourceUrl,
          sourceUpdatedAt: hazard.sourceUpdatedAt,
          checkedAt: hazard.checkedAt,
          confidence: hazard.confidence,
        }],
      })),
    },
  ]));
  return SnapshotV8Schema.parse({ ...legacy, schemaVersion: 8, locations });
}

function upgradeSnapshotV8(legacy: z.infer<typeof SnapshotV8Schema>): z.infer<typeof SnapshotV9Schema> {
  const locations = Object.fromEntries(Object.entries(legacy.locations).map(([id, state]) => [id, {
    ...state,
    delayedHazards: inferV8DelayedHazards(legacy, id, state),
  }]));
  return SnapshotV9Schema.parse({ ...legacy, schemaVersion: 9, locations });
}

const catalogV2LocationIds = ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"] as const;

function upgradeSnapshotV9(legacy: z.infer<typeof SnapshotV9Schema>): z.infer<typeof SnapshotV10Schema> {
  const locations = { ...legacy.locations };
  for (const id of catalogV2LocationIds) locations[id] ||= {
    level: "UNKNOWN", coverage: "delayed", coverageGaps: [], delayedHazards: [...HazardTypeSchema.options], hazards: [],
  };
  return SnapshotV10Schema.parse({ ...legacy, schemaVersion: 10, catalogVersion: 2, locations });
}

function inferV8DelayedHazards(
  legacy: z.infer<typeof SnapshotV8Schema>,
  locationId: string,
  state: z.infer<typeof V8LocationStateSchema>,
): HazardType[] {
  if (state.coverage !== "delayed") return [];
  // Immutable migration policy. Active coverage changes must not reinterpret
  // historical gaps or make a legacy snapshot depend on newly added countries.
  const policy = delayedProvidersV2 as unknown as {
    countries: Record<string, Partial<Record<HazardType, ProviderId[]>>>;
    locationOverrides: Record<string, Partial<Record<HazardType, ProviderId[]>>>;
  };
  const countryCode = locationId.slice(0, 2).toUpperCase() as CountryCode;
  const countryCoverage = policy.countries[countryCode];
  if (!countryCoverage) return [...state.coverageGaps];
  const override = policy.locationOverrides[locationId] || {};
  const delayed = state.coverageGaps.filter((hazard) => {
    // An explicit empty override suppresses the country default.
    const providers = override[hazard] ?? countryCoverage[hazard] ?? [];
    return providers.some((providerId) => {
      const provider = legacy.providers[providerId];
      const scoped = provider?.partitions?.[countryCode] || provider;
      return scoped?.status === "partial" || scoped?.status === "delayed" || scoped?.status === "failed"
        || (providerId === "national-civil-alerts" && scoped?.status === "disabled");
    });
  });
  // A fully stale V8 snapshot can have healthy-looking provider states. When health
  // cannot identify a narrower cause, retaining every old gap is the fail-closed path.
  return delayed.length ? delayed : [...state.coverageGaps];
}

const CandidateRingSchema = z.array(PositionSchema).min(4).max(2_000).refine(
  (ring) => ring[0][0] === ring.at(-1)?.[0] && ring[0][1] === ring.at(-1)?.[1],
  "Candidate polygon rings must be closed",
);
export const DiscoveryGeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: PositionSchema }),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(CandidateRingSchema).min(1).max(32) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(CandidateRingSchema).min(1).max(32)).min(1).max(32) }),
]);
export const DiscoveryCandidateSchema = z.object({
  providerId: z.enum(["gdacs", "gdelt"]), externalId: z.string().min(1).max(100), hazardType: HazardTypeSchema,
  geometry: DiscoveryGeometrySchema, startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }), officialUrl: HttpUrlSchema, expiresAt: z.string().datetime({ offset: true }),
  publisherDomain: z.string().min(3).max(253).optional(),
  ownershipGroup: z.string().min(2).max(100).optional(),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  titleFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  descriptionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  canonicalUrl: HttpUrlSchema.optional(),
}).superRefine((candidate, context) => {
  if (Date.parse(candidate.endsAt) <= Date.parse(candidate.startsAt)) context.addIssue({ code: "custom", path: ["endsAt"], message: "Candidate end must be after its start" });
  if (Date.parse(candidate.expiresAt) <= Date.parse(candidate.startsAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Candidate expiry must be after its start" });
});
export const AggregateSourceResultSchema = z.object({
  sourceId: AggregateSourceIdSchema,
  checkedAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  events: z.array(NormalizedEventV12Schema),
  status: z.enum(["ok", "partial", "failed", "disabled"]),
  error: z.string().max(300).nullable(),
  limitationCode: z.string().max(100).nullable().optional(),
  checkedLocationIds: z.array(z.string().min(1)).max(600).optional(),
  unavailableLocationIds: z.array(z.string().min(1)).max(600).optional(),
  removedEventPrefixes: z.array(z.string().min(1).max(200)).max(500).optional(),
  unavailableEventIds: z.array(z.string().min(1)).optional(),
  candidates: z.array(DiscoveryCandidateSchema).max(200).optional(),
}).superRefine((result, context) => {
  const checked = new Set(result.checkedLocationIds || []);
  for (const [index, id] of (result.unavailableLocationIds || []).entries()) {
    if (checked.has(id)) context.addIssue({ code: "custom", path: ["unavailableLocationIds", index], message: "Checked and unavailable location IDs must be disjoint" });
  }
  if (result.status === "disabled" && !result.limitationCode) {
    context.addIssue({ code: "custom", path: ["limitationCode"], message: "Disabled sources require a limitation code" });
  }
});

const SourcePartitionTransportResultSchema = z.object({
  status: z.enum(["ok", "partial", "failed", "disabled", "not_due"]),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  error: z.string().max(300).nullable(),
  limitationCode: z.string().max(100).nullable().optional(),
  checkedLocationIds: z.array(z.string().min(1)).max(600).optional(),
  unavailableLocationIds: z.array(z.string().min(1)).max(600).optional(),
  events: z.array(NormalizedEventV12Schema).max(500).optional(),
  removedEventPrefixes: z.array(z.string().min(1).max(200)).max(500).optional(),
}).superRefine((transport, context) => {
  const checked = new Set(transport.checkedLocationIds || []);
  if (transport.unavailableLocationIds?.some((id) => checked.has(id))) context.addIssue({ code: "custom", message: "Transport checked and unavailable destinations must be disjoint" });
});

const SourcePartitionResultSchema = z.object({
  status: z.enum(["ok", "partial", "failed", "disabled"]),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  events: z.array(NormalizedEventV12Schema),
  error: z.string().max(300).nullable(),
  limitationCode: z.string().max(100).nullable().optional(),
  checkedLocationIds: z.array(z.string().min(1)).max(600).optional(),
  unavailableLocationIds: z.array(z.string().min(1)).max(600).optional(),
  removedEventPrefixes: z.array(z.string().min(1).max(200)).max(500).optional(),
  transports: z.record(z.string(), SourcePartitionTransportResultSchema).optional(),
}).superRefine((partition, context) => {
  const checked = new Set(partition.checkedLocationIds || []);
  for (const [index, id] of (partition.unavailableLocationIds || []).entries()) {
    if (checked.has(id)) context.addIssue({ code: "custom", path: ["unavailableLocationIds", index], message: "Checked and unavailable location IDs must be disjoint" });
  }
  if (partition.status === "disabled" && !partition.limitationCode) {
    context.addIssue({ code: "custom", path: ["limitationCode"], message: "Disabled partitions require a limitation code" });
  }
  if (partition.transports && Object.keys(partition.transports).length > 4) context.addIssue({ code: "custom", path: ["transports"], message: "Country partitions support at most four transports" });
});

export const PartitionedSourceResultSchema = z.object({
  sourceId: z.enum(["meteoalarm", "eea", "national-civil-alerts"]),
  checkedAt: z.string().datetime({ offset: true }),
  partitions: z.record(CatalogV2CountryCodeSchema, SourcePartitionResultSchema),
}).superRefine((result, context) => {
  for (const [countryCode, partition] of Object.entries(result.partitions)) {
    const groups = [{ path: ["events"], events: partition.events, transportId: null as string | null },
      ...Object.entries(partition.transports || {}).map(([id, transport]) => ({ path: ["transports", id, "events"], events: transport.events || [], transportId: id }))];
    for (const group of groups) for (const [index, event] of group.events.entries()) {
      const regionalCountryMatches = event.geometry.kind === "regions" && event.geometry.countryCode === countryCode;
      const locationCountryMatches = event.geometry.kind === "locations" && event.geometry.ids.every((id) => id.startsWith(`${countryCode.toLowerCase()}-`));
      if (event.sourceId !== result.sourceId || (!regionalCountryMatches && !locationCountryMatches)
        || (group.transportId && event.transportId && event.transportId !== group.transportId)) {
        context.addIssue({
          code: "custom",
          path: ["partitions", countryCode, ...group.path, index],
          message: "Partition events must use matching regional or location geometry",
        });
      }
    }
  }
});

export const SourceResultSchema = z.union([AggregateSourceResultSchema, PartitionedSourceResultSchema]);

export const IngestionStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime({ offset: true }),
  events: z.array(LegacyNormalizedEventSchema),
  sources: z.record(LegacySourceIdSchema, SourceHealthSchema),
  fingerprints: z.record(z.string(), z.string().datetime({ offset: true })),
});

export const IngestionStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  updatedAt: z.string().datetime({ offset: true }),
  events: z.array(LegacyNormalizedEventSchema),
  sources: z.record(LegacySourceIdSchema, SourceHealthSchema),
  sourcePartitions: z.object({
    meteoalarm: z.record(CatalogV2CountryCodeSchema, SourceHealthSchema),
  }),
  fingerprints: z.record(z.string(), z.string().datetime({ offset: true })),
});
export const IngestionStateV3Schema = IngestionStateV2Schema.extend({
  schemaVersion: z.literal(3), candidates: z.array(DiscoveryCandidateSchema).max(200),
  events: z.array(NormalizedEventV12Schema),
  sources: z.record(z.enum(SnapshotV3SourceIdSchema.options.filter((id) => id !== "national-civil-alerts") as [Exclude<z.infer<typeof SnapshotV3SourceIdSchema>, "national-civil-alerts">, ...Exclude<z.infer<typeof SnapshotV3SourceIdSchema>, "national-civil-alerts">[]]), SourceHealthSchema),
  providers: z.record(SnapshotV2ProviderIdSchema, SourceHealthSchema),
  sourcePartitions: IngestionStateV2Schema.shape.sourcePartitions.extend({ bbk: z.record(z.string(), SourceHealthSchema) }),
});

export const ProviderCoverageStateSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  checkedLocationIds: z.array(z.string().min(1)).max(600),
  unavailableLocationIds: z.array(z.string().min(1)).max(600),
}).superRefine((coverage, context) => {
  const checked = new Set(coverage.checkedLocationIds);
  for (const [index, id] of coverage.unavailableLocationIds.entries()) {
    if (checked.has(id)) context.addIssue({ code: "custom", path: ["unavailableLocationIds", index], message: "Checked and unavailable location IDs must be disjoint" });
  }
});

export const IngestionStateV4Schema = IngestionStateV3Schema.omit({ schemaVersion: true, sourcePartitions: true, sources: true, providers: true }).extend({
  schemaVersion: z.literal(4),
  sources: z.record(SnapshotV3SourceIdSchema, SourceHealthSchema),
  providers: z.record(SnapshotV3ProviderIdSchema, SourceHealthSchema),
  sourcePartitions: z.object({
    meteoalarm: z.record(CatalogV2CountryCodeSchema, SourceHealthSchema),
    eea: z.record(CatalogV2CountryCodeSchema, SourceHealthSchema),
    nationalCivilAlerts: z.record(CatalogV2CountryCodeSchema, SourceHealthSchema),
  }),
  providerCoverage: z.partialRecord(SnapshotV3ProviderIdSchema, ProviderCoverageStateSchema),
});

export const IngestionStateV5Schema = IngestionStateV4Schema.omit({ schemaVersion: true, sources: true, providers: true, providerCoverage: true }).extend({
  schemaVersion: z.literal(5),
  sources: z.record(SnapshotV4SourceIdSchema, SourceHealthSchema),
  providers: z.record(SnapshotV4ProviderIdSchema, SourceHealthSchema),
  providerCoverage: z.partialRecord(SnapshotV4ProviderIdSchema, ProviderCoverageStateSchema),
});

export const IngestionStateV6Schema = IngestionStateV5Schema.omit({ schemaVersion: true, sources: true, providers: true, providerCoverage: true }).extend({
  schemaVersion: z.literal(6),
  sources: z.record(SnapshotV5SourceIdSchema, SourceHealthSchema),
  providers: z.record(SnapshotV5ProviderIdSchema, SourceHealthSchema),
  providerCoverage: z.partialRecord(SnapshotV5ProviderIdSchema, ProviderCoverageStateSchema),
});

export const IngestionStateV7Schema = IngestionStateV6Schema.omit({ schemaVersion: true, sources: true, providers: true, providerCoverage: true }).extend({
  schemaVersion: z.literal(7),
  sources: z.record(SnapshotV6SourceIdSchema, SourceHealthSchema),
  providers: z.record(SnapshotV6ProviderIdSchema, SourceHealthSchema),
  providerCoverage: z.partialRecord(SnapshotV6ProviderIdSchema, ProviderCoverageStateSchema),
});

export const IngestionStateV8Schema = IngestionStateV7Schema.omit({ schemaVersion: true, sources: true, providers: true, providerCoverage: true }).extend({
  schemaVersion: z.literal(8),
  sources: z.record(SnapshotV10SourceIdSchema, SourceHealthSchema),
  providers: z.record(SnapshotV10ProviderIdSchema, SourceHealthSchema),
  providerCoverage: z.partialRecord(SnapshotV10ProviderIdSchema, ProviderCoverageStateSchema),
});
export const IngestionStateV9Schema = IngestionStateV8Schema.omit({ schemaVersion: true, candidates: true }).extend({
  schemaVersion: z.literal(9), candidates: z.array(DiscoveryCandidateSchema).max(400),
});

const TransportHealthSchema = SourceHealthSchema.extend({
  checkedLocationIds: z.array(z.string().min(1)).max(600),
  unavailableLocationIds: z.array(z.string().min(1)).max(600),
});
const CountryTransportHealthSchema = z.record(CatalogV2CountryCodeSchema, z.record(z.string(), TransportHealthSchema)).superRefine((countries, context) => {
  for (const [countryCode, transports] of Object.entries(countries)) {
    if (Object.keys(transports).length > 4) context.addIssue({ code: "custom", path: [countryCode], message: "Country transport health is capped at four systems" });
  }
});
export const IngestionStateV10Schema = IngestionStateV9Schema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(10),
  partitionTransports: z.object({ meteoalarm: CountryTransportHealthSchema, nationalCivilAlerts: CountryTransportHealthSchema }),
});
export const IngestionStateV11Schema = IngestionStateV10Schema.extend({
  schemaVersion: z.literal(11),
  partitionTransports: IngestionStateV10Schema.shape.partitionTransports.extend({ eea: CountryTransportHealthSchema }),
  conditions: ConditionsCacheV1Schema,
});
export const IngestionStateV12Schema = IngestionStateV11Schema.omit({ schemaVersion: true, conditions: true }).extend({
  schemaVersion: z.literal(12),
  conditions: ConditionsCacheV2Schema,
});

export function parseIngestionState(value: unknown): z.infer<typeof IngestionStateV12Schema> {
  const version = value && typeof value === "object" && "schemaVersion" in value
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : null;
  if (version === 12) return IngestionStateV12Schema.parse(value);
  if (version === 11) return upgradeIngestionStateV11(IngestionStateV11Schema.parse(value));
  if (version === 10) return upgradeIngestionStateV11(upgradeIngestionStateV10(IngestionStateV10Schema.parse(value)));
  if (version === 9) return upgradeIngestionStateV9(IngestionStateV9Schema.parse(value));
  if (version === 8) return upgradeIngestionStateV9(upgradeIngestionStateV8(IngestionStateV8Schema.parse(value)));
  if (version === 7) return upgradeIngestionStateV9(upgradeIngestionStateV8(upgradeIngestionStateV7(IngestionStateV7Schema.parse(value))));
  if (version === 6) return upgradeIngestionStateV9(upgradeIngestionStateV8(upgradeIngestionStateV7(upgradeIngestionStateV6(IngestionStateV6Schema.parse(value)))));
  if (version === 5) return upgradeIngestionStateV9(upgradeIngestionStateV8(upgradeIngestionStateV7(upgradeIngestionStateV6(upgradeIngestionStateV5(IngestionStateV5Schema.parse(value))))));
  if (version === 4) return upgradeIngestionStateV9(upgradeIngestionStateV8(upgradeIngestionStateV7(upgradeIngestionStateV6(upgradeIngestionStateV5(upgradeIngestionStateV4(IngestionStateV4Schema.parse(value)))))));
  const legacyV3 = version === 3 ? IngestionStateV3Schema.parse(value) : null;
  const legacy = legacyV3 || (version === 2 ? IngestionStateV2Schema.parse(value) : version === 1 ? (() => {
    const v1 = IngestionStateV1Schema.parse(value);
    return { ...v1, schemaVersion: 2 as const, sourcePartitions: { meteoalarm: Object.fromEntries(catalogV2CountryCodes.map((code) => [code, structuredClone(v1.sources.meteoalarm)])) } };
  })() : null);
  if (!legacy) throw new Error(`Unsupported ingestion-state schema version: ${String(version)}`);
  const empty = { status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: null };
  const sources = Object.fromEntries(SnapshotV3SourceIdSchema.options.map((id) => [id, legacy.sources[id as keyof typeof legacy.sources] ? structuredClone(legacy.sources[id as keyof typeof legacy.sources]) : structuredClone(empty)]));
  const providerSource = { meteoalarm: "meteoalarm", usgs: "usgs", "effis-fire-danger": "effis", "cems-rapid-mapping": "cems", "eea-aqi": "eea", gdelt: "gdelt", eurdep: "eurdep" } as const;
  const providers = Object.fromEntries(snapshotV3ProviderIds.map((id) => {
    const previousProvider = legacyV3?.providers[id as keyof typeof legacyV3.providers];
    if (previousProvider) return [id, structuredClone(previousProvider)];
    const source = providerSource[id as keyof typeof providerSource];
    return [id, source && source in legacy.sources ? structuredClone(legacy.sources[source]) : structuredClone(empty)];
  }));
  const events = legacy.events.map((event) => ({ ...event, providerId: event.providerId || providerIdForSourceId(event.sourceId) }));
  const emptyCountries = (sourceId: z.infer<typeof SnapshotV10SourceIdSchema>) => Object.fromEntries(catalogV2CountryCodes.map((code) => [code, {
    ...structuredClone(empty), status: sourceId === "eea" ? "failed" : "not_monitored",
    error: sourceId === "eea" ? "Not yet checked" : null,
  }]));
  return upgradeIngestionStateV9(upgradeIngestionStateV8(upgradeIngestionStateV7(upgradeIngestionStateV6(upgradeIngestionStateV5(upgradeIngestionStateV4(IngestionStateV4Schema.parse({
    ...legacy, schemaVersion: 4, events, sources,
    candidates: "candidates" in legacy ? legacy.candidates : [], providers,
    sourcePartitions: {
      meteoalarm: legacy.sourcePartitions.meteoalarm,
      eea: emptyCountries("eea"),
      nationalCivilAlerts: emptyCountries("national-civil-alerts"),
    },
    providerCoverage: {},
  })))))));
}

function upgradeIngestionStateV4(legacy: z.infer<typeof IngestionStateV4Schema>): z.infer<typeof IngestionStateV5Schema> {
  const empty: z.infer<typeof SourceHealthSchema> = {
    status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: null,
  };
  const sources = Object.fromEntries(SnapshotV4SourceIdSchema.options.map((id) => [
    id, structuredClone(legacy.sources[id as typeof snapshotV3SourceIds[number]] || { ...empty, error: "not_yet_checked" }),
  ]));
  const providers = Object.fromEntries(snapshotV4ProviderIds.map((id) => [
    id, structuredClone(legacy.providers[id as typeof snapshotV3ProviderIds[number]] || { ...empty, error: "not_yet_checked" }),
  ]));
  return IngestionStateV5Schema.parse({
    ...legacy, schemaVersion: 5, sources, providers, providerCoverage: legacy.providerCoverage,
  });
}

function upgradeIngestionStateV5(legacy: z.infer<typeof IngestionStateV5Schema>): z.infer<typeof IngestionStateV6Schema> {
  const empty: z.infer<typeof SourceHealthSchema> = {
    status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: null,
  };
  const sources = Object.fromEntries(SnapshotV5SourceIdSchema.options.map((id) => [
    id, structuredClone(legacy.sources[id as typeof snapshotV4SourceIds[number]] || { ...empty, error: "not_yet_checked" }),
  ]));
  const providers = Object.fromEntries(snapshotV5ProviderIds.map((id) => [
    id, structuredClone(legacy.providers[id as typeof snapshotV4ProviderIds[number]] || { ...empty, error: "not_yet_checked" }),
  ]));
  return IngestionStateV6Schema.parse({
    ...legacy, schemaVersion: 6, sources, providers, providerCoverage: legacy.providerCoverage,
  });
}

function upgradeIngestionStateV6(legacy: z.infer<typeof IngestionStateV6Schema>): z.infer<typeof IngestionStateV7Schema> {
  const sources = Object.fromEntries(Object.entries(legacy.sources).filter(([id]) => id !== "bbk-mowas" && id !== "eurdep"));
  const providers = Object.fromEntries(Object.entries(legacy.providers).filter(([id]) => id !== "bbk-mowas" && id !== "eurdep"));
  const providerCoverage = Object.fromEntries(Object.entries(legacy.providerCoverage).filter(([id]) => id !== "bbk-mowas" && id !== "eurdep"));
  return IngestionStateV7Schema.parse({ ...legacy, schemaVersion: 7, sources, providers, providerCoverage });
}

function upgradeIngestionStateV7(legacy: z.infer<typeof IngestionStateV7Schema>): z.infer<typeof IngestionStateV8Schema> {
  const empty: z.infer<typeof SourceHealthSchema> = {
    status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: "not_yet_checked",
  };
  const sources = Object.fromEntries(snapshotV10SourceIds.map((id) => [id, structuredClone(legacy.sources[id as keyof typeof legacy.sources] || empty)]));
  const providers = Object.fromEntries(snapshotV10ProviderIds.map((id) => [id, structuredClone(legacy.providers[id as keyof typeof legacy.providers] || empty)]));
  return IngestionStateV8Schema.parse({
    ...legacy, schemaVersion: 8, sources, providers,
    providerCoverage: Object.fromEntries(Object.entries(legacy.providerCoverage)),
  });
}

function upgradeIngestionStateV8(legacy: z.infer<typeof IngestionStateV8Schema>): z.infer<typeof IngestionStateV9Schema> {
  return IngestionStateV9Schema.parse({ ...legacy, schemaVersion: 9 });
}

function upgradeIngestionStateV9(legacy: z.infer<typeof IngestionStateV9Schema>): z.infer<typeof IngestionStateV12Schema> {
  const emptyCountries = Object.fromEntries(catalogV2CountryCodes.map((countryCode) => [countryCode, {}]));
  return upgradeIngestionStateV11(upgradeIngestionStateV10(IngestionStateV10Schema.parse({
    ...legacy, schemaVersion: 10,
    partitionTransports: { meteoalarm: structuredClone(emptyCountries), nationalCivilAlerts: structuredClone(emptyCountries) },
  })));
}

// Only known adapter namespaces establish ownership. Unrecognized legacy events
// remain unassigned and expire normally rather than being attributed by country.
export function legacyEventTransport(event: Pick<NormalizedEvent, "sourceId" | "id" | "sourceUrl">): string | undefined {
  const prefixes: Record<string, string> = {
    "at-alert:": "at-alert", "fr-alert:": "fr-alert", "lu-alert:": "lu-alert",
    "lhp:": "lhp-flood", "catalonia-plan:": "catalonia-plans", "pl:": "imgw-hydrology",
    "cz:": "chmi-hydrology", "it:flood-bulletin:": "dpc-flood-bulletin", "krisinformation:": "krisinformation",
    "meteoalarm:fmi:": "fmi-cap", "meteoalarm:met-eireann:": "met-eireann-json", "meteoalarm:ipma:": "ipma-warnings-json",
  };
  if (event.sourceId === "national-civil-alerts" || event.sourceId === "meteoalarm") {
    return Object.entries(prefixes).find(([prefix]) => event.id.startsWith(prefix))?.[1];
  }
  if (event.sourceId === "eea") return new URL(event.sourceUrl).hostname.endsWith("idecanarias.es") ? "canary-air" : "eea-raster";
}

export function upgradeIngestionStateV10(legacy: z.infer<typeof IngestionStateV10Schema>): z.infer<typeof IngestionStateV11Schema> {
  return IngestionStateV11Schema.parse({
    ...legacy, schemaVersion: 11,
    events: legacy.events.map((event) => ({ ...event, transportId: event.transportId || legacyEventTransport(event) })),
    partitionTransports: { ...legacy.partitionTransports, eea: Object.fromEntries(catalogV2CountryCodes.map((code) => [code, {}])) },
    conditions: ConditionsCacheV1Schema.parse({}),
  });
}

export function upgradeIngestionStateV11(legacy: z.infer<typeof IngestionStateV11Schema>): z.infer<typeof IngestionStateV12Schema> {
  const locations = Object.fromEntries(Object.entries(legacy.conditions.locations).map(([id, value]) => [id, {
    weather: value.weather, airQuality: value.airQuality, marine: value.marine,
    observations: value.observations, rivers: value.rivers, earthquakes: value.earthquakes,
    infrastructureIncidents: value.disruptions.map((item) => InfrastructureIncidentSchema.parse({
      ...item, kind: item.kind === "road-closed" ? "road-closure" : "road-disruption", status: "active",
      scope: "destination", scopeLabel: "Near destination", estimatedRestorationAt: null,
    })),
    systemConditions: [], limitations: value.limitations,
  }]));
  return IngestionStateV12Schema.parse({ ...legacy, schemaVersion: 12, conditions: { ...legacy.conditions, locations } });
}

export function downgradeIngestionStateV12(state: z.infer<typeof IngestionStateV12Schema>) {
  const locations = Object.fromEntries(Object.entries(state.conditions.locations).map(([id, value]) => [id, {
    weather: value.weather, airQuality: value.airQuality, marine: value.marine,
    observations: value.observations, rivers: value.rivers, earthquakes: value.earthquakes,
    disruptions: value.infrastructureIncidents.filter((item) => item.sourceId === "digitraffic").map((item) => ({
      sourceId: item.sourceId, sourceUpdatedAt: item.sourceUpdatedAt, checkedAt: item.checkedAt, expiresAt: item.expiresAt,
      id: item.id, startsAt: item.startsAt, endsAt: item.endsAt, kind: item.kind === "road-closure" ? "road-closed" as const : "major-interruption" as const,
      sourceUrl: item.sourceUrl,
    })), limitations: value.limitations,
  }]));
  const health = Object.fromEntries(Object.entries(state.conditions.health).filter(([id]) => conditionSourceIdsV1.includes(id as typeof conditionSourceIdsV1[number])));
  return IngestionStateV11Schema.parse({ ...state, schemaVersion: 11, conditions: { ...state.conditions, health, locations } });
}

export function downgradeIngestionStateV11(state: z.infer<typeof IngestionStateV11Schema>) {
  return IngestionStateV10Schema.parse({ ...state, schemaVersion: 10,
    events: state.events.map((event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== "transportId"))),
  });
}

export type CountryCode = z.infer<typeof CatalogV2CountryCodeSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type PublicLocation = z.infer<typeof PublicLocationSchema>;
export type NormalizedEvent = z.infer<typeof NormalizedEventV12Schema>;
export type PublicHazard = z.infer<typeof PublicHazardV10Schema>;
export type SourceHealth = z.infer<typeof SourceHealthSchema>;
export type SourceResult = z.infer<typeof SourceResultSchema>;
export type AggregateSourceResult = z.infer<typeof AggregateSourceResultSchema>;
export type PartitionedSourceResult = z.infer<typeof PartitionedSourceResultSchema>;
export type SourceId = z.infer<typeof SnapshotV10SourceIdSchema>;
export type ProviderId = z.infer<typeof SnapshotV10ProviderIdSchema>;
export type PublicProviderState = z.infer<typeof PublicProviderV10StateSchema>;
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
export type Snapshot = z.infer<typeof SnapshotV10Schema>;
export type LocationState = z.infer<typeof LocationStateV10Schema>;
export type IngestionState = z.infer<typeof IngestionStateV12Schema>;
export type HazardType = z.infer<typeof HazardTypeSchema>;
export type HazardLevel = z.infer<typeof HazardLevelSchema>;

// Do not extend historical definitions to publish a new release. Introduce new
// versioned definitions and move these aliases only at the compatible cutover.
export const CountryCodeSchema = z.enum(countryCodes);
export const SourceIdSchema = z.enum(sourceIds);
export const ProviderIdSchema = z.enum(providerIds);
export const PublicProviderStateSchema = PublicProviderV10StateSchema;
export const PublicEvidenceSchema = PublicEvidenceV10Schema;
export const PublicHazardSchema = PublicHazardV10Schema;
export const LocationStateSchema = LocationStateV10Schema;
export const NormalizedEventSchema = NormalizedEventV12Schema;
export const SnapshotSchema = SnapshotV10Schema;
export const IngestionStateSchema = IngestionStateV12Schema;
