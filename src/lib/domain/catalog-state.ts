import catalogV3 from "../../../data/catalog-releases/3.json";
import catalogV2 from "../../../data/catalog-releases/2.json";
import { z } from "zod";
import { catalogV2CountryCodes, catalogV3CountryCodes } from "./contract-identities";
import { ConditionSourceIdV2Schema, ConditionsCacheV2Schema } from "./conditions";
import {
  AggregateSourceResultSchema, IngestionStateV12Schema, NormalizedEventV12Schema, ProviderCoverageStateSchema,
  SnapshotV10ProviderIdSchema, SourceHealthSchema, parseIngestionState, providerIdForSourceId,
} from "./schemas";

// Historical schemas stay frozen. Canonical runtime imports this module directly;
// catalog 3 collection remains unavailable until its full execution path exists.
export const CatalogV3CountryCodeSchema = z.enum(catalogV3CountryCodes);
const locationIds = z.array(z.string().min(1)).max(679);
const geometry = NormalizedEventV12Schema.shape.geometry.options;
export const NormalizedEventV13Schema = z.object({
  ...NormalizedEventV12Schema.shape,
  geometry: z.discriminatedUnion("kind", [geometry[0], geometry[1], geometry[2].extend({ countryCode: CatalogV3CountryCodeSchema }), geometry[3]]),
}).refine((event) => Date.parse(event.startsAt) < Date.parse(event.endsAt), {
  message: "Event end time must be after its start time", path: ["endsAt"],
}).refine((event) => event.providerId === providerIdForSourceId(event.sourceId), {
  message: "Event provider must match its source adapter", path: ["providerId"],
});

export type NormalizedEventV13 = z.infer<typeof NormalizedEventV13Schema>;

