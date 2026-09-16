import { catalogV2CountryCodes, catalogV3CountryCodes } from "./domain/contract-identities";
import { HazardTypeSchema, type HazardType, type ProviderId } from "./domain/schemas";
import capabilitiesJson from "../../data/meteoalarm-capabilities.json";
import eeaStationCoverage from "../../data/eea-station-covered-locations.json";
import expandedNationalWarningCoverageJson from "../../data/expanded-national-warning-coverage.json";

const addedCountries = new Set<string>(catalogV3CountryCodes.filter((code) => !(catalogV2CountryCodes as readonly string[]).includes(code)));
const eeaStationCountryCodes = new Set<string>(eeaStationCoverage.fullCountryCodes);
const eeaStationLocationIds = new Set<string>(eeaStationCoverage.locationIds);
export const expandedProviderIds = ["usgs", "emsc", "slf-avalanche", "fcdo-travel-advice"] as const;
export type ExpandedProviderId = (typeof expandedProviderIds)[number];
type Destination = { id: string; countryCode: string; isCoastal?: boolean };
type CoverageSystem = { hazards: HazardType[]; coverageContribution: "partial" | "complete"; coverageLocationIds?: string[] };
const expandedNationalWarningCoverage = expandedNationalWarningCoverageJson as unknown as {
  schemaVersion: 1; countries: Record<string, CoverageSystem[]>;
};
function nationalCoverageSystems(location: Destination) {
  return expandedNationalWarningCoverage.countries[location.countryCode]?.filter((system) => (
    !system.coverageLocationIds || system.coverageLocationIds.includes(location.id)
  )) || [];
}
export function isExpandedDestination(location: Destination) { return addedCountries.has(location.countryCode); }
export function expandedProviderApplies(providerId: string, location: Destination) {
  if (!isExpandedDestination(location)) return false;
  if (providerId === "usgs" || providerId === "emsc") return true;
  if (providerId === "slf-avalanche") return location.id === "li-malbun";
  if (providerId === "meteoalarm") return Boolean((capabilitiesJson.countries as Record<string, { supportedHazards?: HazardType[] }>)[location.countryCode]?.supportedHazards?.length);
  if (providerId === "eea-aqi") return eeaStationCountryCodes.has(location.countryCode) || eeaStationLocationIds.has(location.id);
  if (providerId === "national-civil-alerts") return nationalCoverageSystems(location).length > 0;
  if (["cems-rapid-mapping", "gdacs", "gfm", "effis-active-fire", "eonet", "edo-drought"].includes(providerId)) return true;
  return providerId === "fcdo-travel-advice" && location.countryCode !== "GB" && location.countryCode !== "VA";
}

// Capability is reviewed eligibility, independent of today's feed health. Every
// other assessed hazard remains an explicit gap; forecast/advice context does
// not establish monitoring. Existing catalog-2 coverage is kept separately.
export function expandedHazardCoverage(location: Destination) {
  const entries = Object.fromEntries(HazardTypeSchema.options.map((hazard) => [hazard, {
    status: "not_monitored", providerIds: [] as ProviderId[],
  }])) as Record<HazardType, { status: "not_monitored" | "partial" | "monitored"; providerIds: ProviderId[] }>;
  if (!isExpandedDestination(location)) return entries;
  entries.earthquake = { status: "monitored", providerIds: ["usgs", "emsc"] };
  if (expandedProviderApplies("eea-aqi", location)) entries["air-quality"] = { status: "partial", providerIds: ["eea-aqi"] };
  if (expandedProviderApplies("slf-avalanche", location)) entries.avalanche = { status: "monitored", providerIds: ["slf-avalanche"] };
  const meteo = (capabilitiesJson.countries as Record<string, { supportedHazards?: HazardType[] }>)[location.countryCode];
  for (const hazard of meteo?.supportedHazards || []) entries[hazard] = { status: "partial", providerIds: ["meteoalarm"] };
  for (const system of nationalCoverageSystems(location)) for (const hazard of system.hazards) {
    if (hazard === "coastal" && location.isCoastal === false) continue;
    const status = system.coverageContribution === "complete" ? "monitored" : "partial";
    if (entries[hazard].status !== "monitored") entries[hazard] = { status, providerIds: ["national-civil-alerts"] };
  }
  return entries;
}
