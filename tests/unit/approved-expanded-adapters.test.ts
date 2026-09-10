import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { UsgsAdapter } from "@/lib/ingestion/adapters/usgs";
import { EmscAdapter } from "@/lib/ingestion/adapters/emsc";
import { FcdoTravelAdviceAdapter, fcdoSlugs } from "@/lib/ingestion/adapters/fcdo";
import { SlfAvalancheAdapter } from "@/lib/ingestion/adapters/avalanche";
import release2 from "../../data/catalog-releases/2.json";

const now = new Date("2026-09-08T12:00:00Z");
const additions = catalogLocationsV3.filter(({ id }) => !release2.locationIds.includes(id));
const expectedSlugs = { AL: "albania", AD: "andorra", BY: "belarus", BA: "bosnia-and-herzegovina", IS: "iceland", XK: "kosovo", LI: "liechtenstein", MD: "moldova", MC: "monaco", ME: "montenegro", MK: "north-macedonia", NO: "norway", SM: "san-marino", RS: "serbia", TR: "turkey" };
const page = (slug: string, statuses: string[] = []) => ({ title: `${slug} travel advice`, base_path: `/foreign-travel-advice/${slug}`, updated_at: now.toISOString(), details: { alert_status: statuses } });

describe("approved earthquake adapters on expanded destinations", () => {
  it.each(["usgs", "emsc"] as const)("matches every reviewed176 destination using its actual coordinate in %s", async (source) => {
    expect(additions).toHaveLength(176);
    const adapter = source === "usgs" ? new UsgsAdapter() : new EmscAdapter(); expect(adapter.catalogVersion).toBe(3);
    for (const location of additions) {
      const feature = { id: location.id, geometry: { type: "Point", coordinates: [...location.centroid, 10] },
        properties: source === "usgs" ? { mag: 4.8, time: now.getTime() - 60000, updated: now.getTime(), detail: `https://earthquake.usgs.gov/detail/${location.id}`, status: "automatic", place: location.name }
          : { mag: 4.8, time: new Date(now.getTime() - 60000).toISOString(), lastupdate: now.toISOString(), unid: location.id } };
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes("/detail/")
        ? Response.json({ properties: { products: {} } }) : Response.json({ type: "FeatureCollection", metadata: { generated: now.getTime() }, features: [feature] }));
      const result = await adapter.fetch({ now, locations: [location], fetch: fetchMock });
      expect(result.status, location.id).toBe("ok");
      expect(result.events.map(({ geometry }) => geometry)).toEqual([{ kind: "locations", ids: [location.id] }]);
      expect(fetchMock).toHaveBeenCalledTimes(source === "usgs" ? 2 : 1);
    }
  });

  it("keeps failed USGS detail locations unavailable while crediting independent successful locations", async () => {
    const locations = catalogLocationsV3.filter(({ id }) => ["at-vienna", "gb-london"].includes(id));
    const features = locations.map((location) => ({ id: location.id, geometry: { coordinates: [...location.centroid, 10] },
      properties: { mag: 4.8, time: now.getTime() - 60000, updated: now.getTime(), detail: `https://earthquake.usgs.gov/detail/${location.id}`, status: "automatic", place: location.name } }));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes("/summary/")
      ? Response.json({ metadata: { generated: now.getTime() }, features })
      : String(url).endsWith("at-vienna") ? new Response("Unavailable", { status: 404 }) : Response.json({ properties: { products: {} } }));
    const result = await new UsgsAdapter().fetch({ now, locations, fetch: fetchMock });
    expect(result.status).toBe("partial"); expect(result.checkedLocationIds).toEqual(["gb-london"]);
    expect(result.unavailableLocationIds).toEqual(["at-vienna"]);
    expect(result.unavailableEventIds).toEqual(["usgs:at-vienna:at-vienna"]);
    expect(result.events.map(({ id }) => id).sort()).toEqual(["usgs:at-vienna:at-vienna", "usgs:gb-london:gb-london"]);
  });
});

