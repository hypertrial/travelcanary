import locationsJson from "../../data/locations.json";
import catalogMetadata from "../../data/catalog-metadata.json";
import coverageJson from "../../data/coverage.json";
import { CoverageMatrixSchema, LocationSchema, type CountryCode, type HazardType, type Location } from "./domain/schemas";

// Preserve the frozen catalog input while applying reviewed source-mapping corrections.
const regionOverrides = catalogMetadata.sourceRegionCodeOverrides as Record<string, { meteoalarm?: string[] }>;
export const locations: Location[] = LocationSchema.array().parse(locationsJson.map((location) => ({
  ...location,
  sourceRegionCodes: { ...location.sourceRegionCodes, meteoalarm: [...new Set([
    ...(regionOverrides[location.id]?.meteoalarm || []), ...location.sourceRegionCodes.meteoalarm,
  ])] },
})));
export const locationsById = new Map(locations.map((location) => [location.id, location]));

type CoverageStatus = "monitored" | "partial" | "not_monitored";
type CountryCoverage = { hazards: Record<HazardType, { status: CoverageStatus; providerIds: import("./domain/schemas").ProviderId[] }> };

const coverage = CoverageMatrixSchema.parse(coverageJson);
export const coverageByCountry = coverage.countries as Record<CountryCode, CountryCoverage>;
export const coverageByLocation = coverage.locationOverrides;
