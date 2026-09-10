import locationsJson from "../../data/locations.json";
import coverageJson from "../../data/coverage.json";
import { CoverageMatrixSchema, LocationSchema, type CountryCode, type HazardType, type Location } from "./domain/schemas";

export const locations: Location[] = LocationSchema.array().parse(locationsJson);
export const locationsById = new Map(locations.map((location) => [location.id, location]));

type CoverageStatus = "monitored" | "partial" | "not_monitored";
type CountryCoverage = { hazards: Record<HazardType, { status: CoverageStatus; providerIds: import("./domain/schemas").ProviderId[] }> };

const coverage = CoverageMatrixSchema.parse(coverageJson);
export const coverageByCountry = coverage.countries as Record<CountryCode, CountryCoverage>;
export const coverageByLocation = coverage.locationOverrides;
