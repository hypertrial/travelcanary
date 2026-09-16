import { locationCoveragePresentation } from "./coverage-presentation";
import { isExpandedDestination } from "./expanded-coverage";
import type { CatalogSnapshot, PublicCatalogLocation } from "./domain/catalog-public";
import type { HazardType } from "./domain/schemas";
import { hazardAppliesToLocation } from "./risk-policy";

export const lifeSafetyHazards = new Set<HazardType>([
  "severe-weather", "extreme-heat", "extreme-cold", "snow-ice", "flood", "coastal",
  "wildfire", "fire-danger", "earthquake", "industrial", "nuclear", "civil-emergency",
]);

export const catalog3CoverageTarget = {
  allHazards: { applicable: 11_799, fullyChecked: 2_867, partlyChecked: 2_877, notChecked: 6_055, coveredOrPartial: 5_744 },
  lifeSafety: { applicable: 7_237, fullyChecked: 2_853, partlyChecked: 2_226, notChecked: 2_158, coveredOrPartial: 5_079 },
} as const;

export function emptyCoverageCounts() {
  return { applicable: 0, fullyChecked: 0, partlyChecked: 0, notChecked: 0, freshFullyChecked: 0, freshPartlyChecked: 0, delayed: 0 };
}

export function coveragePairStates(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid measurement time");
  const ids = catalog.map(({ id }) => id).sort();
  if (new Set(ids).size !== ids.length || ids.join(",") !== Object.keys(snapshot.locations).sort().join(",")) {
    throw new Error("Coverage measurement catalog mismatch");
  }
  const snapshotFresh = now.getTime() - Date.parse(snapshot.generatedAt) <= 30 * 60_000
    && Date.parse(snapshot.generatedAt) <= now.getTime() + 5 * 60_000;
  return catalog.flatMap((location) => {
    const presentation = locationCoveragePresentation({ location, state: snapshot.locations[location.id], snapshot, now });
    return presentation.categories.flatMap(({ subchecks }) => subchecks).flatMap((check) => {
      if (!isExpandedDestination(location) && !hazardAppliesToLocation(check.hazard, location)) return [];
      const status = check.coverageStatus === "available" ? "monitored" as const
        : check.coverageStatus === "limited" ? "partial" as const : "unavailable" as const;
      return [{ key: `${location.id}|${check.hazard}`, locationId: location.id, countryCode: location.countryCode,
        hazard: check.hazard, status, delayed: status !== "unavailable" && (!snapshotFresh || check.freshnessStatus === "delayed") }];
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function coverageBreakdown(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  const totals = emptyCoverageCounts();
  const byCountry: Record<string, ReturnType<typeof emptyCoverageCounts>> = {};
  const byHazard: Record<string, ReturnType<typeof emptyCoverageCounts>> = {};
  const lifeSafety = emptyCoverageCounts();
  for (const pair of coveragePairStates(snapshot, catalog, now)) {
    const groups = [totals, byCountry[pair.countryCode] ||= emptyCoverageCounts(), byHazard[pair.hazard] ||= emptyCoverageCounts()];
    if (lifeSafetyHazards.has(pair.hazard)) groups.push(lifeSafety);
    for (const counts of groups) {
      counts.applicable += 1;
      const key = pair.status === "monitored" ? "fullyChecked" : pair.status === "partial" ? "partlyChecked" : "notChecked";
      counts[key] += 1;
      if (key === "notChecked") continue;
      if (pair.delayed) counts.delayed += 1;
      else counts[key === "fullyChecked" ? "freshFullyChecked" : "freshPartlyChecked"] += 1;
    }
  }
  return { totals, byCountry, byHazard, tiers: { lifeSafety } };
}

export function coverageMeetsCatalog3Target(measurement: ReturnType<typeof coverageBreakdown>) {
  const covered = measurement.totals.fullyChecked + measurement.totals.partlyChecked;
  const lifeSafetyCovered = measurement.tiers.lifeSafety.fullyChecked + measurement.tiers.lifeSafety.partlyChecked;
  return measurement.totals.applicable === catalog3CoverageTarget.allHazards.applicable
    && measurement.totals.fullyChecked >= catalog3CoverageTarget.allHazards.fullyChecked
    && covered >= catalog3CoverageTarget.allHazards.coveredOrPartial
    && measurement.tiers.lifeSafety.applicable === catalog3CoverageTarget.lifeSafety.applicable
    && measurement.tiers.lifeSafety.fullyChecked >= catalog3CoverageTarget.lifeSafety.fullyChecked
    && lifeSafetyCovered >= catalog3CoverageTarget.lifeSafety.coveredOrPartial;
}
