import { expandedHazardCoverage, isExpandedDestination } from "../src/lib/expanded-coverage";
import { createHash } from "node:crypto";
import { z } from "zod";
import coverage from "../data/coverage.json";
import applicability from "../data/hazard-applicability.json";
import national from "../data/national-warning-sources.json";
import { providerRegistry } from "../src/lib/provider-registry";
import { type CatalogSnapshot, type PublicCatalogLocation } from "../src/lib/domain/catalog-public";
import { HazardTypeSchema, type Snapshot } from "../src/lib/domain/schemas";
import { coverageBreakdown } from "../src/lib/coverage-measurement";

export { coveragePairStates } from "../src/lib/coverage-measurement";

// Bump when coverage-presentation/risk-policy measurement semantics change.
const measurementPolicyRevision = 2;
export function measureCoverage(snapshot: CatalogSnapshot, catalog: PublicCatalogLocation[], now: Date) {
  const { totals, byCountry, byHazard, tiers } = coverageBreakdown(snapshot, catalog, now);
  return { schemaVersion: 1 as const, measuredAt: now.toISOString(), snapshotAt: snapshot.generatedAt,
    catalogVersion: snapshot.catalogVersion,
    contractSha256: createHash("sha256").update(JSON.stringify({ measurementPolicyRevision, providerRegistry, coverage, applicability, national,
      expandedCoverage: catalog.filter(isExpandedDestination).map((location) => ({ id: location.id, coverage: expandedHazardCoverage(location) })).sort((a, b) => a.id.localeCompare(b.id)),
      catalog: [...catalog].sort((a, b) => a.id.localeCompare(b.id)) })).digest("hex"),
    definition: "Applicable destination-hazard pairs under the reviewed product applicability model (incident-only applicability overrides excluded); freshness is separate from completeness. Not incident detection probability.",
    totals, byCountry, byHazard, tiers };
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
