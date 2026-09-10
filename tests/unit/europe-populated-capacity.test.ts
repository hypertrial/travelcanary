import { describe, expect, it } from "vitest";
import { measureEuropeConditions } from "../../scripts/measure-europe-conditions";
import reviewed from "../../data/review-inputs/europe-conditions-capacity.json";
import { CONDITIONS_TOTAL_LIMIT } from "@/lib/domain/conditions";
import { catalog3ConditionsCountryLimit } from "@/lib/conditions/publication-budget";
import { IngestionStateV14Schema } from "@/lib/domain/catalog-state";

describe("populated expanded conditions capacity", () => {
  it("reproduces full forecasts and retained specialist activity inside unchanged budgets", () => {
    const { state, metrics } = measureEuropeConditions();
    expect(metrics).toEqual(reviewed);
    expect(IngestionStateV14Schema.safeParse(state).success).toBe(true);
    expect(metrics.destinations).toBe(679); expect(metrics.countries).toBe(45);
    expect(metrics.totalBytes).toBeLessThanOrEqual(CONDITIONS_TOTAL_LIMIT);
    expect(metrics.legacyBytes).toBeLessThanOrEqual(CONDITIONS_TOTAL_LIMIT);
    for (const [country, bytes] of Object.entries(metrics.countryBytes)) expect(bytes, country).toBeLessThanOrEqual(catalog3ConditionsCountryLimit(country));
    expect(metrics.cacheBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(metrics.privateBytes).toBeLessThanOrEqual(5_000_000);
    expect(metrics.publication.transitionFiles).toBe(73);
    expect(metrics.dualGenerationBytes).toBe(metrics.totalBytes + metrics.legacyBytes);
  });
});
