import { catalogV2CountryCodes, catalogV3CountryCodes } from "./domain/contract-identities";
import { HazardTypeSchema, type HazardType, type ProviderId } from "./domain/schemas";

const addedCountries = new Set<string>(catalogV3CountryCodes.filter((code) => !(catalogV2CountryCodes as readonly string[]).includes(code)));
export const expandedProviderIds = ["usgs", "emsc", "slf-avalanche", "fcdo-travel-advice"] as const;
export type ExpandedProviderId = (typeof expandedProviderIds)[number];
type Destination = { id: string; countryCode: string };
export function isExpandedDestination(location: Destination) { return addedCountries.has(location.countryCode); }
export function expandedProviderApplies(providerId: string, location: Destination) {
  if (!isExpandedDestination(location)) return false;
  if (providerId === "usgs" || providerId === "emsc") return true;
  if (providerId === "slf-avalanche") return location.id === "li-malbun";
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
  if (expandedProviderApplies("slf-avalanche", location)) entries.avalanche = { status: "monitored", providerIds: ["slf-avalanche"] };
  return entries;
}
