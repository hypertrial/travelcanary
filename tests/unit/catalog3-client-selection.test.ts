import { describe, expect, it, vi } from "vitest";
import { getPublicDataConfig } from "@/lib/config";
import { loadCoveredCountriesLayer, COVERED_COUNTRIES_LAYER } from "@/lib/map-presentation";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { searchLocationSummaries } from "@/lib/ui-presentation";

describe("Catalog 3-only client selection", () => {
  it("uses only the server-controlled data endpoint", () => {
    expect(getPublicDataConfig({})).toEqual({ mode: "demo", catalogVersion: 3, snapshotUrl: "/api/v1/data" });
    expect(getPublicDataConfig({ VERCEL_ENV: "production", TRAVELCANARY_PUBLICATION_URL: "https://unit.public.blob.vercel-storage.com/catalogs/3/publication/latest.json" }))
      .toEqual({ mode: "live", catalogVersion: 3, snapshotUrl: "/api/v1/data" });
  });
});

describe("versioned map tint refresh", () => {
  function map() {
    const setData = vi.fn();
    return { setData, getLayer: vi.fn((id: string) => id === COVERED_COUNTRIES_LAYER ? ({ id } as never) : undefined),
      getSource: vi.fn(() => ({ type: "geojson", setData }) as never), addSource: vi.fn(), addLayer: vi.fn(),
      jumpTo: vi.fn(), easeTo: vi.fn(), flyTo: vi.fn(), fitBounds: vi.fn() };
  }
  it("fetches catalog 3 geography and replaces existing source data without changing camera", async () => {
    const target = map(); const data = { type: "FeatureCollection", features: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data)); const controller = new AbortController();
    await loadCoveredCountriesLayer(target, controller.signal, fetch);
    expect(fetch).toHaveBeenCalledWith("/catalogs/3/covered-countries.geojson", { signal: controller.signal });
    expect(target.setData).toHaveBeenCalledWith(data); expect(target.addSource).not.toHaveBeenCalled(); expect(target.addLayer).not.toHaveBeenCalled();
    for (const change of [target.jumpTo, target.easeTo, target.flyTo, target.fitBounds]) expect(change).not.toHaveBeenCalled();
  });
  it("discards a stale aborted response after a later catalog refresh has updated the same source", async () => {
    const target = map(); const old = new AbortController(); let release!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { release = resolve; });
    const data = { type: "FeatureCollection", features: [], release: 3 };
    const pending = loadCoveredCountriesLayer(target, old.signal, vi.fn<typeof fetch>().mockReturnValue(delayed));
    old.abort(); await loadCoveredCountriesLayer(target, undefined, vi.fn<typeof fetch>().mockResolvedValue(Response.json(data)));
    release(Response.json({ type: "FeatureCollection", features: [], release: 2 })); await pending;
    expect(target.setData).toHaveBeenCalledOnce(); expect(target.setData).toHaveBeenCalledWith(data);
  });
});

describe("reviewed country search aliases", () => {
  it.each([["UK", "GB", 30], ["Turkey", "TR", 30], ["Kosova", "XK", 6], ["Kosovë", "XK", 6]] as const)("finds all destinations in %s without changing exact-name ranking", (query, country, count) => {
    const matches = searchLocationSummaries(catalogLocationsV3, null, query, 679);
    expect(matches.filter(({ location }) => location.countryCode === country)).toHaveLength(count);
    expect(matches.filter(({ location }) => location.countryCode === country).map(({ location }) => location.id).sort())
      .toEqual(catalogLocationsV3.filter(({ countryCode }) => countryCode === country).map(({ id }) => id).sort());
  });
  it.each([["Paris", "fr-paris"], ["London", "gb-london"], ["Pristina", "xk-pristina"]])("keeps exact destination%s first", (name, id) => {
    expect(searchLocationSummaries(catalogLocationsV3, null, name)[0].location.id).toBe(id);
  });
});
