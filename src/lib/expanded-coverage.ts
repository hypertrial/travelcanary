import { catalogV2CountryCodes, catalogV3CountryCodes } from "./domain/contract-identities";
import { HazardTypeSchema, type HazardType, type ProviderId } from "./domain/schemas";
import capabilitiesJson from "../../data/meteoalarm-capabilities.json";
import eeaStationCoverage from "../../data/eea-station-covered-locations.json";

const addedCountries = new Set<string>(catalogV3CountryCodes.filter((code) => !(catalogV2CountryCodes as readonly string[]).includes(code)));
const eeaStationCountryCodes = new Set<string>(eeaStationCoverage.fullCountryCodes);
const eeaStationLocationIds = new Set<string>(eeaStationCoverage.locationIds);
export const expandedProviderIds = ["usgs", "emsc", "slf-avalanche", "fcdo-travel-advice"] as const;
export type ExpandedProviderId = (typeof expandedProviderIds)[number];
type Destination = { id: string; countryCode: string };
export function isExpandedDestination(location: Destination) { return addedCountries.has(location.countryCode); }
export function expandedProviderApplies(providerId: string, location: Destination) {
  if (!isExpandedDestination(location)) return false;
  if (providerId === "usgs" || providerId === "emsc") return true;
  if (providerId === "slf-avalanche") return location.id === "li-malbun";
  if (providerId === "meteoalarm") return Boolean((capabilitiesJson.countries as Record<string, { supportedHazards?: HazardType[] }>)[location.countryCode]?.supportedHazards?.length);
  if (providerId === "eea-aqi") return eeaStationCountryCodes.has(location.countryCode) || eeaStationLocationIds.has(location.id);
  if (providerId === "national-civil-alerts") return location.countryCode === "NO"
    || location.countryCode === "GB" && ["gb-bath", "gb-birmingham", "gb-brighton", "gb-cambridge", "gb-exeter", "gb-lake-district-national-park", "gb-leeds", "gb-liverpool", "gb-london", "gb-manchester", "gb-newcastle-upon-tyne", "gb-oxford", "gb-plymouth", "gb-portsmouth", "gb-york"].includes(location.id);
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
  if (location.countryCode === "NO") {
    for (const hazard of ["severe-weather", "snow-ice", "fire-danger"] as const) entries[hazard] = { status: "monitored", providerIds: ["national-civil-alerts"] };
    if ((location as Destination & { isCoastal?: boolean }).isCoastal !== false) entries.coastal = { status: "monitored", providerIds: ["national-civil-alerts"] };
    entries.flood = { status: "partial", providerIds: ["national-civil-alerts"] };
  }
  if (location.countryCode === "GB" && expandedProviderApplies("national-civil-alerts", location)) {
    entries.flood = { status: "partial", providerIds: ["national-civil-alerts"] };
  }
  return entries;
}
