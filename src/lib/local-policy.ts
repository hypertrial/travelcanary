import { createHash } from "node:crypto";
import { z } from "zod";
import sourceInventory from "../../data/source-inventory.json";

export const LocalRuntimePolicySchema = z.object({
  schemaVersion: z.literal(1),
  restrictedSources: z.enum(["disabled", "accepted"]),
  acceptedManifestDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  acceptedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type LocalRuntimePolicy = z.infer<typeof LocalRuntimePolicySchema>;

const restrictedManifest = {
  localConditions: sourceInventory.localConditions.filter(({ policy }) => policy === "restricted"),
  providers: sourceInventory.providers.filter(({ policy }) => policy === "restricted"),
  nationalWarningSystems: sourceInventory.nationalWarningPartitions.flatMap(({ countryCode, systems }) =>
    systems.filter(({ policy }) => policy === "restricted").map((system) => ({ countryCode, ...system }))),
};

export const restrictedSourceCount = restrictedManifest.localConditions.length
  + restrictedManifest.providers.length + restrictedManifest.nationalWarningSystems.length;
export const restrictedSourceManifestDigest = createHash("sha256")
  .update(JSON.stringify(restrictedManifest)).digest("hex");

export function disabledLocalPolicy(): LocalRuntimePolicy {
  return { schemaVersion: 1, restrictedSources: "disabled", acceptedManifestDigest: null, acceptedAt: null };
}

export function restrictedSourcesActive(policy: LocalRuntimePolicy) {
  return policy.restrictedSources === "accepted"
    && policy.acceptedManifestDigest === restrictedSourceManifestDigest
    && Boolean(policy.acceptedAt);
}

export function collectorEnvironment(policy: LocalRuntimePolicy, environment: Record<string, string | undefined> = process.env) {
  return {
    ...environment,
    LOCAL_CONDITIONS_ENABLED: "true",
    NONCOMMERCIAL_DATA_ENABLED: restrictedSourcesActive(policy) ? "true" : "false",
    CONTEXT_FEEDS_ENABLED: "false",
    GDELT_ENABLED: "false",
    GFM_ENABLED: "false",
    GLOFAS_TARGETING_ENABLED: "false",
    IFRC_FALLBACK_ENABLED: "false",
  };
}
