import { z } from "zod";
import artifactJson from "../../data/hazard-applicability.json";

const HttpUrlSchema = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
export const HazardApplicabilitySchema = z.object({
  schemaVersion: z.literal(1),
  reviewedAt: z.string().date(),
  source: z.object({
    publisher: z.string().min(3),
    dataset: z.string().min(3),
    version: z.string().min(1),
    citationUrl: HttpUrlSchema,
    wfsUrl: HttpUrlSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  rule: z.object({ maximumDistanceKm: z.literal(200), aviationAshExcluded: z.literal(true) }).strict(),
  overrides: z.array(z.object({
    locationId: z.string().min(1),
    reason: z.string().min(10),
    evidenceUrl: HttpUrlSchema,
  }).strict()),
  locations: z.array(z.object({
    locationId: z.string().min(1),
    minimumDistanceKm: z.number().min(0).max(200),
    volcanoes: z.array(z.object({
      volcanoId: z.string().regex(/^\d{6}$/),
      name: z.string().min(1),
      distanceKm: z.number().min(0).max(200),
    }).strict()).min(1),
  }).strict()),
}).strict();

export const hazardApplicability = HazardApplicabilitySchema.parse(artifactJson);
const volcanicLocationIds = new Set([
  ...hazardApplicability.locations.map(({ locationId }) => locationId),
  ...hazardApplicability.overrides.map(({ locationId }) => locationId),
]);

export function volcanoAppliesToLocation(locationId: string) {
  return volcanicLocationIds.has(locationId);
}
