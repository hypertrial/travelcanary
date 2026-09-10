import { readFile, writeFile } from "node:fs/promises";
import { providerRegistry } from "../src/lib/provider-registry";
import {
  nationalWarningManifest,
  nationalWarningSources,
} from "../src/lib/national-warning-sources";
import { assertSourceRuntimeIntegrity } from "../src/lib/ingestion/source-runtime";
import { conditionSources } from "../src/lib/conditions/sources";

assertSourceRuntimeIntegrity();

type SourcePolicy = "open" | "restricted" | "gated" | "blocked";

const environmentGatedProviders = new Set(["gfm", "gdelt", "eonet", "edo-drought", "fcdo-travel-advice"]);
const conditionPolicy = (source: { enabled: boolean; noncommercial: boolean }): SourcePolicy =>
  !source.enabled ? "gated" : source.noncommercial ? "restricted" : "open";
const providerPolicy = (providerId: string, mode: string): SourcePolicy =>
  mode === "disabled" ? "blocked" : environmentGatedProviders.has(providerId) ? "gated" : "open";
const nationalPolicy = (status: string): SourcePolicy =>
  status === "blocked" ? "blocked" : status === "active" ? "open" : "gated";

const inventory = {
  policyClasses: {
    open: "Reviewed and enabled by default.",
    restricted: "Lawful reuse with terms requiring explicit operator acceptance; disabled by default.",
    gated: "Makes no requests until its documented technical and legal gates pass.",
    blocked: "Documentation or official links only; never fetched by TravelCanary.",
  },
  localConditions: Object.entries(conditionSources).map(([id, source]) => ({ id, policy: conditionPolicy(source), ...source, role: "context", satisfiesCoverage: false })),
  schemaVersion: 3,
  reviewedAt: nationalWarningManifest.reviewedAt,
  credentials: { required: [], optional: ["effis-active-fire"], environmentGated: ["gfm", "eonet", "edo-drought", "fcdo-travel-advice"] },
  providers: Object.entries(providerRegistry).map(([providerId, definition]) => ({
    providerId,
    policy: providerPolicy(providerId, definition.mode),
    sourceId: definition.sourceId,
    displayName: definition.displayName,
    mode: definition.mode,
    cadenceMinutes: definition.cadenceMinutes,
    hazards: definition.hazards,
    healthScope: definition.healthScope || "global",
    satisfiesCoverage:
      definition.satisfiesCoverage !== false
      && (definition.mode === "authoritative" || definition.mode === "complementary"),
    officialUrl: definition.officialUrl,
    limitationCode: definition.limitationCode,
  })),
  nationalWarningPartitions: Object.entries(nationalWarningSources).map(([countryCode, source]) => ({
    countryCode,
    authority: source.authority,
    systemName: source.systemName,
    reviewedAt: source.reviewedAt,
    evidenceUrls: source.evidenceUrls,
    enabled: source.enabled,
    endpoint: source.endpoint,
    hazards: source.hazards,
    reuseStatus: source.reuseStatus,
    license: source.license || null,
    limitationCode: source.limitationCode,
    satisfiesCoverage: source.satisfiesCoverage,
    coverageLocationIds: source.coverageLocationIds || [],
    systems: nationalWarningManifest.countries[countryCode as keyof typeof nationalWarningManifest.countries].systems.map((system) => ({
      id: system.id, authority: system.authority, systemName: system.systemName,
      policy: nationalPolicy(system.status),
      runtimeTarget: system.runtimeTarget, role: system.role, status: system.status,
      cadenceMinutes: system.cadenceMinutes, format: system.format, hazards: system.hazards,
      coverageContribution: system.coverageContribution,
      accessStatus: system.accessStatus, reuseStatus: system.reuseStatus, severityStatus: system.severityStatus,
      lifecycleStatus: system.lifecycleStatus, geometryStatus: system.geometryStatus, completenessStatus: system.completenessStatus,
      officialUrl: system.officialUrl, evidenceUrls: system.evidenceUrls, reviewedAt: system.reviewedAt,
      nextReviewAt: system.nextReviewAt, limitationCode: system.limitationCode,
    })),
  })),
};
const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (await readFile("data/source-inventory.json", "utf8") !== serialized) throw new Error("data/source-inventory.json is stale; run npm run sources:generate");
} else {
  await writeFile("data/source-inventory.json", serialized);
}
