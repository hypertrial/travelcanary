import { describe, expect, it, vi } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { catalog3MarineMappingByLocation } from "@/lib/conditions/marine";
import { expandedHazardCoverage, expandedProviderApplies } from "@/lib/expanded-coverage";
import { FcdoTravelAdviceAdapter, fcdoEvent } from "@/lib/ingestion/adapters/fcdo";
import { createEmptyState } from "@/lib/risk-state";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { HazardTypeSchema } from "@/lib/domain/schemas";
import dossier from "../../data/review-inputs/europe-expansion-sources.json";

const countries = [
  ["AL", 12, 3, "albania"], ["BA", 10, 0, "bosnia-and-herzegovina"],
  ["XK", 6, 0, "kosovo"], ["ME", 8, 1, "montenegro"],
  ["MK", 8, 0, "north-macedonia"], ["RS", 12, 0, "serbia"],
] as const;
const now = new Date("2026-09-09T00:00:00Z");
const locations = catalogLocationsV3.filter(({ countryCode }) => countries.some(([code]) => code === countryCode));
const ids = (country: string) => locations.filter(({ countryCode }) => countryCode === country).map(({ id }) => id).sort();
const page = (slug: string, active = false) => ({ title: `${slug} travel advice`, base_path: `/foreign-travel-advice/${slug}`, updated_at: now.toISOString(), details: { alert_status: active ? ["avoid_all_travel_to_whole_country"] : [] } });
const state = () => { const value = createEmptyState(now); value.collection = { catalogVersion: 3, revision: 1 }; return value; };

describe("Western Balkans reviewed country acceptance", () => {
  it.each(countries)("keeps %s destination, marine and all27 assessment boundaries", (country, count, marineCount) => {
    const cohort = locations.filter(({ countryCode }) => countryCode === country);
    expect(cohort).toHaveLength(count);
    expect(cohort.filter(({ id }) => catalog3MarineMappingByLocation.has(id))).toHaveLength(marineCount);
    for (const location of cohort) {
      expect(Object.entries(expandedHazardCoverage(location)).filter(([, capability]) => capability.status === "monitored").map(([hazard]) => hazard)).toEqual(["earthquake"]);
      expect(expandedProviderApplies("fcdo-travel-advice", location)).toBe(true);
      expect(expandedProviderApplies("slf-avalanche", location)).toBe(false);
      expect(expandedProviderApplies("national-civil-alerts", location)).toBe(false);
    }
    const review = dossier.countries[country];
    expect(Object.keys(review.hazards).sort()).toEqual([...HazardTypeSchema.options].sort());
    expect(Object.keys(review.conditions).sort()).toEqual(["weather", "air-quality", "marine", "airport-observation", "hydrology", "transport", "utilities"].sort());
    for (const disposition of [...Object.values(review.hazards), ...Object.values(review.conditions)]) {
      expect(disposition.reviewState).toBe("assessed");
      expect(disposition.assessment.trim()).not.toBe(""); expect(disposition.gate.trim()).not.toBe("");
      expect(disposition.assessmentReport).toBe("docs/europe-expansion/western-balkans.md");
    }
  });

  it("checks all56 destinations using exactly the six approved foreign-advice routes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => Response.json(page(new URL(String(input)).pathname.split("/").at(-1)!)));
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch });
    expect(locations).toHaveLength(56);
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(countries.map(([, , , slug]) => `https://www.gov.uk/api/content/foreign-travel-advice/${slug}`).sort());
    expect(result.status).toBe("ok"); expect(result.events).toEqual([]); expect(result.unavailableLocationIds).toEqual([]);
    expect([...result.checkedLocationIds!].sort()).toEqual(locations.map(({ id }) => id).sort());
  });

  it.each([["XK", "kosovo", "RS"], ["RS", "serbia", "XK"]] as const)("keeps %s advice from /%s out of the %s jurisdiction", async (country, slug, neighbor) => {
    const cohort = locations.filter(({ countryCode }) => countryCode === "XK" || countryCode === "RS");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const requested = new URL(String(input)).pathname.split("/").at(-1)!;
      return Response.json(page(requested, requested === slug));
    });
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations: cohort, fetch });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].geometry).toEqual({ kind: "locations", ids: ids(country) });
    expect(result.events[0].sourceUrl).toBe(`https://www.gov.uk/foreign-travel-advice/${slug}`);
    const committed = state(); committed.events = result.events;
    const snapshot = buildCatalog3Snapshot(committed, now);
    for (const id of ids(country)) expect(snapshot.locations[id].hazards.map(({ type }) => type)).toEqual(["security"]);
    for (const id of ids(neighbor)) expect(snapshot.locations[id].hazards).toEqual([]);
    for (const id of [...ids(country), ...ids(neighbor)]) {
      expect(snapshot.locations[id].coverageGaps).toContain("security");
      expect(snapshot.locations[id].level).not.toBe("NORMAL");
    }
  });

  it("rejects shared flood and avalanche evidence without inventing Balkan monitoring", () => {
    const committed = state();
    const base = fcdoEvent(page("albania", true), "AL", { now, locations, fetch: globalThis.fetch })!;
    committed.events = [
      { ...base, id: "meteoalarm:shared-flood", sourceId: "meteoalarm", providerId: "meteoalarm", type: "flood", geometry: { kind: "locations", ids: locations.map(({ id }) => id) } },
      { ...base, id: "slf:shared-avalanche", sourceId: "slf-avalanche", providerId: "slf-avalanche", type: "avalanche", geometry: { kind: "locations", ids: locations.map(({ id }) => id) } },
    ];
    for (const source of ["meteoalarm", "slf-avalanche"] as const) Object.assign(committed.sources[source], { status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString() });
    const snapshot = buildCatalog3Snapshot(committed, now);
    for (const { id } of locations) {
      expect(snapshot.locations[id].hazards).toEqual([]);
      expect(snapshot.locations[id].coverageGaps).toEqual(expect.arrayContaining(["flood", "avalanche"]));
      expect(snapshot.locations[id].delayedHazards.filter((hazard) => hazard === "flood" || hazard === "avalanche")).toEqual([]);
      expect(snapshot.locations[id].level).toBe("UNKNOWN");
    }
  });
});
