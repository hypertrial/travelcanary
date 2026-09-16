import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import catalog2Json from "../public/locations.json";
import catalog3Json from "../public/catalogs/3/locations.json";
import release2 from "../data/catalog-releases/2.json";
import { buildCatalog3Snapshot } from "../src/lib/catalog-projections";
import { createEmptyState } from "../src/lib/risk-state";
import { projectCatalog2Snapshot } from "../src/lib/risk-snapshot";
import type { IngestionStateV15 } from "../src/lib/domain/catalog-state";
import type { HazardType } from "../src/lib/domain/schemas";
import { PublicCatalogV2Schema, PublicCatalogV3Schema } from "../src/lib/domain/catalog-public";
import { coveragePairStates, measureCoverage } from "./coverage-measurement";
import { catalog3CoverageTarget, lifeSafetyHazards } from "../src/lib/coverage-measurement";
import { nationalWarningManifest } from "../src/lib/national-warning-sources";

const measuredAt = new Date("2026-09-13T00:00:00Z");
const catalog2 = PublicCatalogV2Schema.parse(catalog2Json);
const catalog3 = PublicCatalogV3Schema.parse(catalog3Json);
const added = catalog3.filter(({ id }) => !release2.locationIds.includes(id)).map(({ id }) => id);
const healthy = { status: "ok" as const, lastAttempt: measuredAt.toISOString(), lastSuccess: measuredAt.toISOString(), sourceUpdatedAt: measuredAt.toISOString(),
  nextExpectedUpdate: new Date(+measuredAt + 60 * 60_000).toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };

function receipt(state: IngestionStateV15, source: "usgs" | "slf-avalanche", checked: string[]) {
  state.expandedSourceHealth[source] = { health: { ...healthy }, checkedLocationIds: checked, unavailableLocationIds: [] };
}

function measurementState() {
  const state = createEmptyState(measuredAt); state.collection = { catalogVersion: 3, revision: 1 };
  for (const [id, value] of Object.entries(state.sources)) if (value.status !== "not_monitored") state.sources[id as keyof typeof state.sources] = { ...healthy };
  for (const [id, value] of Object.entries(state.providers)) if (value.status !== "not_monitored") state.providers[id as keyof typeof state.providers] = { ...healthy };
  for (const partitions of Object.values(state.sourcePartitions)) for (const value of Object.values(partitions)) if (value.status !== "not_monitored") Object.assign(value, healthy);
  for (const countries of Object.values(state.partitionTransports)) for (const transports of Object.values(countries)) {
    for (const value of Object.values(transports)) if (value.status !== "not_monitored") Object.assign(value, healthy);
  }
  receipt(state, "usgs", added); receipt(state, "slf-avalanche", ["li-malbun"]);
  return state;
}

const state = measurementState();
const current2 = measureCoverage(projectCatalog2Snapshot(state, measuredAt), catalog2, measuredAt);
const current3 = measureCoverage(buildCatalog3Snapshot(state, measuredAt), catalog3, measuredAt);
const pairs2 = coveragePairStates(projectCatalog2Snapshot(state, measuredAt), catalog2, measuredAt);
const pairs3 = coveragePairStates(buildCatalog3Snapshot(state, measuredAt), catalog3, measuredAt);
const metOffice = nationalWarningManifest.countries.GB.systems.find(({ id }) => id === "met-office-nswws");
if (!metOffice) throw new Error("Met Office manifest record is missing");
const metOfficeHazards = new Set(metOffice.hazards);
const metOfficePolicyPairs = pairs3.filter(({ countryCode, hazard }) => countryCode === "GB" && metOfficeHazards.has(hazard));
const checked2 = pairs2.filter(({ status }) => status !== "unavailable").map(({ key }) => key);
const checked2Set = new Set(checked2);
const checked3 = new Set(pairs3.filter(({ status }) => status !== "unavailable").map(({ key }) => key));
const catalog2MembershipSha256 = createHash("sha256").update(checked2.join("\n")).digest("hex");
const regressedPairs = checked2.filter((key) => !checked3.has(key));
const addedByHazard = Object.fromEntries(Object.entries(current3.byHazard).map(([hazard, counts]) => {
  const before = current2.byHazard[hazard] || { applicable: 0, fullyChecked: 0, partlyChecked: 0, notChecked: 0 };
  return [hazard, { applicable: counts.applicable - before.applicable, monitored: counts.fullyChecked - before.fullyChecked,
    partlyMonitored: counts.partlyChecked - before.partlyChecked, unavailable: counts.notChecked - before.notChecked }];
}).filter(([, counts]) => Object.values(counts).some((count) => count !== 0)));
const remainingGapsByHazard = Object.fromEntries(Object.entries(current3.byHazard).filter(([, counts]) => counts.notChecked > 0)
  .map(([hazard, counts]) => [hazard, counts.notChecked]));
