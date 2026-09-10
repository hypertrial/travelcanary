import { describe, expect, it } from "vitest";
import { countryCodes, PartitionedSourceResultSchema, type SourceResult } from "@/lib/domain/schemas";
import { fetchWithRetry } from "@/lib/ingestion/fetch";
import { createSourceDiagnostics, type SourceAdapter } from "@/lib/ingestion/types";
import { executeSourceSmoke, summarizeSourceSmoke } from "../../scripts/smoke-sources";

const now = "2026-08-30T10:00:00.000Z";
const aggregate = (sourceId: SourceResult["sourceId"], status: "ok" | "partial" | "failed" | "disabled", extra: Record<string, unknown> = {}) => ({
  sourceId, checkedAt: now, sourceUpdatedAt: status === "disabled" ? null : now, events: [], status,
  error: status === "partial" || status === "failed" ? "source unavailable" : null,
  ...(status === "disabled" ? { limitationCode: "environment_disabled" } : {}), ...extra,
}) as SourceResult;

describe("source smoke summaries", () => {
  it("captures bounded fetch diagnostics for a global source", async () => {
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch(context) {
        await fetchWithRetry(context.fetch, "https://example.test/feed", {}, 1, 100, undefined, 1_000, "feed");
        return aggregate("usgs", "ok");
      },
    };
    const result = await executeSourceSmoke(adapter, {
      now: new Date(now),
      fetch: async () => new Response("[]", { headers: { "Content-Type": "application/json" } }),
    });
    expect(result).toMatchObject({
      source: "usgs", provider: "usgs", healthScope: "global", satisfiesCoverage: true,
      status: "ok", outcome: "passed", diagnostics: { requests: 1, responseBytes: 2, responseBytesByCategory: { feed: 2 } },
    });
  });

  it("identifies a coverage-scoped partial source and unavailable count", () => {
    const result = summarizeSourceSmoke(aggregate("vigicrues", "partial", {
      unavailableLocationIds: ["fr-paris", "fr-lyon"],
      error: "x".repeat(300),
    }), createSourceDiagnostics(), 12.6, 0);
    expect(result).toMatchObject({
      provider: "vigicrues", healthScope: "coverage", satisfiesCoverage: true,
      status: "partial", outcome: "failed", unavailableLocations: 2, durationMs: 13,
    });
    expect(result.error).toHaveLength(180);
  });
  it("exposes bounded transport failures even for air-quality partitions", () => {
    const result = PartitionedSourceResultSchema.parse({ sourceId: "eea", checkedAt: now,
      partitions: Object.fromEntries(countryCodes.map((country) => [country, { status: "partial", sourceUpdatedAt: now, events: [], error: "samples unavailable",
        transports: { "eea-raster": { status: "failed", events: [], error: "x".repeat(250), sourceUpdatedAt: null, unavailableLocationIds: [`${country.toLowerCase()}-sample`] } } }])) });
    const summary = summarizeSourceSmoke(result, createSourceDiagnostics(), 10, 0);
    expect(summary.transports).toMatchObject({ total: 28, due: 28, healthyEmpty: 0, omittedProblems: 16 });
    expect(summary.transports?.problems).toHaveLength(12);
    expect(summary.transports?.problems[0]).toMatchObject({ id: "eea-raster", status: "failed", unavailableLocations: 1 });
    expect(summary.transports?.problems[0].error).toHaveLength(180);
  });

  it("prioritizes and bounds partition problems", () => {
    const result = PartitionedSourceResultSchema.parse({ sourceId: "eea", checkedAt: now, partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
      status: countryCode === "AT" ? "failed" : countryCode === "ES" ? "partial" : "disabled",
      sourceUpdatedAt: countryCode === "ES" ? now : null,
      events: [],
      error: countryCode === "AT" ? "feed failed" : countryCode === "ES" ? "2 destination samples unavailable" : null,
      limitationCode: countryCode === "AT" || countryCode === "ES" ? null : "not_supported",
      checkedLocationIds: [],
      unavailableLocationIds: countryCode === "ES" ? ["es-one", "es-two"] : countryCode === "AT" ? ["at-one"] : [],
    }])) });
    const summary = summarizeSourceSmoke(result, createSourceDiagnostics(), 5, 0);
    expect(summary).toMatchObject({
      healthScope: "coverage", status: "partial", outcome: "failed", unavailableLocations: 3,
      partitions: { total: 28, failed: 1, partial: 1, disabled: 26, omittedProblems: 16 },
    });
    expect(summary.partitions?.problems).toHaveLength(12);
    expect(summary.partitions?.problems.slice(0, 2).map(({ id, status }) => [id, status])).toEqual([
      ["AT", "failed"], ["ES", "partial"],
    ]);
  });

  it("distinguishes non-blocking discovery failures from disabled sources", () => {
    expect(summarizeSourceSmoke(aggregate("gdacs", "failed"), createSourceDiagnostics(), 1, 0)).toMatchObject({
      mode: "discovery", healthScope: "non_blocking", satisfiesCoverage: false, outcome: "failed",
    });
    expect(summarizeSourceSmoke(aggregate("gfm", "disabled"), createSourceDiagnostics(), 1, 0)).toMatchObject({
      mode: "complementary", healthScope: "non_blocking", satisfiesCoverage: false,
      status: "disabled", outcome: "disabled", limitationCode: "environment_disabled",
    });
  });

  it("reports bounded national transport roles, due work, skips, blockers, and healthy empty", () => {
    const result = PartitionedSourceResultSchema.parse({
      sourceId: "national-civil-alerts", checkedAt: now,
      partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, countryCode === "AT" ? {
        status: "ok", sourceUpdatedAt: now, events: [], error: null,
        transports: { "at-alert": { status: "ok", sourceUpdatedAt: now, error: null, checkedLocationIds: ["at-vienna"] } },
      } : countryCode === "IT" ? {
        status: "ok", sourceUpdatedAt: now, events: [], error: null,
        transports: { "dpc-flood-bulletin": { status: "not_due", sourceUpdatedAt: null, error: "not_due" } },
      } : { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "readiness_gated" }])),
    });
    const summary = summarizeSourceSmoke(result, createSourceDiagnostics(), 5, 0);
    expect(summary.transports).toMatchObject({ due: 1, skipped: 1, healthyEmpty: 1, affectedDestinations: 1 });
    expect(summary.transports!.total).toBeGreaterThan(2);
    expect(summary.transports!.roles.coverage).toBeGreaterThan(0);
    expect(summary.transports!.evidenceBlocked).toBeGreaterThan(0);
    expect(summary.transports!.credentialBlocked).toBe(1);
  });
});
