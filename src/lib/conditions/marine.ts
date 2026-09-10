import mappingV3Json from "../../../data/marine-condition-mapping-v3.json";
import { catalogLocationsV3 } from "../catalog-data";
import { isExpandedDestination } from "../expanded-coverage";
import mappingJson from "../../../data/marine-condition-mapping.json";
import { z } from "zod";
import { locations } from "../data";
import { distanceKm } from "../geospatial";

function mappingSchema(catalog: ReadonlyArray<Pick<(typeof locations)[number], "id" | "isCoastal" | "centroid">>) {
  return z.object({ schemaVersion: z.literal(1), reviewedAt: z.string().date(), source: z.string().url(),
  documentation: z.string().url(), rule: z.string().min(20), mappings: z.array(z.object({
    locationId: z.string(), status: z.enum(["mapped", "unsupported"]), queryCoordinates: z.tuple([z.number(), z.number()]).optional(),
    distanceKm: z.number().nonnegative().max(500).nullable(), provenance: z.string().min(20),
  })).length(catalog.filter(({ isCoastal }) => isCoastal).length) }).superRefine((value, context) => {
  const coastal = new Set(catalog.filter(({ isCoastal }) => isCoastal).map(({ id }) => id));
  if (Date.now() - Date.parse(value.reviewedAt) > 90 * 86400000 || Date.parse(value.reviewedAt) > Date.now() + 86400000
    || new URL(value.source).hostname !== "marine-api.open-meteo.com" || new URL(value.documentation).hostname !== "open-meteo.com") context.addIssue({ code: "custom", message: "Marine review metadata is invalid or stale" });
  const ids = value.mappings.map(({ locationId }) => locationId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !coastal.has(id)) || coastal.size !== ids.length) context.addIssue({ code: "custom", message: "Marine mapping must cover every coastal destination exactly once" });
  for (const [index, item] of value.mappings.entries()) {
    const location = catalog.find(({ id }) => id === item.locationId)!;
    if (item.status === "mapped" && (!location || !item.queryCoordinates || item.distanceKm === null || item.distanceKm > 25
      || Math.abs(distanceKm(location.centroid, item.queryCoordinates) - item.distanceKm) > 0.2)) context.addIssue({ code: "custom", path: ["mappings", index], message: "Mapped marine destinations require a representative offshore coordinate and distance" });
    if (item.status === "unsupported" && item.queryCoordinates) context.addIssue({ code: "custom", path: ["mappings", index], message: "Unsupported marine destinations cannot have a query coordinate" });
  }
});

}

export const marineConditionMapping = mappingSchema(locations).parse(mappingJson);
export const marineMappings = marineConditionMapping.mappings.filter((item): item is typeof item & { status: "mapped"; queryCoordinates: [number, number] } => item.status === "mapped");
export const marineMappingByLocation = new Map(marineMappings.map((item) => [item.locationId, item]));
export const marineEligibleLocationIds = new Set(marineMappings.map(({ locationId }) => locationId));
export const expandedMarineConditionMapping = mappingSchema(catalogLocationsV3.filter(isExpandedDestination)).safeExtend({ catalogVersion: z.literal(3) }).parse(mappingV3Json);
const addedMappings = expandedMarineConditionMapping.mappings.filter((item): item is typeof item & { status: "mapped"; queryCoordinates: [number, number] } => item.status === "mapped");
export const catalog3MarineMappingByLocation = new Map([...marineMappings, ...addedMappings].map((item) => [item.locationId, item]));
export function marineConditionEligible(locationId: string, catalogVersion: 2 | 3 = 2) {
  return (catalogVersion === 3 ? catalog3MarineMappingByLocation : marineMappingByLocation).has(locationId);
}
