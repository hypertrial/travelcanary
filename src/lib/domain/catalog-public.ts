import { z } from "zod";
import { expandedProviderApplies, expandedProviderIds } from "../expanded-coverage";
import membershipJson from "../../../data/catalog-membership.json";
import { catalogMembershipHash } from "../catalog-membership";
import { catalogV2CountryCodes, catalogV3CountryCodes, snapshotV10ProviderIds } from "./contract-identities";
import { LocationStateV10Schema, PublicLocationSchema, PublicProviderV10StateSchema, SnapshotV10Schema, parseSnapshot, type LocationState } from "./schemas";
import { ConditionsV2Schema } from "./conditions";

// V11 retains V10 provider identities; new identities require a new wire version.
export const SnapshotV11ProviderIdSchema = z.enum([...snapshotV10ProviderIds]);
const country = z.enum(catalogV3CountryCodes);
const partition = PublicProviderV10StateSchema.shape.partitions.unwrap().valueType;
export const ExpandedPublicCoverageSchema = z.object({
  status: z.enum(["ok", "partial", "failed", "delayed", "disabled"]),
  checkedAt: z.string().datetime({ offset: true }),
  checkedLocationIds: z.array(z.string()).max(176),
  unavailableLocationIds: z.array(z.string()).max(176),
}).strict();
const provider = PublicProviderV10StateSchema.extend({
  partitions: z.record(country, partition).optional(),
  expandedCoverage: ExpandedPublicCoverageSchema.optional(),
});
const membership = membershipJson.releases;
const partitioned = new Set(["meteoalarm", "eea-aqi", "national-civil-alerts"]);

function exactIds(actual: string[], expected: Set<string>) {
  return actual.length === expected.size && new Set(actual).size === actual.length && actual.every((id) => expected.has(id));
}
function exactMembership(actual: string[], expected: { count: number; hash: string }) {
  return actual.length === expected.count && new Set(actual).size === actual.length && catalogMembershipHash(actual) === expected.hash;
}

// Pending distinguishes destinations not yet collected after catalog activation.
const pending = { updatePending: z.literal(true).optional() };
export const LocationStateV11Schema = z.union([
  LocationStateV10Schema.options[0].safeExtend(pending),
  LocationStateV10Schema.options[1].safeExtend(pending),
  LocationStateV10Schema.options[2].safeExtend(pending),
]).superRefine((value, context) => {
  if (value.updatePending && (value.level !== "UNKNOWN" || value.coverage !== "partial" || value.hazards.length || value.delayedHazards.length)) {
    context.addIssue({ code: "custom", message: "Pending monitoring requires UNKNOWN, partial coverage, and no incident or delayed-hazard evidence" });
  }
});

export const SnapshotV11Schema = z.object({
  ...SnapshotV10Schema.shape,
  schemaVersion: z.literal(11), catalogVersion: z.literal(3),
  locations: z.record(z.string(), LocationStateV11Schema),
  providers: z.record(SnapshotV11ProviderIdSchema, provider),
}).superRefine((value, context) => {
  if (!exactMembership(Object.keys(value.locations), membership[3])) context.addIssue({ code: "custom", path: ["locations"], message: "Snapshot must contain exact catalog 3 membership" });
  for (const [id, health] of Object.entries(value.providers)) {
    if (health.expandedCoverage) {
      const receipt = health.expandedCoverage;
      const expected = new Set(Object.keys(value.locations).filter((locationId) => expandedProviderApplies(id, { id: locationId, countryCode: locationId.slice(0, 2).toUpperCase() })));
      const all = [...receipt.checkedLocationIds, ...receipt.unavailableLocationIds];
      if (!(expandedProviderIds as readonly string[]).includes(id) || !exactIds(all, expected)
        || (receipt.status === "ok" && receipt.unavailableLocationIds.length)
        || (["failed", "disabled"].includes(receipt.status) && receipt.checkedLocationIds.length)
        || Date.parse(receipt.checkedAt) > Date.parse(value.generatedAt)) {
        context.addIssue({ code: "custom", path: ["providers", id, "expandedCoverage"], message: "Expanded public coverage must classify the exact reviewed provider scope at a valid check time" });
      }
    }
    if (partitioned.has(id) !== Boolean(health.partitions)) context.addIssue({ code: "custom", path: ["providers", id, "partitions"], message: "Provider country partitions do not match its contract" });
  }
});

export const ConditionsV3Schema = z.object({
  ...ConditionsV2Schema.shape,
  schemaVersion: z.literal(3), catalogVersion: z.literal(3), countryCode: country,
}).superRefine((value, context) => {
  // Reuse the complete frozen record/refinement contract, without changing its
  // original wire identity or claiming that this payload is a V2 publication.
  const validated = ConditionsV2Schema.safeParse({ ...value, schemaVersion: 2, catalogVersion: 2 });
  if (!validated.success) for (const issue of validated.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  if (!exactMembership(Object.keys(value.locations), membership[3].countries[value.countryCode])) {
    context.addIssue({ code: "custom", path: ["locations"], message: "Conditions must contain exact country catalog 3 membership" });
  }
});

export const PublicCatalogV3LocationSchema = PublicLocationSchema.extend({
  countryCode: country,
  scope: z.literal("local-area").optional(),
  scopeNote: z.string().min(1).max(300).optional(),
});
export const PublicCatalogV3Schema = PublicCatalogV3LocationSchema.array().superRefine((value, context) => {
  if (!exactMembership(value.map(({ id }) => id), membership[3])) context.addIssue({ code: "custom", message: "Catalog must contain exact release 3 membership" });
  for (const [index, location] of value.entries()) {
    if (!location.id.startsWith(`${location.countryCode.toLowerCase()}-`)) context.addIssue({ code: "custom", path: [index, "countryCode"], message: "Catalog destination country mismatch" });
    if (!(catalogV2CountryCodes as readonly string[]).includes(location.countryCode) && ["island", "park", "mountain"].includes(location.type) && location.scope !== "local-area") context.addIssue({ code: "custom", path: [index, "scope"], message: "New regional destinations require reviewed local-area scope" });
    if (Boolean(location.scope) !== Boolean(location.scopeNote)) context.addIssue({ code: "custom", path: [index, "scope"], message: "Local scope requires its description" });
  }
});
export const PublicCatalogV2Schema = PublicLocationSchema.array().superRefine((value, context) => {
  if (!exactMembership(value.map(({ id }) => id), membership[2])) context.addIssue({ code: "custom", message: "Catalog must contain exact release 2 membership" });
});
export type PublicCatalogLocation = z.infer<typeof PublicCatalogV3LocationSchema>;
export type CatalogSnapshot = z.infer<typeof SnapshotV10Schema> | z.infer<typeof SnapshotV11Schema>;

export function parseCatalogSnapshot(value: unknown): CatalogSnapshot {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 11) return SnapshotV11Schema.parse(value);
  const legacy = parseSnapshot(value);
  if (!exactMembership(Object.keys(legacy.locations), membership[2])) throw new Error("Snapshot must contain exact catalog 2 membership");
  return legacy;
}

export function catalogLocationState(snapshot: CatalogSnapshot | null, locationId: string): { state: LocationState; updatePending: boolean } {
  const existing = snapshot?.locations[locationId];
  return existing ? { state: existing, updatePending: "updatePending" in existing && existing.updatePending === true } : {
    state: { level: "UNKNOWN", coverage: "partial", coverageGaps: [], delayedHazards: [], hazards: [] }, updatePending: true,
  };
}
