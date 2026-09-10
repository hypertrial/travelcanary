import { describe, expect, it, vi } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { catalog3MarineMappingByLocation } from "@/lib/conditions/marine";
import { expandedHazardCoverage, expandedProviderApplies } from "@/lib/expanded-coverage";
import { FcdoTravelAdviceAdapter, fcdoEvent } from "@/lib/ingestion/adapters/fcdo";
import { createEmptyState } from "@/lib/risk-state";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { HazardTypeSchema } from "@/lib/domain/schemas";
import dossier from "../../data/review-inputs/europe-expansion-sources.json";

const countries = [["AD", 5], ["LI", 3], ["MC", 1], ["SM", 2], ["VA", 1]] as const;
const now = new Date("2026-09-09T00:00:00Z");
const locations = catalogLocationsV3.filter(({ countryCode }) => countries.some(([code]) => code === countryCode));
const page = (slug: string, active = false) => ({ title: `${slug} travel advice`, base_path: `/foreign-travel-advice/${slug}`, updated_at: now.toISOString(), details: { alert_status: active ? ["avoid_all_travel_to_whole_country"] : [] } });
const state = () => { const value = createEmptyState(now); value.collection = { catalogVersion: 3, revision: 1 }; return value; };

describe("reviewed microstate jurisdiction acceptance", () => {
  it.each(countries)("preserves %s membership, no marine, and all27 assessed categories", (country, count) => {
    const cohort = locations.filter(({ countryCode }) => countryCode === country);
    expect(cohort).toHaveLength(count);
    for (const location of cohort) {
      expect(catalog3MarineMappingByLocation.has(location.id)).toBe(false);
      expect(expandedProviderApplies("fcdo-travel-advice", location)).toBe(country !== "VA");
      expect(expandedProviderApplies("slf-avalanche", location)).toBe(location.id === "li-malbun");
      expect(Object.entries(expandedHazardCoverage(location)).filter(([, capability]) => capability.status === "monitored").map(([hazard]) => hazard).sort()).toEqual(location.id === "li-malbun" ? ["avalanche", "earthquake"] : ["earthquake"]);
    }
    const review = dossier.countries[country];
    expect(Object.keys(review.hazards).sort()).toEqual([...HazardTypeSchema.options].sort());
    expect(Object.keys(review.conditions).sort()).toEqual(["weather", "air-quality", "marine", "airport-observation", "hydrology", "transport", "utilities"].sort());
    for (const disposition of [...Object.values(review.hazards), ...Object.values(review.conditions)]) {
      expect(disposition.reviewState).toBe("assessed"); expect(disposition.assessment.trim()).not.toBe(""); expect(disposition.gate.trim()).not.toBe("");
      expect(disposition.assessmentReport).toBe("docs/europe-expansion/microstates.md");
    }
  });

  it("checks exactly11 eligible destinations via four actual FCDO paths without a Vatican request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => Response.json(page(new URL(String(input)).pathname.split("/").at(-1)!)));
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch });
    expect(locations).toHaveLength(12);
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(["andorra", "liechtenstein", "monaco", "san-marino"].map((slug) => `https://www.gov.uk/api/content/foreign-travel-advice/${slug}`));
    expect(result.status).toBe("ok"); expect(result.events).toEqual([]); expect(result.unavailableLocationIds).toEqual([]);
    expect([...result.checkedLocationIds!].sort()).toEqual(locations.filter(({ countryCode }) => countryCode !== "VA").map(({ id }) => id).sort());
    expect(result.checkedLocationIds).toHaveLength(11);
  });

  it("does not inherit French, Italian or Swiss country advice or weather warnings", () => {
    const committed = state();
    for (const [country, slug] of [["FR", "france"], ["IT", "italy"], ["CH", "switzerland"]] as const) {
      const advice = fcdoEvent(page(slug, true), country, { now, locations: catalogLocationsV3, fetch: globalThis.fetch })!;
      expect(advice.geometry.kind).toBe("locations");
      committed.events.push(advice, { ...advice, id: `meteoalarm:${country}`, sourceId: "meteoalarm", providerId: "meteoalarm", type: "flood" });
    }
    for (const source of ["fcdo-travel-advice", "meteoalarm"] as const) Object.assign(committed.sources[source], { status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString() });
    const snapshot = buildCatalog3Snapshot(committed, now);
    // Prove the seeded country advice is usable evidence in its own jurisdiction.
    for (const country of ["FR", "IT", "CH"]) {
      const location = catalogLocationsV3.find(({ countryCode }) => countryCode === country)!;
      expect(snapshot.locations[location.id].hazards.map(({ type }) => type)).toContain("security");
    }
    for (const { id } of locations) {
      expect(snapshot.locations[id].hazards).toEqual([]); expect(snapshot.locations[id].level).toBe("UNKNOWN");
      expect(snapshot.locations[id].coverageGaps).toEqual(expect.arrayContaining(["flood", "security"]));
    }
  });

  it("publishes approved Malbun avalanche evidence without crediting Vaduz, Schaan or Andorra", () => {
    const committed = state();
    const base = fcdoEvent(page("liechtenstein", true), "LI", { now, locations, fetch: globalThis.fetch })!;
    committed.events = [{ ...base, id: "slf:malbun-reviewed", sourceId: "slf-avalanche", providerId: "slf-avalanche", type: "avalanche", geometry: { kind: "locations", ids: ["li-malbun"] } }];
    const snapshot = buildCatalog3Snapshot(committed, now);
    expect(snapshot.locations["li-malbun"].hazards.map(({ type }) => type)).toEqual(["avalanche"]);
    for (const { id } of locations.filter(({ id }) => id !== "li-malbun")) {
      expect(snapshot.locations[id].hazards).toEqual([]);
      expect(snapshot.locations[id].coverageGaps).toContain("avalanche");
      expect(snapshot.locations[id].delayedHazards).not.toContain("avalanche");
    }
  });
});
