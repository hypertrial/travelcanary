import { expandedHazardCoverage, isExpandedDestination } from "../src/lib/expanded-coverage";
import { createHash } from "node:crypto";
import { z } from "zod";
import coverage from "../data/coverage.json";
import applicability from "../data/hazard-applicability.json";
import national from "../data/national-warning-sources.json";
import { providerRegistry } from "../src/lib/provider-registry";
import { hazardAppliesToLocation } from "../src/lib/risk-policy";
import { locationCoveragePresentation } from "../src/lib/coverage-presentation";
import { type CatalogSnapshot, type PublicCatalogLocation } from "../src/lib/domain/catalog-public";
import { HazardTypeSchema, type Snapshot } from "../src/lib/domain/schemas";

// Bump when coverage-presentation/risk-policy measurement semantics change.
const measurementPolicyRevision = 2;
const counts = () => ({ applicable: 0, fullyChecked: 0, partlyChecked: 0, notChecked: 0, freshFullyChecked: 0, freshPartlyChecked: 0, delayed: 0 });
export function measureCoverage(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid measurement time");
  const ids = catalog.map(({ id }) => id).sort();
  if (new Set(ids).size !== ids.length || ids.join(",") !== Object.keys(snapshot.locations).sort().join(",")) throw new Error("Coverage measurement catalog mismatch");
  const totals = counts();
  const byCountry: Record<string, ReturnType<typeof counts>> = {};
  const byHazard: Record<string, ReturnType<typeof counts>> = {};
  const snapshotFresh = now.getTime() - Date.parse(snapshot.generatedAt) <= 30 * 60_000
    && Date.parse(snapshot.generatedAt) <= now.getTime() + 5 * 60_000;
  for (const location of catalog) {
    const presentation = locationCoveragePresentation({ location, state: snapshot.locations[location.id], snapshot, now });
    for (const check of presentation.categories.flatMap(({ subchecks }) => subchecks)) {
      if (!isExpandedDestination(location) && !hazardAppliesToLocation(check.hazard, location)) continue;
      const country = byCountry[location.countryCode] ||= counts();
      const hazard = byHazard[check.hazard] ||= counts();
      for (const count of [totals, country, hazard]) {
        count.applicable += 1;
        const key = check.coverageStatus === "available" ? "fullyChecked" : check.coverageStatus === "limited" ? "partlyChecked" : "notChecked";
        count[key] += 1;
        // A current timestamp on an unsupported hazard never creates coverage.
        if (key === "notChecked") continue;
        if (!snapshotFresh || check.freshnessStatus === "delayed") count.delayed += 1;
        else count[key === "fullyChecked" ? "freshFullyChecked" : "freshPartlyChecked"] += 1;
      }
    }
  }
  return { schemaVersion: 1 as const, measuredAt: now.toISOString(), snapshotAt: snapshot.generatedAt,
    catalogVersion: snapshot.catalogVersion,
    contractSha256: createHash("sha256").update(JSON.stringify({ measurementPolicyRevision, providerRegistry, coverage, applicability, national,
      expandedCoverage: catalog.filter(isExpandedDestination).map((location) => ({ id: location.id, coverage: expandedHazardCoverage(location) })).sort((a, b) => a.id.localeCompare(b.id)),
      catalog: [...catalog].sort((a, b) => a.id.localeCompare(b.id)) })).digest("hex"),
    definition: "Applicable destination-hazard pairs under the reviewed product applicability model (incident-only applicability overrides excluded); freshness is separate from completeness. Not incident detection probability.",
    totals, byCountry, byHazard };
}

export const CaptureCasesSchema = z.array(z.object({
  id: z.string().min(1).max(100), headline: z.string().min(1).max(500), sourceUpdatedAt: z.string().datetime(), hazard: HazardTypeSchema, evidenceUrl: z.string().url(),
  locationIds: z.array(z.string().min(1)).min(1).max(503),
}).strict()).min(1).max(100).superRefine((cases, context) => {
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) context.addIssue({ code: "custom", message: "Duplicate capture case ID" });
  for (const item of cases) if (new Set(item.locationIds).size !== item.locationIds.length) context.addIssue({ code: "custom", message: "Duplicate expected destination" });
});

export function measureCapture(snapshot: Snapshot, input: unknown) {
  const cases = CaptureCasesSchema.parse(input);
  return cases.map((sample) => {
    if (sample.locationIds.some((id) => !snapshot.locations[id])) throw new Error(`Unknown capture destination in ${sample.id}`);
    const captured = Object.entries(snapshot.locations).filter(([, state]) => state.hazards.some((event) => event.headline === sample.headline && event.type === sample.hazard
      && event.evidence.some((evidence) => evidence.sourceUrl === sample.evidenceUrl && evidence.sourceUpdatedAt === sample.sourceUpdatedAt))).map(([id]) => id).sort();
    const expected = new Set(sample.locationIds);
    return { id: sample.id, expected: [...expected].sort(), captured,
      missed: [...expected].filter((id) => !captured.includes(id)).sort(), unexpected: captured.filter((id) => !expected.has(id)) };
  });
}
