import catalogV3 from "../../../data/catalog-releases/3.json";
import catalogV2 from "../../../data/catalog-releases/2.json";
import { z } from "zod";
import { catalogV2CountryCodes, catalogV3CountryCodes } from "./contract-identities";
import { ConditionSourceIdV2Schema, ConditionsCacheV2Schema } from "./conditions";
import {
  AggregateSourceResultSchema, IngestionStateV12Schema, NormalizedEventV12Schema, PartitionedSourceResultSchema, ProviderCoverageStateSchema,
  SnapshotV10ProviderIdSchema, SnapshotV10SourceIdSchema, SourceHealthSchema, SourcePartitionResultSchema,
  SourcePartitionTransportResultSchema, parseIngestionState, providerIdForSourceId,
} from "./schemas";

// Historical schemas stay frozen. Canonical runtime imports this module directly;
// catalog 3 collection remains unavailable until its full execution path exists.
export const CatalogV3CountryCodeSchema = z.enum(catalogV3CountryCodes);
const locationIds = z.array(z.string().min(1)).max(679);
const geometry = NormalizedEventV12Schema.shape.geometry.options;
export const NormalizedEventV13Schema = z.object({
  ...NormalizedEventV12Schema.shape,
  // Private merge ownership only. Public snapshot projections rebuild hazards
  // field-by-field and never expose this partition marker.
  partitionCountryCode: CatalogV3CountryCodeSchema.optional(),
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

export type LegacyCollectionControl = IngestionStateV13["collection"];
export type CollectionControl = { catalogVersion: 3; revision: number };
export class CollectionChangedError extends Error {}

/** Catalog 3 is the only writable runtime. Revision changes fence stale work. */
export function assertSupportedCollection(state: { collection: CollectionControl }, expected?: CollectionControl): CollectionControl {
  if (state.collection.catalogVersion !== 3) throw new CollectionChangedError("Catalog 3 collection is required");
  if (expected && (state.collection.catalogVersion !== expected.catalogVersion || state.collection.revision !== expected.revision)) {
    throw new CollectionChangedError("Collection changed during work; discard stale results");
  }
  return { ...state.collection };
}

/** Reject unsupported collection and stale work; this is not a retryable CAS conflict. */
export function assertCatalog2Collection(state: { collection: LegacyCollectionControl }, expected?: LegacyCollectionControl): LegacyCollectionControl {
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

export function parseCatalogStateV14(value: unknown): IngestionStateV14 {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 14) return IngestionStateV14Schema.parse(value);
  return IngestionStateV14Schema.parse({ ...parseCatalogStateV13(value), schemaVersion: 14, publicationTransition: null, expandedSourceHealth: {} });
}

// Runtime-only result bounds. Historical source-result readers stay frozen.
export const ExpandedAggregateSourceResultSchema = AggregateSourceResultSchema.safeExtend({
  checkedLocationIds: z.array(z.string().min(1)).max(679).optional(),
  unavailableLocationIds: z.array(z.string().min(1)).max(679).optional(),
});

const CatalogTransportResultSchema = z.object({ ...SourcePartitionTransportResultSchema.shape,
  checkedLocationIds: locationIds.optional(), unavailableLocationIds: locationIds.optional(),
  events: z.array(NormalizedEventV13Schema).max(500).optional(),
  frozenEaFloodAreaGeometries: z.record(z.string().min(1).max(100), z.array(geometry[1]).min(1).max(64)).refine((value) => Object.keys(value).length <= 100).optional(),
}).superRefine((transport, context) => {
  const checked = new Set(transport.checkedLocationIds || []);
  if (transport.unavailableLocationIds?.some((id) => checked.has(id))) context.addIssue({ code: "custom", message: "Transport checked and unavailable destinations must be disjoint" });
});
export type CatalogTransportResult = z.infer<typeof CatalogTransportResultSchema>;
const CatalogPartitionResultSchema = z.object({ ...SourcePartitionResultSchema.shape,
  checkedLocationIds: locationIds.optional(), unavailableLocationIds: locationIds.optional(),
  events: z.array(NormalizedEventV13Schema), transports: z.record(z.string(), CatalogTransportResultSchema).optional(),
}).superRefine((partition, context) => {
  const checked = new Set(partition.checkedLocationIds || []);
  if (partition.unavailableLocationIds?.some((id) => checked.has(id))) context.addIssue({ code: "custom", message: "Partition checked and unavailable destinations must be disjoint" });
  if (partition.status === "disabled" && !partition.limitationCode) context.addIssue({ code: "custom", path: ["limitationCode"], message: "Disabled partitions require a limitation code" });
  if (partition.transports && Object.keys(partition.transports).length > 6) context.addIssue({ code: "custom", path: ["transports"], message: "Country partitions support at most six transports" });
});

/** Runtime partition result for the full catalog. The historical 28-country result schema remains frozen. */
export const CatalogPartitionedSourceResultSchema = z.object({
  sourceId: z.enum(["meteoalarm", "eea", "national-civil-alerts"]),
  checkedAt: timestamp,
  partitions: z.record(CatalogV3CountryCodeSchema, CatalogPartitionResultSchema),
}).superRefine((result, context) => {
  for (const [countryCode, partition] of Object.entries(result.partitions)) {
    const groups = [{ path: ["events"] as (string | number)[], events: partition.events, transportId: null as string | null },
      ...Object.entries(partition.transports || {}).map(([id, transport]) => ({ path: ["transports", id, "events"] as (string | number)[], events: transport.events || [], transportId: id }))];
    for (const group of groups) for (const [index, event] of group.events.entries()) {
      const scoped = event.geometry.kind === "polygon" || event.geometry.kind === "point"
        || event.geometry.kind === "regions" && event.geometry.countryCode === countryCode
        || event.geometry.kind === "locations" && event.geometry.ids.every((id) => id.startsWith(`${countryCode.toLowerCase()}-`));
      if (event.sourceId !== result.sourceId || !scoped || (group.transportId && event.transportId && event.transportId !== group.transportId)) {
        context.addIssue({ code: "custom", path: ["partitions", countryCode, ...group.path, index], message: "Partition events must remain inside their catalog country transport" });
      }
    }
  }
});
export type CatalogPartitionedSourceResult = z.infer<typeof CatalogPartitionedSourceResultSchema>;
export type RuntimePartitionedSourceResult = z.infer<typeof PartitionedSourceResultSchema> | CatalogPartitionedSourceResult;
export const CatalogSourceResultSchema = z.union([ExpandedAggregateSourceResultSchema, PartitionedSourceResultSchema, CatalogPartitionedSourceResultSchema]);
export type CatalogSourceResult = z.infer<typeof CatalogSourceResultSchema>;

const CatalogReceiptSchema = z.object({
  catalogVersion: z.union([z.literal(2), z.literal(3)]),
  collectionRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checkedAt: timestamp,
  status: z.enum(["ok", "partial", "failed", "disabled"]),
  checkedLocationIds: locationIds,
  unavailableLocationIds: locationIds,
}).superRefine((receipt, context) => {
  const allowed = new Set<string>((receipt.catalogVersion === 3 ? catalogV3 : catalogV2).locationIds);
  const checked = new Set(receipt.checkedLocationIds);
  const all = [...receipt.checkedLocationIds, ...receipt.unavailableLocationIds];
  if (new Set(all).size !== all.length || all.some((id) => !allowed.has(id))) {
    context.addIssue({ code: "custom", message: "Catalog receipt locations must be unique members of its release" });
  }
  if (receipt.unavailableLocationIds.some((id) => checked.has(id))
    || receipt.status === "ok" && receipt.unavailableLocationIds.length
    || ["failed", "disabled"].includes(receipt.status) && receipt.checkedLocationIds.length) {
    context.addIssue({ code: "custom", message: "Catalog receipt status and classified scope disagree" });
  }
});
export const CatalogScopedReceiptsSchema = z.object({
  2: z.partialRecord(SnapshotV10SourceIdSchema, CatalogReceiptSchema),
  3: z.partialRecord(SnapshotV10SourceIdSchema, CatalogReceiptSchema),
});

export const EA_FLOOD_GEOMETRY_CACHE_LIMIT = 1_000_000;
const EaFloodAreaGeometryCacheSchema = z.record(z.string().min(1).max(100), z.array(geometry[1]).min(1).max(64))
  .refine((value) => Object.keys(value).length <= 128 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= EA_FLOOD_GEOMETRY_CACHE_LIMIT);

export const IngestionStateV15Schema = z.object({ ...IngestionStateV14Schema.shape,
  schemaVersion: z.literal(15),
  collectionReceipts: CatalogScopedReceiptsSchema,
  frozenEaFloodAreaGeometries: EaFloodAreaGeometryCacheSchema,
}).superRefine((value, context) => {
  if (value.publicationTransition && (value.publicationTransition.to !== value.collection.catalogVersion
    || value.publicationTransition.revision !== value.collection.revision)) {
    context.addIssue({ code: "custom", path: ["publicationTransition"], message: "Publication transition must match collection control" });
  }
  for (const [catalogVersion, receipts] of Object.entries(value.collectionReceipts)) for (const [sourceId, receipt] of Object.entries(receipts)) {
    if (receipt.catalogVersion !== Number(catalogVersion) || receipt.collectionRevision > value.collection.revision) {
      context.addIssue({ code: "custom", path: ["collectionReceipts", catalogVersion, sourceId], message: "Receipt must match its catalog and cannot be newer than collection control" });
    }
  }
});
export type IngestionStateV15 = z.infer<typeof IngestionStateV15Schema>;

/** Frozen V1→V15 reader used only by the V16 migration. */
export function parseCatalogStateV15(value: unknown): IngestionStateV15 {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 15) return IngestionStateV15Schema.parse(value);
  const legacy = parseCatalogStateV14(value);
  const receipts: IngestionStateV15["collectionReceipts"] = { 2: {}, 3: {} };
  if (legacy.collection.catalogVersion === 3) for (const [sourceId, receipt] of Object.entries(legacy.expandedSourceHealth)) {
    if (!receipt?.health.lastAttempt) continue;
    receipts[3][sourceId as keyof typeof receipts[3]] = {
      catalogVersion: 3, collectionRevision: legacy.collection.revision, checkedAt: receipt.health.lastAttempt,
      status: receipt.health.status === "not_monitored" ? "disabled"
        : receipt.health.status === "delayed" ? receipt.checkedLocationIds.length ? "partial" : "failed" : receipt.health.status,
      checkedLocationIds: receipt.checkedLocationIds, unavailableLocationIds: receipt.unavailableLocationIds,
    };
  }
  return IngestionStateV15Schema.parse({ ...legacy, schemaVersion: 15, collectionReceipts: receipts, frozenEaFloodAreaGeometries: {} });
}

const Catalog3ReceiptsSchema = z.partialRecord(SnapshotV10SourceIdSchema, CatalogReceiptSchema);
export const IngestionLeaseSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9._:-]{8,160}$/),
  fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: timestamp,
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { schemaVersion: _schemaVersion, publicationTransition: _publicationTransition,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  collection: _collection, collectionReceipts: _collectionReceipts, ...runtimeShape } = IngestionStateV15Schema.shape;
export const IngestionStateV16Schema = z.object({
  ...runtimeShape,
  schemaVersion: z.literal(16),
  collection: z.object({ catalogVersion: z.literal(3), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  collectionReceipts: z.object({ 3: Catalog3ReceiptsSchema }),
  stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ingestionFence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ingestionLease: IngestionLeaseSchema.nullable(),
}).superRefine((value, context) => {
  if (value.ingestionLease && value.ingestionLease.fence !== value.ingestionFence) {
    context.addIssue({ code: "custom", path: ["ingestionLease", "fence"], message: "Lease fence must match state fence" });
  }
  for (const [sourceId, receipt] of Object.entries(value.collectionReceipts[3])) {
    if (receipt.catalogVersion !== 3 || receipt.collectionRevision > value.collection.revision) {
      context.addIssue({ code: "custom", path: ["collectionReceipts", "3", sourceId], message: "Receipt must match Catalog 3 and cannot be newer than collection control" });
    }
  }
});
export type IngestionStateV16 = z.infer<typeof IngestionStateV16Schema>;
export type IngestionState = IngestionStateV16;

/** Deterministic, forward-only migration. V15 remains readable but is never written again. */
export function parseCatalogState(value: unknown): IngestionStateV16 {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 16) {
    return IngestionStateV16Schema.parse(value);
  }
  const legacy = parseCatalogStateV15(value);
  const revision = legacy.collection.revision + (legacy.collection.catalogVersion === 3 ? 0 : 1);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { publicationTransition: _discardedTransition, ...preserved } = legacy;
  return IngestionStateV16Schema.parse({
    ...preserved,
    schemaVersion: 16,
    collection: { catalogVersion: 3, revision: Math.max(1, revision) },
    collectionReceipts: { 3: legacy.collectionReceipts[3] },
    stateRevision: 0,
    ingestionFence: 0,
    ingestionLease: null,
  });
}
