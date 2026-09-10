import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ConditionsV2Schema, emptyConditions } from "@/lib/domain/conditions";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { conditionsUrl, loadConditions } from "@/lib/use-conditions";
import release3 from "../../data/catalog-releases/3.json";

const origin = "https://contract-client.public.blob.vercel-storage.com";
const legacy = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/AT.json", "utf8")));
const current = ConditionsV3Schema.parse({ ...legacy, schemaVersion: 3, catalogVersion: 3 });
const ids = Object.keys(legacy.locations);
const legacyUrl = `${origin}/conditions/v2/AT.json`;
const currentUrl = `${origin}/catalogs/3/conditions/v3/AT.json`;

describe("catalog conditions reader isolation", () => {
  it("derives versioned country files from the matching live and demo snapshot namespace", () => {
    expect(conditionsUrl(`${origin}/catalogs/3/latest.json`, "GB")).toBe(`${origin}/catalogs/3/conditions/v3/GB.json`);
    expect(conditionsUrl("/catalogs/3/demo-snapshot.json", "GB")).toBe("/catalogs/3/conditions/v3/GB.json");
    expect(conditionsUrl(`${origin}/latest.json`, "AT")).toBe(legacyUrl);
    expect(conditionsUrl("/demo-snapshot.json", "AT")).toBe("/conditions/v2/AT.json");
  });

  it("uses only catalog3 conditions when explicitly pairing its roster with a legacy snapshot", () => {
    expect(conditionsUrl(`${origin}/tenant/latest.json`, "GB", 3)).toBe(`${origin}/catalogs/3/conditions/v3/GB.json`);
    expect(conditionsUrl("/demo-snapshot.json", "GB", 3)).toBe("/catalogs/3/conditions/v3/GB.json");
  });

  it("loads catalog3 conditions through the self-hosted live namespace", async () => {
    const url = conditionsUrl("/live/catalogs/3/latest.json", "GB", 3)!;
    const locationIds = release3.locationIds.filter((id) => id.startsWith("gb-"));
    const file = ConditionsV3Schema.parse({ ...current, countryCode: "GB", sources: {}, sourceHealth: {}, locations: Object.fromEntries(locationIds.map((id) => [id, emptyConditions()])) });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(file));
    await expect(loadConditions(url, "GB", locationIds, fetchMock, 3)).resolves.toEqual(file);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.anything());
  });

  it.each([2, 3] as const)("rejects explicit expected release%s mismatch before any HTTP or cache return", async (expected) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(loadConditions(expected === 2 ? currentUrl : legacyUrl, "AT", ids, fetchMock, expected)).rejects.toThrow(/namespace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["/catalogs/4/conditions/v3/AT.json", "/catalogs/3/conditions/v2/AT.json", "/catalogs/3/conditions/v3/GB.json"])("rejects reserved or mismatched namespace before HTTP: %s", async (path) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(loadConditions(`${origin}${path}`, "AT", ids, fetchMock)).rejects.toThrow(/namespace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates cached legacy and current files for the same country and exact same IDs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => Response.json(String(url).includes("catalogs/3/") ? current : legacy));
    const [old, next] = await Promise.all([loadConditions(legacyUrl, "AT", ids, fetchMock), loadConditions(currentUrl, "AT", ids, fetchMock)]);
    expect(old).toEqual(legacy); expect(next).toEqual(current); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await loadConditions(legacyUrl, "AT", ids, fetchMock)).toEqual(legacy);
    expect(await loadConditions(currentUrl, "AT", ids, fetchMock)).toEqual(current);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([2, 3] as const)("rejects the other wire version at a release%s URL even when country IDs match", async (version) => {
    const url = `https://mismatch${version}.public.blob.vercel-storage.com/${version === 3 ? "catalogs/3/conditions/v3" : "conditions/v2"}/AT.json`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(version === 3 ? legacy : current));
    await expect(loadConditions(url, "AT", ids, fetchMock)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps missing new-country conditions unavailable, then retries their own exact file without a legacy fallback", async () => {
    const url = `${origin}/catalogs/3/conditions/v3/GB.json`;
    const locationIds = release3.locationIds.filter((id) => id.startsWith("gb-"));
    const file = ConditionsV3Schema.parse({ ...current, countryCode: "GB", sources: {}, sourceHealth: {}, locations: Object.fromEntries(locationIds.map((id) => [id, emptyConditions()])) });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("missing", { status: 404 })).mockResolvedValueOnce(Response.json(file));
    await expect(loadConditions(url, "GB", locationIds, fetchMock)).rejects.toThrow();
    await expect(loadConditions(url, "GB", locationIds, fetchMock)).resolves.toEqual(file);
    expect(fetchMock.mock.calls.map(([requested]) => requested)).toEqual([url, url]);
  });
});
