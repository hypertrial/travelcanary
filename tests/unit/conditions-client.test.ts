import { describe, expect, it, vi } from "vitest";
import { conditionsUrl, loadConditions } from "@/lib/use-conditions";
import { buildConditionsFiles } from "@/lib/conditions/state";
import { createEmptyState } from "@/lib/risk";

const now = new Date("2026-08-31T12:00:00Z");
const files = buildConditionsFiles(createEmptyState(now), now, {});
describe("bounded country conditions client", () => {
  it("allows only same-store public files or the explicit demo", () => {
    expect(conditionsUrl("https://unit.public.blob.vercel-storage.com/latest.json", "PT")).toBe("https://unit.public.blob.vercel-storage.com/conditions/v2/PT.json");
    expect(conditionsUrl("/demo-snapshot.json", "PT")).toBe("/conditions/v2/PT.json");
    expect(conditionsUrl("/live/catalogs/3/latest.json", "PT", 3)).toBe("/live/catalogs/3/conditions/v3/PT.json");
    for (const url of ["https://evil.test/latest.json", "https://unit.public.blob.vercel-storage.com/latest.json?secret=x", "http://unit.public.blob.vercel-storage.com/latest.json"]) expect(conditionsUrl(url, "PT")).toBeNull();
    expect(conditionsUrl("/demo-snapshot.json", "../IE")).toBeNull();
  });
  it("deduplicates concurrent loads and evicts beyond four cached countries", async () => {
    const fetchMock = vi.fn(async (url: string) => Response.json(files.find(({ countryCode }) => url.endsWith(`${countryCode}.json`))));
    const first = files[0]; const ids = Object.keys(first.locations); const url = `/cache-test/${first.countryCode}.json`;
    await Promise.all([loadConditions(url, first.countryCode, ids, fetchMock as typeof fetch), loadConditions(url, first.countryCode, ids, fetchMock as typeof fetch)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const file of files.slice(1, 5)) await loadConditions(`/cache-test/${file.countryCode}.json`, file.countryCode, Object.keys(file.locations), fetchMock as typeof fetch);
    await loadConditions(url, first.countryCode, ids, fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it("rejects oversized and mismatched files, and allows retry after failure", async () => {
    const file = files[0]; const ids = Object.keys(file.locations);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("x".repeat(128 * 1024 + 1)))
      .mockResolvedValueOnce(Response.json({ ...file, locations: {} })).mockResolvedValueOnce(Response.json(file));
    await expect(loadConditions("/retry.json", file.countryCode, ids, fetchMock)).rejects.toThrow(/too large/);
    await expect(loadConditions("/retry.json", file.countryCode, ids, fetchMock)).rejects.toThrow(/catalog/);
    await expect(loadConditions("/retry.json", file.countryCode, ids, fetchMock)).resolves.toEqual(file);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