const ProviderCoverageV13Schema = z.object({
  ...ProviderCoverageStateSchema.shape, checkedLocationIds: locationIds, unavailableLocationIds: locationIds,
}).superRefine((coverage, context) => {
  const checked = new Set(coverage.checkedLocationIds);
  for (const [index, id] of coverage.unavailableLocationIds.entries()) {
    if (checked.has(id)) context.addIssue({ code: "custom", path: ["unavailableLocationIds", index], message: "Checked and unavailable location IDs must be disjoint" });
  }
});
const TransportHealthV13Schema = SourceHealthSchema.extend({ checkedLocationIds: locationIds, unavailableLocationIds: locationIds });
const CountryTransportHealthV13Schema = z.record(CatalogV3CountryCodeSchema, z.record(z.string(), TransportHealthV13Schema)).superRefine((countries, context) => {
  for (const [countryCode, transports] of Object.entries(countries)) {
    if (Object.keys(transports).length > 4) context.addIssue({ code: "custom", path: [countryCode], message: "Country transport health is capped at four systems" });
  }
});
const countryHealth = z.record(CatalogV3CountryCodeSchema, SourceHealthSchema);
const timestamp = z.string().datetime({ offset: true });
const ConditionHealthV13Schema = z.object({
  checkedAt: timestamp, status: z.enum(["ok", "partial", "failed", "disabled"]), matched: z.number().int().nonnegative().max(679),
  code: z.string().regex(/^[a-z0-9_]+$/).max(60).nullable(),
});
export const ConditionsCacheV13Schema = z.object({
  ...ConditionsCacheV2Schema.shape,
  health: z.partialRecord(ConditionSourceIdV2Schema, ConditionHealthV13Schema).default({}),
}).superRefine((value, context) => {
  // Rebuild deliberately: safeExtend would retain V2's historical 600 limit.
  if (Object.keys(value.locations).length > 679 || Object.keys(value.attempts).length > 4000 || Object.keys(value.cacheUntil).length > 679) {
    context.addIssue({ code: "custom", message: "Conditions cache exceeds catalog bounds" });
  }
});
export const IngestionStateV13Schema = z.object({
  ...IngestionStateV12Schema.shape,
  schemaVersion: z.literal(13),
  collection: z.object({ catalogVersion: z.union([z.literal(2), z.literal(3)]), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  events: z.array(NormalizedEventV13Schema),
  sourcePartitions: z.object({ meteoalarm: countryHealth, eea: countryHealth, nationalCivilAlerts: countryHealth }),
  partitionTransports: z.object({ meteoalarm: CountryTransportHealthV13Schema, eea: CountryTransportHealthV13Schema, nationalCivilAlerts: CountryTransportHealthV13Schema }),
  providerCoverage: z.partialRecord(SnapshotV10ProviderIdSchema, ProviderCoverageV13Schema),
  conditions: ConditionsCacheV13Schema,
});
export type IngestionStateV13 = z.infer<typeof IngestionStateV13Schema>;

export function parseCatalogStateV13(value: unknown): IngestionStateV13 {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 13) return IngestionStateV13Schema.parse(value);
  const legacy = parseIngestionState(value);
  const newCountries = catalogV3CountryCodes.filter((code) => !(catalogV2CountryCodes as readonly string[]).includes(code));
  const unsupported = {
    status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null,
    nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: "catalog_not_activated",
  };
  return IngestionStateV13Schema.parse({
    ...legacy, schemaVersion: 13, collection: { catalogVersion: 2, revision: 0 },
    sourcePartitions: Object.fromEntries(Object.entries(legacy.sourcePartitions).map(([provider, countries]) => [provider, {
      ...countries, ...Object.fromEntries(newCountries.map((code) => [code, { ...unsupported }])),
    }])),
    partitionTransports: Object.fromEntries(Object.entries(legacy.partitionTransports).map(([provider, countries]) => [provider, {
      ...countries, ...Object.fromEntries(newCountries.map((code) => [code, {}])),
    }])),
  });
}

export type CollectionControl = IngestionStateV13["collection"];
export class CollectionChangedError extends Error {}

/** Revision fence for the compatible runtime; operational activation is monotonic. */
export function assertSupportedCollection(state: { collection: CollectionControl; publicationTransition?: PublicationTransition | null }, expected?: CollectionControl): CollectionControl {
  if (state.publicationTransition?.from === 3 && state.publicationTransition.to === 2) {
    throw new CollectionChangedError("Reverse collection requires an explicit withdrawal runtime; rollback must retain catalog 3");
  }
  if (expected && (state.collection.catalogVersion !== expected.catalogVersion || state.collection.revision !== expected.revision)) {
    throw new CollectionChangedError("Collection changed during work; discard stale results");
  }
  return { ...state.collection };
}

/** Reject unsupported collection and stale work; this is not a retryable CAS conflict. */
export function assertCatalog2Collection(state: { collection: CollectionControl }, expected?: CollectionControl): CollectionControl {
  if (state.collection.catalogVersion !== 2) throw new CollectionChangedError("Catalog 3 collection is not activated in this runtime");
  if (expected && (state.collection.catalogVersion !== expected.catalogVersion || state.collection.revision !== expected.revision)) {
    throw new CollectionChangedError("Collection changed during work; discard stale results");
  }
  return { ...state.collection };
}


export const PublicationTransitionSchema = z.object({
  from: z.union([z.literal(2), z.literal(3)]), to: z.union([z.literal(2), z.literal(3)]),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dualStartedAt: timestamp.nullable(), dualUntil: timestamp.nullable(),
}).superRefine((value, context) => {
  if (value.from === value.to) context.addIssue({ code: "custom", message: "Publication transition requires different releases" });
  if (Boolean(value.dualStartedAt) !== Boolean(value.dualUntil)
    || (value.dualStartedAt && value.dualUntil && Date.parse(value.dualUntil) - Date.parse(value.dualStartedAt) !== 24 * 3_600_000)) {
    context.addIssue({ code: "custom", message: "Acknowledged dual publication requires exactly 24 hours" });
  }
});
export type PublicationTransition = z.infer<typeof PublicationTransitionSchema>;
export const expandedReceiptSourceIds = ["usgs", "emsc", "fcdo-travel-advice", "slf-avalanche"] as const;
const legacyIds = new Set<string>(catalogV2.locationIds);
const newIds = catalogV3.locationIds.filter((id) => !legacyIds.has(id));
export const expandedReceiptLocationIds = {
  usgs: newIds, emsc: newIds,
  "fcdo-travel-advice": newIds.filter((id) => !id.startsWith("gb-") && !id.startsWith("va-")),
  "slf-avalanche": ["li-malbun"],
} as const;
const ExpandedReceiptSchema = z.object({
  health: SourceHealthSchema,
  checkedLocationIds: z.array(z.string()).max(176), unavailableLocationIds: z.array(z.string()).max(176),
});
export const ExpandedSourceHealthSchema = z.partialRecord(z.enum(expandedReceiptSourceIds), ExpandedReceiptSchema).superRefine((value, context) => {
  for (const source of expandedReceiptSourceIds) {
    const receipt = value[source]; if (!receipt) continue;
    const expected = new Set<string>(expandedReceiptLocationIds[source]);
    const all = [...receipt.checkedLocationIds, ...receipt.unavailableLocationIds];
    if (all.length !== expected.size || new Set(all).size !== all.length || all.some((id) => !expected.has(id))) {
      context.addIssue({ code: "custom", path: [source], message: "Expanded receipt must classify its exact reviewed scope once" });
    }
    if (receipt.health.lastSuccess && (!receipt.health.lastAttempt || Date.parse(receipt.health.lastSuccess) > Date.parse(receipt.health.lastAttempt))) {
      context.addIssue({ code: "custom", path: [source, "health", "lastSuccess"], message: "Expanded successful check cannot be later than its attempt" });
    }
    if (receipt.checkedLocationIds.length && receipt.health.lastSuccess !== receipt.health.lastAttempt) {
      context.addIssue({ code: "custom", path: [source], message: "Checked destinations require success at this receipt's attempt" });
    }
    if (!receipt.health.lastAttempt || (receipt.health.status === "ok" && receipt.unavailableLocationIds.length)
      || (["failed", "not_monitored"].includes(receipt.health.status) && receipt.checkedLocationIds.length)) {
      context.addIssue({ code: "custom", path: [source], message: "Expanded receipt health and checked scope disagree" });
    }
  }
});
export const IngestionStateV14Schema = IngestionStateV13Schema.extend({
  schemaVersion: z.literal(14), publicationTransition: PublicationTransitionSchema.nullable(),
  expandedSourceHealth: ExpandedSourceHealthSchema,
}).superRefine((value, context) => {
  if (value.publicationTransition && (value.publicationTransition.to !== value.collection.catalogVersion
    || value.publicationTransition.revision !== value.collection.revision)) {
    context.addIssue({ code: "custom", path: ["publicationTransition"], message: "Publication transition must match collection control" });
  }
});
export type IngestionStateV14 = z.infer<typeof IngestionStateV14Schema>;

export function parseCatalogState(value: unknown): IngestionStateV14 {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 14) return IngestionStateV14Schema.parse(value);
  return IngestionStateV14Schema.parse({ ...parseCatalogStateV13(value), schemaVersion: 14, publicationTransition: null, expandedSourceHealth: {} });
}

// Runtime-only result bounds. Historical source-result readers stay frozen.
export const ExpandedAggregateSourceResultSchema = AggregateSourceResultSchema.safeExtend({
  checkedLocationIds: z.array(z.string().min(1)).max(679).optional(),
  unavailableLocationIds: z.array(z.string().min(1)).max(679).optional(),
});
