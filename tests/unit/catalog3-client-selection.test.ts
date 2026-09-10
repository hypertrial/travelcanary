import { describe, expect, it, vi } from "vitest";
import { getPublicDataConfig } from "@/lib/config";
import { loadCoveredCountriesLayer, COVERED_COUNTRIES_LAYER } from "@/lib/map-presentation";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { searchLocationSummaries } from "@/lib/ui-presentation";

const origin = "https://unit.public.blob.vercel-storage.com";
describe("explicit catalog client selection", () => {
  it.each([undefined, "2", "3"])("selects the exact demo and live paths for version%s", (requested) => {
    const version = requested === "3" ? 3 : 2;
    const suffix = version === 3 ? "/catalogs/3" : "";
    expect(getPublicDataConfig({ NEXT_PUBLIC_CATALOG_VERSION: requested })).toEqual({ mode: "demo", catalogVersion: version, snapshotUrl: `${suffix}/demo-snapshot.json` });
    expect(getPublicDataConfig({ NEXT_PUBLIC_CATALOG_VERSION: requested, VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: `${origin}${suffix}/latest.json` }))
      .toEqual({ mode: "live", catalogVersion: version, snapshotUrl: `${origin}${suffix}/latest.json` });
  });
  it.each(["1", "4", "03", " 3", "3 ", "bogus"])("fails closed for invalid catalog selector %s even in demo mode", (version) => {
    expect(getPublicDataConfig({ NEXT_PUBLIC_CATALOG_VERSION: version, NEXT_PUBLIC_DATA_MODE: "demo" })).toMatchObject({ mode: "unavailable", snapshotUrl: null });
  });
  it.each([["2", "/catalogs/3/latest.json"], ["3", "/latest.json"], ["3", "/nested/catalogs/3/latest.json"], ["3", "/catalogs/4/latest.json"]])("rejects version%s with mismatched namespace%s", (version, path) => {
    expect(getPublicDataConfig({ NEXT_PUBLIC_CATALOG_VERSION: version, NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: `${origin}${path}` })).toMatchObject({ mode: "unavailable", snapshotUrl: null });
  });
});

describe("versioned map tint refresh", () => {
  function map() {
    const setData = vi.fn();
    return { setData, getLayer: vi.fn((id: string) => id === COVERED_COUNTRIES_LAYER ? ({ id } as never) : undefined),
      getSource: vi.fn(() => ({ type: "geojson", setData }) as never), addSource: vi.fn(), addLayer: vi.fn(),
      jumpTo: vi.fn(), easeTo: vi.fn(), flyTo: vi.fn(), fitBounds: vi.fn() };
  }
  it.each([2, 3] as const)("fetches version%s geography and replaces existing source data without changing camera", async (version) => {
    const target = map(); const data = { type: "FeatureCollection", features: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data)); const controller = new AbortController();
    await loadCoveredCountriesLayer(target, controller.signal, fetch, version);
    expect(fetch).toHaveBeenCalledWith(version === 3 ? "/catalogs/3/covered-countries.geojson" : "/covered-countries.geojson", { signal: controller.signal });
    expect(target.setData).toHaveBeenCalledWith(data); expect(target.addSource).not.toHaveBeenCalled(); expect(target.addLayer).not.toHaveBeenCalled();
    for (const change of [target.jumpTo, target.easeTo, target.flyTo, target.fitBounds]) expect(change).not.toHaveBeenCalled();
  });
  it("discards a stale aborted response after a later catalog refresh has updated the same source", async () => {
    const target = map(); const old = new AbortController(); let release!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { release = resolve; });
    const data = { type: "FeatureCollection", features: [], release: 3 };
    const pending = loadCoveredCountriesLayer(target, old.signal, vi.fn<typeof fetch>().mockReturnValue(delayed), 2);
    old.abort(); await loadCoveredCountriesLayer(target, undefined, vi.fn<typeof fetch>().mockResolvedValue(Response.json(data)), 3);
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
