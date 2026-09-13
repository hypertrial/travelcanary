import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import catalog2Json from "../public/locations.json";
import catalog3Json from "../public/catalogs/3/locations.json";
import release2 from "../data/catalog-releases/2.json";
import { buildCatalog3Snapshot } from "../src/lib/catalog-projections";
import { createEmptyState } from "../src/lib/risk-state";
import { projectCatalog2Snapshot } from "../src/lib/risk-snapshot";
import type { IngestionStateV15 } from "../src/lib/domain/catalog-state";
import { PublicCatalogV2Schema, PublicCatalogV3Schema } from "../src/lib/domain/catalog-public";
import { coveragePairStates, measureCoverage } from "./coverage-measurement";

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
  deltaFromBaseline: { applicablePairs: current3.totals.applicable - baseline.applicablePairs,
    monitoredOrPartlyMonitoredPairs: monitoredOrPartial - baseline.monitoredOrPartlyMonitoredPairs },
  reclassifications: { eeaModeledFullToObservationPartial: current2.byHazard["air-quality"].partlyChecked,
    monitoredOrPartlyMonitoredLoss: Math.max(0, baseline.monitoredOrPartlyMonitoredPairs - monitoredOrPartial),
    explanation: "EEA AQI remains visible but is partial: only observation-backed culprit pollutants can create monitoring evidence; modeled or gap-filled values are context and never all-clear." },
  pairMembership: { regressedExistingPairs: regressedPairs, gainedPairs: [...checked3].filter((key) => !checked2Set.has(key)).length },
  addedDestinations: { count: added.length, earthquakeMonitored: pairs3.filter(({ locationId, hazard, status }) => (
    added.includes(locationId) && hazard === "earthquake" && status === "monitored"
  )).length, byHazard: addedByHazard },
  remainingGapsByHazard,
};
if (report.catalog2Projection.membershipSha256 !== baseline.membershipSha256 || report.pairMembership.regressedExistingPairs.length
  || report.catalog3Projection.applicablePairs !== 11_799 || report.addedDestinations.earthquakeMonitored !== 176
  || report.catalog3Projection.monitoredOrPartlyMonitoredPairs <= baseline.monitoredOrPartlyMonitoredPairs) {
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
