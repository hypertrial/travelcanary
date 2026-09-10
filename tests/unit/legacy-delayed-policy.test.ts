import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "../fixtures/catalog-v2-delayed-hazards.json";
import policy from "../../data/catalog-releases/2-delayed-providers.json";
import { HazardTypeSchema, parseSnapshot } from "@/lib/domain/schemas";

function historicalSnapshot(test: typeof baseline.scenarios[number]) {
  const input = JSON.parse(readFileSync("public/demo-snapshot.json", "utf8"));
  input.schemaVersion = 8; delete input.catalogVersion;
  for (const id of ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"]) delete input.locations[id];
  for (const item of Object.values(input.locations)) {
    Object.assign(item as object, { coverage: "delayed", coverageGaps: [...HazardTypeSchema.options] });
    Reflect.deleteProperty(item as object, "delayedHazards");
  }
  for (const [id, item] of Object.entries(input.providers)) {
    const provider = item as { status: string; partitions?: Record<string, { status: string }> };
    provider.status = (test.providers as Record<string, string>)[id] || "ok";
    for (const partition of Object.values(provider.partitions || {})) partition.status = test.healthyPartitions ? "ok" : provider.status;
  }
  return input;
}
function fingerprint(value: ReturnType<typeof parseSnapshot>) {
  return createHash("sha256").update(JSON.stringify(Object.entries(value.locations).map(([id, item]) => [id, item.delayedHazards]))).digest("hex");
}
afterEach(() => {
  vi.doUnmock("../../data/coverage.json"); vi.doUnmock("../../data/national-warning-sources.json");
  vi.doUnmock("@/lib/provider-registry"); vi.resetModules();
});

describe("frozen V8 delayed-hazard interpretation", () => {
  it.each(baseline.scenarios)("preserves all500 destinations and override behavior: $name", (scenario) => {
    expect(fingerprint(parseSnapshot(historicalSnapshot(scenario)))).toBe(scenario.delayedHazardsSha256);
  });

  it("does not reinterpret historical snapshots after active source eligibility changes", async () => {
    vi.resetModules();
    vi.doMock("../../data/coverage.json", () => ({ default: { countries: {}, locationOverrides: {} } }));
    vi.doMock("../../data/national-warning-sources.json", () => ({ default: { countries: {} } }));
    vi.doMock("@/lib/provider-registry", () => ({ providerRegistry: {} }));
    const future = await import("@/lib/domain/schemas");
    for (const scenario of baseline.scenarios) expect(fingerprint(future.parseSnapshot(historicalSnapshot(scenario)))).toBe(scenario.delayedHazardsSha256);
  });

  it("retains explicit empty overrides and provenance for the frozen policy", () => {
    expect(Object.keys(policy.countries)).toHaveLength(28);
    expect(Object.keys(policy.locationOverrides)).toHaveLength(130);
    expect(Object.values(policy.locationOverrides).some((value) => Object.values(value).some((providers) => providers.length === 0))).toBe(true);
    expect(policy.sourceRevision).toBe(baseline.sourceRevision);
    expect(Object.values(policy.inputSha256).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });
});