const unavailablePairs = pairs3.filter(({ status }) => status === "unavailable");
const unavailableByCountryHazard = new Map<string, typeof unavailablePairs>();
for (const pair of unavailablePairs) {
  const key = `${pair.countryCode}|${pair.hazard}`;
  unavailableByCountryHazard.set(key, [...(unavailableByCountryHazard.get(key) || []), pair]);
}
const gapGroups = [...unavailableByCountryHazard.values()].map((pairs) => {
  const pair = pairs[0];
  const systems = nationalWarningManifest.countries[pair.countryCode as keyof typeof nationalWarningManifest.countries].systems
    .filter((system) => system.status !== "active" && system.hazards.includes(pair.hazard));
  const readiness = systems.some(({ status }) => status === "credential_gated") ? "credentialReady" as const
    : systems.some(({ status }) => status === "evidence_gated") ? "evidencePending" as const
      : "blockedNoSupportedFeed" as const;
  return {
    countryCode: pair.countryCode, hazard: pair.hazard, uncoveredPairs: pairs.length,
    uncoveredLifeSafetyPairs: lifeSafetyHazards.has(pair.hazard) ? pairs.length : 0,
    totalUncoveredPairs: pairs.length,
    readiness,
    candidateSystemIds: systems.length ? systems.map(({ id }) => id).sort() : ["no_reviewed_candidate"],
    candidates: systems.map((system) => ({ id: system.id, officialUrl: system.officialUrl, blocker: system.blocker,
      reReviewTrigger: system.reReviewTrigger, nextReviewAt: system.nextReviewAt })).sort((left, right) => left.id.localeCompare(right.id)),
  };
});
const ranked = (groups: typeof gapGroups) => groups.sort((left, right) => right.uncoveredLifeSafetyPairs - left.uncoveredLifeSafetyPairs
  || right.totalUncoveredPairs - left.totalUncoveredPairs || left.countryCode.localeCompare(right.countryCode)
  || left.hazard.localeCompare(right.hazard));
const specialistHazards = new Set(["avalanche", "volcano"]);
const priorityGroups = gapGroups.filter(({ hazard }) => !specialistHazards.has(hazard));
const priorityProgram = {
  definition: "One row per country/hazard capability gap; forecasts, advice, satellite detections, modeled conditions, and fallback-only transports do not create warning coverage.",
  readinessBands: {
    credentialReady: ranked(priorityGroups.filter(({ readiness }) => readiness === "credentialReady")),
    evidencePending: ranked(priorityGroups.filter(({ readiness }) => readiness === "evidencePending")),
    blockedNoSupportedFeed: ranked(priorityGroups.filter(({ readiness }) => readiness === "blockedNoSupportedFeed")),
  },
  specialist: ranked(gapGroups.filter(({ hazard }) => specialistHazards.has(hazard))),
};
const baseline = { applicablePairs: 8_392, monitoredOrPartlyMonitoredPairs: 5_321,
  membershipSha256: "c2da0bc3d26e013d78596dbe429a64255fe58d7c380761f5f3ce9831df21f4c6" };
