import sourcesJson from "../../data/national-warning-sources.json";
import { z } from "zod";
import { CountryCodeSchema, HazardTypeSchema, countryCodes, type CountryCode, type HazardType } from "./domain/schemas";

const GateSchema = z.enum(["approved", "partial", "credential_required", "unverified", "blocked"]);
const NationalWarningSystemSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reviewedAt: z.string().date(), nextReviewAt: z.string().date(),
  evidenceUrls: z.array(z.string().url()).min(1).max(6),
  authority: z.string().min(2), systemName: z.string().min(2), officialUrl: z.string().url(),
  runtimeTarget: z.enum(["national-civil-alerts", "meteoalarm-fallback", "none"]),
  role: z.enum(["coverage", "fallback", "context", "blocked"]),
  status: z.enum(["active", "credential_gated", "evidence_gated", "blocked"]),
  endpoint: z.string().url().nullable(),
  format: z.enum(["cap", "atom", "rss", "json", "html", "github-json"]).nullable(),
  cadenceMinutes: z.number().int().positive().max(1440).nullable(),
  maxBytes: z.number().int().positive().max(4 * 1024 * 1024).nullable(),
  hazards: z.array(HazardTypeSchema),
  accessStatus: GateSchema, reuseStatus: GateSchema, severityStatus: GateSchema,
  lifecycleStatus: GateSchema, geometryStatus: GateSchema, completenessStatus: GateSchema,
  coverageContribution: z.enum(["none", "partial", "complete"]),
  coverageLocationIds: z.array(z.string().min(1)).max(600).optional(),
  credentialEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]+$/).nullable().optional(),
  limitationCode: z.string().min(3).max(100).nullable(),
  blocker: z.string().min(3).max(500).nullable(), contactUrl: z.string().url().nullable(),
  reReviewTrigger: z.string().min(3).max(300).nullable(),
  license: z.object({ name: z.string().min(2), url: z.string().url() }).nullable().optional(),
}).superRefine((system, context) => {
  const runnable = system.endpoint && system.format && system.cadenceMinutes && system.maxBytes && system.hazards.length
    && system.accessStatus === "approved" && system.reuseStatus === "approved"
    && ["approved", "partial"].includes(system.severityStatus)
    && ["approved", "partial"].includes(system.lifecycleStatus)
    && ["approved", "partial"].includes(system.geometryStatus);
  if (system.status === "active" && !runnable) context.addIssue({ code: "custom", path: ["status"], message: "Active systems must pass runtime readiness gates" });
  if (system.status === "active" && system.runtimeTarget === "none") context.addIssue({ code: "custom", path: ["runtimeTarget"], message: "Active systems require a runtime target" });
  if (system.status !== "active" && !system.limitationCode) context.addIssue({ code: "custom", path: ["limitationCode"], message: "Gated and blocked systems require a limitation" });
  if (system.status !== "active" && !system.blocker) context.addIssue({ code: "custom", path: ["blocker"], message: "Gated and blocked systems require a blocker" });
  if (system.role === "blocked" && system.runtimeTarget !== "none") context.addIssue({ code: "custom", path: ["runtimeTarget"], message: "Blocked systems cannot have a runtime target" });
  if (system.role !== "coverage" && system.coverageContribution !== "none") context.addIssue({ code: "custom", path: ["coverageContribution"], message: "Only coverage systems may contribute coverage" });
  if (system.coverageContribution !== "none" && (system.status !== "active" || !["approved", "partial"].includes(system.completenessStatus))) {
    context.addIssue({ code: "custom", path: ["coverageContribution"], message: "Coverage requires an active, reviewed completeness decision" });
  }
  if (system.status === "credential_gated" && !system.credentialEnvVar) context.addIssue({ code: "custom", path: ["credentialEnvVar"], message: "Credential-gated systems require an environment variable" });
});

