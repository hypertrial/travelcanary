import { describe, expect, it, vi } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { catalog3MarineMappingByLocation } from "@/lib/conditions/marine";
import { expandedHazardCoverage, expandedProviderApplies } from "@/lib/expanded-coverage";
import { FcdoTravelAdviceAdapter } from "@/lib/ingestion/adapters/fcdo";
import { searchLocationSummaries } from "@/lib/ui-presentation";
import { createEmptyState } from "@/lib/risk-state";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { HazardTypeSchema } from "@/lib/domain/schemas";
import dossier from "../../data/review-inputs/europe-expansion-sources.json";

const countries = [["BY", 8, 0, "belarus"], ["MD", 8, 0, "moldova"], ["TR", 30, 9, "turkey"]] as const;
const locations = catalogLocationsV3.filter(({ countryCode }) => countries.some(([code]) => code === countryCode));
const now = new Date("2026-09-09T00:00:00Z");

describe("Belarus, Moldova and Türkiye reviewed country acceptance", () => {
  it.each(countries)("preserves %s destination, marine and all27 category dispositions", (country, count, marineCount) => {
    const cohort = locations.filter(({ countryCode }) => countryCode === country);
    expect(cohort).toHaveLength(count);
    expect(cohort.filter(({ id }) => catalog3MarineMappingByLocation.has(id))).toHaveLength(marineCount);
    for (const location of cohort) {
      expect(Object.entries(expandedHazardCoverage(location)).filter(([, capability]) => capability.status === "monitored").map(([hazard]) => hazard)).toEqual(["earthquake"]);
      expect(expandedProviderApplies("fcdo-travel-advice", location)).toBe(true);
      expect(expandedProviderApplies("national-civil-alerts", location)).toBe(false);
    }
    const review = dossier.countries[country];
    expect(Object.keys(review.hazards).sort()).toEqual([...HazardTypeSchema.options].sort());
    expect(Object.keys(review.conditions).sort()).toEqual(["weather", "air-quality", "marine", "airport-observation", "hydrology", "transport", "utilities"].sort());
    for (const disposition of [...Object.values(review.hazards), ...Object.values(review.conditions)]) {
      expect(disposition.reviewState).toBe("assessed"); expect(disposition.assessment.trim()).not.toBe(""); expect(disposition.gate.trim()).not.toBe("");
      expect(disposition.assessmentReport).toBe(country === "TR" ? "docs/europe-expansion/turkiye.md" : "docs/europe-expansion/moldova-belarus.md");
    }
  });

  it("checks all46 destinations with the actual three FCDO paths, including upstream /turkey", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const slug = new URL(String(input)).pathname.split("/").at(-1)!;
      return Response.json({ title: `${slug} travel advice`, base_path: `/foreign-travel-advice/${slug}`, updated_at: now.toISOString(), details: { alert_status: [] } });
    });
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch });
    expect(locations).toHaveLength(46);
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(countries.map(([, , , slug]) => `https://www.gov.uk/api/content/foreign-travel-advice/${slug}`));
    expect(result.status).toBe("ok"); expect(result.events).toEqual([]); expect(result.unavailableLocationIds).toEqual([]);
    expect([...result.checkedLocationIds!].sort()).toEqual(locations.map(({ id }) => id).sort());
  });

  it.each([
    ["by-minsk", ["Minsk", "Мінск", "Минск"]],
    ["by-gomel", ["Gomel", "Гомель"]],
    ["by-mogilev", ["Mogilev", "Магілёў"]],
    ["md-chisinau", ["Chișinău", "Chisinau"]],
    ["md-balti", ["Bălţi", "Balti"]],
    ["tr-istanbul", ["Istanbul", "İstanbul", "İSTANBUL"]],
    ["tr-izmir", ["İzmir", "Izmir", "İZMİR"]],
    ["tr-diyarbakir", ["Diyarbakır", "Diyarbakir", "DIYARBAKIR"]],
    ["tr-sanliurfa", ["Şanlıurfa", "Sanliurfa"]],
  ] as const)("ranks reviewed native and Latin spellings of %s as the exact destination", (id, spellings) => {
    for (const query of spellings) expect(searchLocationSummaries(catalogLocationsV3, null, query)[0]?.location.id, query).toBe(id);
  });

  it("does not credit blocked national systems from globally healthy source metadata", () => {
    const committed = createEmptyState(now); committed.collection = { catalogVersion: 3, revision: 1 };
    for (const health of Object.values(committed.sources)) Object.assign(health, { status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString() });
    const snapshot = buildCatalog3Snapshot(committed, now);
    for (const { id } of locations) {
      const published = snapshot.locations[id];
      // MGM, AFAD and Belarus CAP have no approved national warning adapter.
      // Global health cannot substitute for destination-scoped check receipts.
      expect(published.level).toBe("UNKNOWN"); expect(published.hazards).toEqual([]);
      expect(published.coverageGaps).toEqual(expect.arrayContaining(["extreme-heat", "flood", "avalanche"]));
      expect(published.delayedHazards.filter((hazard) => hazard !== "earthquake")).toEqual([]);
    }
  });
});
