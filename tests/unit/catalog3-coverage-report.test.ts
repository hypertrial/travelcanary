import { describe, expect, it } from "vitest";
import report from "../../data/coverage-history/catalog3-upgrade.json";
import manifest from "../../data/national-warning-sources.json";

describe("catalog 3 coverage release report", () => {
  it("pins the all-hazard and life-safety release targets without prior-pair regressions", () => {
    expect(report.catalog3Projection).toMatchObject({ applicablePairs: 11_799, monitored: 3_034,
      partlyMonitored: 2_862, unavailable: 5_903, monitoredOrPartlyMonitoredPairs: 5_896 });
    expect(report.tiers.lifeSafety).toMatchObject({ applicablePairs: 7_237, monitored: 3_020,
      partlyMonitored: 2_211, unavailable: 2_006, monitoredOrPartlyMonitoredPairs: 5_231 });
    expect(report.pairMembership.regressedExistingPairs).toEqual([]);
  });

  it("lists every remaining country/hazard gap exactly once in deterministic readiness order", () => {
    const bands = report.priorityProgram.readinessBands;
    const groups = [...bands.credentialReady, ...bands.evidencePending, ...bands.blockedNoSupportedFeed,
      ...report.priorityProgram.specialist];
    expect(new Set(groups.map(({ countryCode, hazard }) => `${countryCode}|${hazard}`)).size).toBe(groups.length);
    expect(groups.reduce((sum, { uncoveredPairs }) => sum + uncoveredPairs, 0)).toBe(report.catalog3Projection.unavailable);
    for (const entries of Object.values(bands)) for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]; const current = entries[index];
      expect(previous.uncoveredLifeSafetyPairs > current.uncoveredLifeSafetyPairs
        || previous.uncoveredLifeSafetyPairs === current.uncoveredLifeSafetyPairs && previous.totalUncoveredPairs >= current.totalUncoveredPairs).toBe(true);
    }
  });

  it("sources candidate blockers and review dates from the reviewed manifest", () => {
    type Candidate = { id: string; blocker: string | null; reReviewTrigger: string | null; nextReviewAt: string };
    const countries = manifest.countries as unknown as Record<string, { systems: Candidate[] }>;
    const systems = new Map(Object.values(countries).flatMap(({ systems }) => systems).map((system) => [system.id, system]));
    const groups = [...Object.values(report.priorityProgram.readinessBands).flat(), ...report.priorityProgram.specialist];
    expect(groups.some(({ candidateSystemIds }) => candidateSystemIds.includes("no_reviewed_candidate"))).toBe(true);
    for (const group of groups) for (const candidate of group.candidates) {
      expect(candidate).toMatchObject({ blocker: systems.get(candidate.id)!.blocker,
        reReviewTrigger: systems.get(candidate.id)!.reReviewTrigger, nextReviewAt: systems.get(candidate.id)!.nextReviewAt });
    }
    expect(new Set(report.priorityProgram.specialist.map(({ hazard }) => hazard))).toEqual(new Set(["avalanche", "volcano"]));
  });
});