const NationalWarningCountrySchema = z.object({ reviewedAt: z.string().date(), systems: z.array(NationalWarningSystemSchema).min(1).max(4) }).superRefine((country, context) => {
  if (Date.now() - Date.parse(country.reviewedAt) > 370 * 24 * 60 * 60_000) context.addIssue({ code: "custom", path: ["reviewedAt"], message: "Country review must be refreshed at least annually" });
  const ids = country.systems.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["systems"], message: "System IDs must be unique within a country" });
});

export const NationalWarningSourcesSchema = z.object({
  schemaVersion: z.literal(3), reviewedAt: z.string().date(), discoveryInventory: z.string().url(),
  countries: z.record(CountryCodeSchema, NationalWarningCountrySchema),
}).superRefine((manifest, context) => {
  for (const countryCode of countryCodes) if (!manifest.countries[countryCode]) {
    context.addIssue({ code: "custom", path: ["countries", countryCode], message: "Every catalog country requires a reviewed national warning outcome" });
  }
});

export const nationalWarningManifest = NationalWarningSourcesSchema.parse(sourcesJson);
export type NationalWarningSystem = z.infer<typeof NationalWarningSystemSchema>;

export function activeNationalSystems(countryCode: CountryCode) {
  return nationalWarningManifest.countries[countryCode].systems.filter((system) => system.status === "active" && system.runtimeTarget === "national-civil-alerts");
}

export function meteoalarmFallbackSystem(countryCode: CountryCode) {
  return nationalWarningManifest.countries[countryCode].systems.find((system) => system.status === "active" && system.runtimeTarget === "meteoalarm-fallback") || null;
}

export const nationalWarningSources = Object.fromEntries(Object.entries(nationalWarningManifest.countries).map(([countryCode, country]) => {
  const systems = country.systems;
  const runtime = systems.filter((system) => system.status === "active" && system.runtimeTarget === "national-civil-alerts");
  const coverage = runtime.filter((system) => system.coverageContribution !== "none");
  const primary = runtime[0] || systems.find(({ runtimeTarget }) => runtimeTarget !== "meteoalarm-fallback") || systems[0];
  const hazards = [...new Set(coverage.flatMap((system) => system.hazards))] as HazardType[];
  const coverageLocationIds = [...new Set(coverage.flatMap((system) => system.coverageLocationIds || []))];
  return [countryCode, {
    reviewedAt: country.reviewedAt, evidenceUrls: primary.evidenceUrls, authority: primary.authority,
    systemName: runtime.length > 1 ? `${primary.authority} national warning sources` : primary.systemName,
    officialUrl: primary.officialUrl, enabled: runtime.length > 0, endpoint: primary.endpoint,
    format: primary.format, cadenceMinutes: primary.cadenceMinutes, hazards,
    reuseStatus: primary.reuseStatus === "approved" ? "approved" as const : primary.reuseStatus === "blocked" ? "not_approved" as const : "unverified" as const,
    severityStatus: primary.severityStatus === "approved" ? "approved" as const : "unverified" as const,
    lifecycleStatus: primary.lifecycleStatus === "approved" ? "approved" as const : "unverified" as const,
    license: primary.license, limitationCode: runtime.length ? null : primary.limitationCode,
    satisfiesCoverage: coverage.length > 0, coverageLocationIds: coverageLocationIds.length ? coverageLocationIds : undefined,
    systems,
  }];
})) as Record<CountryCode, {
  reviewedAt: string; evidenceUrls: string[]; authority: string; systemName: string; officialUrl: string;
  enabled: boolean; endpoint: string | null; format: string | null; cadenceMinutes: number | null; hazards: HazardType[];
  reuseStatus: "approved" | "not_approved" | "unverified"; severityStatus: "approved" | "unverified";
  lifecycleStatus: "approved" | "unverified"; license?: { name: string; url: string } | null;
  limitationCode: string | null; satisfiesCoverage: boolean; coverageLocationIds?: string[]; systems: NationalWarningSystem[];
}>;