describe("reviewed expanded FCDO country scope", () => {
  it("parses retained Belarus fields with their original content timestamp and documented provenance", async () => {
    const value = JSON.parse(readFileSync("tests/fixtures/europe-expansion/fcdo-belarus-fields.json", "utf8"));
    const provenance = JSON.parse(readFileSync("tests/fixtures/europe-expansion/fcdo-belarus-fields-provenance.json", "utf8"));
    expect(provenance.sourceUrl).toBe("https://www.gov.uk/api/content/foreign-travel-advice/belarus");
    expect(provenance.originalBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(value)));
    expect(provenance.originalSha256).toMatch(/^[a-f0-9]{64}$/); expect(provenance.reuse).toContain("Open Government Licence");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    const locations = additions.filter(({ countryCode }) => countryCode === "BY");
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch: fetchMock });
    expect(result.status).toBe("ok"); expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "fcdo:BY", checkedAt: now.toISOString(), sourceUpdatedAt: new Date(value.updated_at).toISOString(),
      sourceUrl: "https://www.gov.uk/foreign-travel-advice/belarus", geometry: { kind: "locations", ids: locations.map(({ id }) => id).sort() } });
    expect(result.events[0].sourceUpdatedAt).not.toBe(new Date(value.public_updated_at).toISOString());
    expect(fetchMock).toHaveBeenCalledWith(provenance.sourceUrl, expect.any(Object));
  });

  it("requests exactly15 reviewed new-country pages and classifies145 supported destinations", async () => {
    expect(Object.keys(fcdoSlugs)).toHaveLength(43);
    expect(Object.fromEntries(Object.entries(fcdoSlugs).filter(([country]) => country in expectedSlugs))).toEqual(expectedSlugs);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => Response.json(page(new URL(String(url)).pathname.split("/").at(-1)!, ["avoid_all_travel_to_whole_country"])));
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations: additions, fetch: fetchMock });
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual(Object.values(expectedSlugs).map((slug) => `https://www.gov.uk/api/content/foreign-travel-advice/${slug}`).sort());
    expect(result.status).toBe("ok"); expect(result.events).toHaveLength(15);
    const supportedIds = additions.filter(({ countryCode }) => countryCode in expectedSlugs).map(({ id }) => id).sort();
    expect(supportedIds).toHaveLength(145); expect(result.checkedLocationIds?.sort()).toEqual(supportedIds); expect(result.unavailableLocationIds).toEqual([]);
    for (const event of result.events) {
      const code = event.id.slice("fcdo:".length);
      expect(event.geometry).toEqual({ kind: "locations", ids: additions.filter(({ countryCode }) => countryCode === code).map(({ id }) => id).sort() });
    }
  });

  it.each([{ label: "quiet", statuses: [] }, { label: "regional all-travel", statuses: ["avoid_all_travel_to_parts"] }, { label: "regional essential-travel", statuses: ["avoid_all_but_essential_travel_to_parts"] }])("treats valid $label advice as checked context without whole-country events", async ({ statuses }) => {
    const locations = additions.filter(({ countryCode }) => countryCode === "TR");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page("turkey", statuses)));
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch: fetchMock });
    expect(result).toMatchObject({ status: "ok", events: [], checkedLocationIds: locations.map(({ id }) => id), unavailableLocationIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["empty object", "missing title", "naive time", "missing statuses", "wrong country", "empty base path", "future time", "HTTP failure"])("fails closed for %s instead of crediting a healthy empty country", async (mode) => {
    const value = page("turkey");
    if (mode === "missing title") Reflect.deleteProperty(value, "title");
    if (mode === "naive time") value.updated_at = "2026-09-08T12:00:00";
    if (mode === "missing statuses") Reflect.deleteProperty(value.details, "alert_status");
    if (mode === "wrong country") value.base_path = "/foreign-travel-advice/austria";
    if (mode === "empty base path") value.base_path = "";
    if (mode === "future time") value.updated_at = "2026-09-08T12:05:00.001Z";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => mode === "HTTP failure" ? new Response("Unavailable", { status: 404 }) : Response.json(mode === "empty object" ? {} : value));
    const locations = additions.filter(({ countryCode }) => countryCode === "TR");
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch: fetchMock });
    expect(result).toMatchObject({ status: "failed", events: [], checkedLocationIds: [], unavailableLocationIds: locations.map(({ id }) => id) });
  });

  it("isolates one malformed country while retaining another country's whole-country context", async () => {
    const locations = additions.filter(({ countryCode }) => ["TR", "AL"].includes(countryCode));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => Response.json(String(url).endsWith("turkey") ? {} : page("albania", ["avoid_all_but_essential_travel_to_whole_country"])));
    const result = await new FcdoTravelAdviceAdapter(true).fetch({ now, locations, fetch: fetchMock });
    expect(result.status).toBe("partial"); expect(result.events.map(({ id }) => id)).toEqual(["fcdo:AL"]);
    expect(result.checkedLocationIds).toEqual(locations.filter(({ countryCode }) => countryCode === "AL").map(({ id }) => id));
    expect(result.unavailableLocationIds).toEqual(locations.filter(({ countryCode }) => countryCode === "TR").map(({ id }) => id));
  });

  it.each(["unsupported only", "disabled"])("makes zero requests for %s", async (mode) => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await new FcdoTravelAdviceAdapter(mode !== "disabled").fetch({ now, locations: mode === "disabled" ? additions : additions.filter(({ countryCode }) => ["GB", "VA"].includes(countryCode)), fetch: fetchMock });
    expect(result.status).toBe("disabled"); expect(result.events).toEqual([]); expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reviewed SLF Malbun-only expansion", () => {
  it.each(["retained moderate", "synthetic considerable"])("uses retained Malbun geometry without checking Vaduz or Schaan: %s", async (mode) => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/europe-expansion/slf-winter.json", "utf8"));
    // Real geometry intersects Malbun at danger2; vary only the rating for the positive alert boundary.
    if (mode === "synthetic considerable") fixture.features.find((feature: { id: number }) => feature.id === 8).properties.dangerRatings[0].mainValue = "considerable";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    const result = await new SlfAvalancheAdapter().fetch({ now: new Date("2026-02-01T12:00:00Z"), locations: catalogLocationsV3, fetch: fetchMock });
    expect(result.status).toBe("ok");
    expect(result.events.some(({ geometry }) => geometry.kind === "locations" && geometry.ids.includes("li-malbun"))).toBe(mode === "synthetic considerable");
    const expected = catalogLocationsV3.filter((location) => (location.countryCode === "CH" && ["mountain", "resort", "park"].includes(location.type)) || location.id === "li-malbun").map(({ id }) => id).sort();
    expect(result.checkedLocationIds?.sort()).toEqual(expected); expect(result.unavailableLocationIds).toEqual([]);
    const affected = result.events.flatMap(({ geometry }) => geometry.kind === "locations" ? geometry.ids : []);
    expect(affected).not.toContain("li-vaduz"); expect(affected).not.toContain("li-schaan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
