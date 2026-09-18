import { z } from "zod";
import { catalogV3CountryCodes } from "./contract-identities";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const objectPath = z.string().regex(/^catalogs\/3\/objects\/sha256\/[a-f0-9]{64}\.json$/);
const manifestPath = z.string().regex(/^catalogs\/3\/generations\/[a-f0-9]{64}\/manifest\.json$/);

export const PublicationObjectSchema = z.object({
  path: objectPath,
  sha256: sha256Schema,
  bytes: z.number().int().positive().max(2_000_000),
  generatedAt: timestamp,
});

export const PublicationStatusV1Schema = z.object({
  state: z.enum(["complete", "degraded"]),
  codes: z.array(z.string().regex(/^[a-z0-9_/-]+$/).max(100)).max(100),
  collectorLastSuccess: timestamp.nullable(),
}).strict();

export const PublicationManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.literal(3),
  generatedAt: timestamp,
  producerCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  collectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ingestionFence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  membershipHash: z.string().regex(/^[a-f0-9]{16}$/),
  coverageContractHash: sha256Schema,
  complete: z.literal(true),
  snapshot: PublicationObjectSchema,
  conditions: z.array(PublicationObjectSchema.extend({ countryCode: z.enum(catalogV3CountryCodes) })).length(catalogV3CountryCodes.length),
  status: PublicationStatusV1Schema,
}).strict().superRefine((value, context) => {
  const actual = value.conditions.map(({ countryCode }) => countryCode).sort();
  const expected = [...catalogV3CountryCodes].sort();
  if (new Set(actual).size !== expected.length || actual.join("\0") !== expected.join("\0")) {
    context.addIssue({ code: "custom", path: ["conditions"], message: "Manifest must contain each Catalog 3 country exactly once" });
  }
  if (value.conditions.some(({ generatedAt }) => Date.parse(generatedAt) > Date.parse(value.generatedAt))) {
    context.addIssue({ code: "custom", path: ["conditions"], message: "Object generation cannot be newer than its manifest" });
  }
});

export const PublicationPointerV1Schema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.literal(3),
  manifestPath,
  manifestSha256: sha256Schema,
  publishedAt: timestamp,
  producerCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  collectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ingestionFence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type PublicationObject = z.infer<typeof PublicationObjectSchema>;
export type PublicationManifestV1 = z.infer<typeof PublicationManifestV1Schema>;
export type PublicationPointerV1 = z.infer<typeof PublicationPointerV1Schema>;

export const publicationPointerPath = "catalogs/3/publication/latest.json";
export function publicationObjectPath(sha256: string) { return `catalogs/3/objects/sha256/${sha256Schema.parse(sha256)}.json`; }
export function publicationManifestPath(sha256: string) { return `catalogs/3/generations/${sha256Schema.parse(sha256)}/manifest.json`; }
