import type { z } from "zod";
import { expandedHazardCoverage } from "./expanded-coverage";
import { HazardTypeSchema } from "./domain/schemas";
import { providerRegistry } from "./provider-registry";
import type { CatalogSnapshot, ExpandedPublicCoverageSchema } from "./domain/catalog-public";

export type ExpandedPublicCoverage = z.infer<typeof ExpandedPublicCoverageSchema>;
export function expandedCheckIsCurrent(receipt: ExpandedPublicCoverage | undefined, locationId: string, cadenceMinutes: number | null, now: Date) {
  return Boolean(receipt && receipt.status !== "disabled" && receipt.status !== "failed"
    && receipt.checkedLocationIds.includes(locationId) && !receipt.unavailableLocationIds.includes(locationId)
    && Date.parse(receipt.checkedAt) <= now.getTime() && cadenceMinutes
    && now.getTime() <= Date.parse(receipt.checkedAt) + 2 * cadenceMinutes * 60_000);
}

export function expandedDelayedHazards(location: { id: string; countryCode: string }, providers: CatalogSnapshot["providers"], now: Date) {
  const coverage = expandedHazardCoverage(location);
  return HazardTypeSchema.options.filter((hazard) => coverage[hazard].status !== "not_monitored"
    && !coverage[hazard].providerIds.some((providerId) => {
      if (providerRegistry[providerId].satisfiesCoverage === false) return false;
      const provider = providers[providerId];
      return expandedCheckIsCurrent("expandedCoverage" in provider ? provider.expandedCoverage : undefined,
        location.id, providerRegistry[providerId].cadenceMinutes, now);
    }));
}
