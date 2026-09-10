import { z } from "zod";
import additions from "../../data/review-inputs/europe-expansion-catalog.json";
import { locations } from "./data";
import { LocationSchema } from "./domain/schemas";
import { catalogV3CountryCodes } from "./domain/contract-identities";
import { PublicCatalogV3LocationSchema, PublicCatalogV3Schema } from "./domain/catalog-public";

// Inactive reviewed inputs. Runtime collectors continue to use catalog 2 until
// each source's eligibility and mapping gates have passed.
export const CatalogLocationV3Schema = LocationSchema.extend({
  countryCode: z.enum(catalogV3CountryCodes),
  coverageRef: z.enum(catalogV3CountryCodes),
  sourceRegionCodes: LocationSchema.shape.sourceRegionCodes.extend({ meteoalarm: z.array(z.string().min(2)) }),
  scope: PublicCatalogV3LocationSchema.shape.scope,
  scopeNote: PublicCatalogV3LocationSchema.shape.scopeNote,
});
export type CatalogLocation = z.infer<typeof CatalogLocationV3Schema>;
export const catalogLocationsV3 = CatalogLocationV3Schema.array().parse([...locations, ...additions.locations]);
// Validate exact membership and geographic scope without discarding private
// mapping fields from the records used by future approved collectors.
PublicCatalogV3Schema.parse(catalogLocationsV3);