const monitoredOrPartial = current3.totals.fullyChecked + current3.totals.partlyChecked;
const report = {
  schemaVersion: 1, reviewedAt: "2026-09-13",
  definition: "Deterministic capability coverage, not incident recall or upstream uptime. Modeled, satellite, advice, and discovery/context providers cannot satisfy monitoring.",
  baseline: { catalogVersion: 2, locations: 503, countries: 28, ...baseline },
  catalog2Projection: { applicablePairs: current2.totals.applicable, monitored: current2.totals.fullyChecked,
    partlyMonitored: current2.totals.partlyChecked, unavailable: current2.totals.notChecked,
    monitoredOrPartlyMonitoredPairs: current2.totals.fullyChecked + current2.totals.partlyChecked,
    membershipSha256: catalog2MembershipSha256 },
  catalog3Projection: { catalogVersion: 3, locations: 679, countries: 45, applicablePairs: current3.totals.applicable,
    monitored: current3.totals.fullyChecked, partlyMonitored: current3.totals.partlyChecked, unavailable: current3.totals.notChecked,
    monitoredOrPartlyMonitoredPairs: monitoredOrPartial },
  tiers: { lifeSafety: { applicablePairs: current3.tiers.lifeSafety.applicable, monitored: current3.tiers.lifeSafety.fullyChecked,
    partlyMonitored: current3.tiers.lifeSafety.partlyChecked, unavailable: current3.tiers.lifeSafety.notChecked,
    monitoredOrPartlyMonitoredPairs: current3.tiers.lifeSafety.fullyChecked + current3.tiers.lifeSafety.partlyChecked,
    remainingGapsByHazard: Object.fromEntries(Object.entries(current3.byHazard).filter(([hazard, counts]) => (
      lifeSafetyHazards.has(hazard as HazardType) && counts.notChecked > 0
    )).map(([hazard, counts]) => [hazard, counts.notChecked])) } },
  deltaFromBaseline: { applicablePairs: current3.totals.applicable - baseline.applicablePairs,
    monitoredOrPartlyMonitoredPairs: monitoredOrPartial - baseline.monitoredOrPartlyMonitoredPairs },
  reclassifications: { eeaModeledFullToObservationPartial: current2.byHazard["air-quality"].partlyChecked,
    monitoredOrPartlyMonitoredLoss: Math.max(0, baseline.monitoredOrPartlyMonitoredPairs - monitoredOrPartial),
    explanation: "EEA AQI remains visible but is partial: only observation-backed culprit pollutants can create monitoring evidence; modeled or gap-filled values are context and never all-clear." },
  pairMembership: { regressedExistingPairs: regressedPairs, gainedPairs: [...checked3].filter((key) => !checked2Set.has(key)).length },
  policyReclassification: {
    systemId: metOffice.id,
    formerlyFullyChecked: metOfficePolicyPairs.length,
    nowFullyChecked: metOfficePolicyPairs.filter(({ status }) => status === "monitored").length,
    nowPartlyChecked: metOfficePolicyPairs.filter(({ status }) => status === "partial").length,
    nowUnavailable: metOfficePolicyPairs.filter(({ status }) => status === "unavailable").length,
    explanation: "Met Office is optional and non-contributing; Environment Agency preserves partial flood coverage for its 15 reviewed England destinations.",
  },
  addedDestinations: { count: added.length, earthquakeMonitored: pairs3.filter(({ locationId, hazard, status }) => (
    added.includes(locationId) && hazard === "earthquake" && status === "monitored"
  )).length, byHazard: addedByHazard },
  remainingGapsByHazard,
  priorityProgram,
};
if (report.catalog2Projection.membershipSha256 !== baseline.membershipSha256 || report.pairMembership.regressedExistingPairs.length
  || report.catalog3Projection.applicablePairs !== 11_799 || report.addedDestinations.earthquakeMonitored !== 176
  || report.catalog3Projection.monitored !== catalog3CoverageTarget.allHazards.fullyChecked
  || report.catalog3Projection.partlyMonitored !== catalog3CoverageTarget.allHazards.partlyChecked
  || report.catalog3Projection.unavailable !== catalog3CoverageTarget.allHazards.notChecked
  || report.catalog3Projection.monitoredOrPartlyMonitoredPairs !== catalog3CoverageTarget.allHazards.coveredOrPartial
  || report.tiers.lifeSafety.applicablePairs !== catalog3CoverageTarget.lifeSafety.applicable
  || report.tiers.lifeSafety.monitored !== catalog3CoverageTarget.lifeSafety.fullyChecked
  || report.tiers.lifeSafety.partlyMonitored !== catalog3CoverageTarget.lifeSafety.partlyChecked
  || report.tiers.lifeSafety.unavailable !== catalog3CoverageTarget.lifeSafety.notChecked
  || report.tiers.lifeSafety.monitoredOrPartlyMonitoredPairs !== catalog3CoverageTarget.lifeSafety.coveredOrPartial
  || report.policyReclassification.formerlyFullyChecked !== 167
  || report.policyReclassification.nowFullyChecked !== 0
  || report.policyReclassification.nowPartlyChecked !== 15
  || report.policyReclassification.nowUnavailable !== 152) {
  throw new Error("Catalog 3 coverage acceptance failed");
}
const path = new URL("../data/coverage-history/catalog3-upgrade.json", import.meta.url);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== serialized) throw new Error("Catalog 3 coverage report is stale; run npm run coverage:upgrade-report");
} else {
  await mkdir(new URL("../data/coverage-history/", import.meta.url), { recursive: true });
  await writeFile(path, serialized);
}
