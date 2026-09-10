import { describe, expect, it, vi } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { catalog3MarineMappingByLocation } from "@/lib/conditions/marine";
import { expandedHazardCoverage, expandedProviderApplies } from "@/lib/expanded-coverage";
import { FcdoTravelAdviceAdapter } from "@/lib/ingestion/adapters/fcdo";
import { createEmptyState } from "@/lib/risk-state";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { HazardTypeSchema, type NormalizedEvent } from "@/lib/domain/schemas";
import dossier from "../../data/review-inputs/europe-expansion-sources.json";
import links from "../../data/country-information-links.json";
import release2 from "../../data/catalog-releases/2.json";

const now = new Date("2026-09-09T00:00:00Z");
const north = catalogLocationsV3.filter(({ countryCode }) => ["GB", "NO", "IS"].includes(countryCode));
const added = catalogLocationsV3.filter(({ id }) => !release2.locationIds.includes(id)).map(({ id }) => id);
const transportAndUtilityLinks = {
  GB: [
    ["England National Highways travel updates", "https://nationalhighways.co.uk/roads-and-travel/live-travel-updates/"],
    ["Scotland trunk-road traffic updates", "https://www.traffic.gov.scot/"],
    ["Wales traffic information", "https://traffic.wales/"],
    ["Northern Ireland traffic information", "https://www.trafficwatchni.com/twni/"],
    ["Great Britain electricity operator directory", "https://www.powercut105.com/"],
    ["Northern Ireland electricity outages — NIE Networks", "https://powercheck.nienetworks.co.uk/index.html"],
  ],
  NO: [["Norway road traffic information", "https://www.vegvesen.no/trafikk/"], ["Elvia electricity outages — Elvia service area only", "https://www.elvia.no/strombruddskart/"]],
  IS: [["Iceland road conditions", "https://umferdin.is/en"], ["Veitur utility outages — Veitur service networks only", "https://www.veitur.is/en/outages"]],
};

describe("GB, Norway and Iceland reviewed jurisdiction acceptance", () => {
  it.each([["GB", 30, 8], ["NO", 20, 5], ["IS", 12, 4]] as const)("preserves%s destination and reviewed marine scope", (country, count, marineCount) => {
    const locations = north.filter(({ countryCode }) => countryCode === country); expect(locations).toHaveLength(count);
    expect(locations.filter(({ id }) => catalog3MarineMappingByLocation.has(id))).toHaveLength(marineCount);
    for (const location of locations) {
      const capabilities = expandedHazardCoverage(location);
      expect(Object.entries(capabilities).filter(([, capability]) => capability.status === "monitored").map(([hazard]) => hazard)).toEqual(["earthquake"]);
      expect(expandedProviderApplies("fcdo-travel-advice", location)).toBe(country !== "GB");
      expect(expandedProviderApplies("slf-avalanche", location)).toBe(false);
    }
  });

  it.each(["GB", "NO", "IS"] as const)("records all27 independently assessed category dispositions for%s", (country) => {
    const review = dossier.countries[country];
    expect(Object.keys(review.hazards).sort()).toEqual([...HazardTypeSchema.options].sort());
    expect(Object.keys(review.conditions).sort()).toEqual(["weather", "air-quality", "marine", "airport-observation", "hydrology", "transport", "utilities"].sort());
    for (const disposition of [...Object.values(review.hazards), ...Object.values(review.conditions)]) {
      expect(disposition.reviewState).toBe("assessed"); expect(disposition.assessment.length).toBeGreaterThan(20);
      expect(disposition.gate.length).toBeGreaterThan(20); expect(disposition.assessmentReport).toBe("docs/europe-expansion/uk-norway-iceland.md");
    }
  });

  it("fetches foreign advice only for32 Norwegian/Icelandic destinations and never requests UK foreign advice", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input)); const slug = url.pathname.split("/").at(-1)!;
      expect(["norway", "iceland"]).toContain(slug);
      return Response.json({ title: `${slug} travel advice`, base_path: `/foreign-travel-advice/${slug}`, updated_at: now.toISOString(), details: { alert_status: [] } });
    });
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations: north, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(["https://www.gov.uk/api/content/foreign-travel-advice/iceland", "https://www.gov.uk/api/content/foreign-travel-advice/norway"]);
    expect(result.status).toBe("ok"); expect(result.events).toEqual([]);
    expect(result.checkedLocationIds!.sort()).toEqual(north.filter(({ countryCode }) => countryCode !== "GB").map(({ id }) => id).sort());
    expect(result.checkedLocationIds).toHaveLength(32);
  });

  it("does not turn neighboring/global evidence into national flood, avalanche or volcanic monitoring", () => {
    const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
    for (const health of Object.values(state.sources)) Object.assign(health, { status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString() });
    state.expandedSourceHealth.usgs = { health: state.sources.usgs, checkedLocationIds: added, unavailableLocationIds: [] };
    const event = (sourceId: NormalizedEvent["sourceId"], providerId: NormalizedEvent["providerId"], type: NormalizedEvent["type"]): NormalizedEvent => ({
      id: `${sourceId}:outside-reviewed-remit`, sourceId, providerId, type, level: "HIGH", timing: "ACTIVE", geometry: { kind: "locations", ids: north.map(({ id }) => id) },
      headline: "Shared source evidence", explanation: "Evidence outside approved national mappings.", action: "Read official advice.", affectedArea: "Shared area",
      startsAt: now.toISOString(), endsAt: new Date(+now + 3600000).toISOString(), checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), expiresAt: new Date(+now + 3600000).toISOString(),
      sourceName: "Official source", sourceUrl: "https://example.test/official", confidence: "MEDIUM",
    });
    state.events = [event("meteoalarm", "meteoalarm", "flood"), event("slf-avalanche", "slf-avalanche", "avalanche"), event("eonet", "eonet", "volcano")];
    const snapshot = buildCatalog3Snapshot(state, now);
    for (const { id } of north) {
      expect(snapshot.locations[id].hazards).toEqual([]); expect(snapshot.locations[id].level).toBe("NORMAL");
      expect(snapshot.locations[id].coverageGaps).toEqual(expect.arrayContaining(["flood", "avalanche", "volcano"]));
      expect(snapshot.locations[id].delayedHazards).toEqual([]);
    }
  });

  it.each(["GB", "NO", "IS"] as const)("labels%s transport/utility links by their actual jurisdiction or service role", (country) => {
    for (const [label, url] of transportAndUtilityLinks[country]) {
      expect(links[country]).toContainEqual({ label, url }); const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:"); expect(parsed.username).toBe(""); expect(parsed.password).toBe("");
      expect(Object.entries(links).filter(([code]) => code !== country).flatMap(([, entries]) => entries).some((entry) => entry.url === url)).toBe(false);
    }
    expect(north.filter(({ countryCode }) => countryCode === country).every((location) => !expandedProviderApplies("national-civil-alerts", location))).toBe(true);
  });
});
