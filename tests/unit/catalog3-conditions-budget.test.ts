import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobNotFoundError, type get, type head, type put } from "@vercel/blob";
import budgets from "../../data/catalog-releases/3-conditions-budgets.json";
import release3 from "../../data/catalog-releases/3.json";
import { catalog3ConditionsCountryLimit } from "@/lib/conditions/publication-budget";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { CONDITIONS_COUNTRY_LIMIT, CONDITIONS_TOTAL_LIMIT, emptyConditions } from "@/lib/domain/conditions";
import { conditionAttribution } from "@/lib/conditions/sources";
import { publishCatalog3ConditionsFiles } from "@/lib/storage";

const now = new Date("2026-09-08T22:00:00Z");
const countries = [...new Set(release3.locationIds.map((id) => id.slice(0, 2).toUpperCase()))].sort();
afterEach(() => vi.useRealTimers());
function files(at = now) {
  return countries.map((countryCode) => ConditionsV3Schema.parse({ schemaVersion: 3, catalogVersion: 3, countryCode,
    generatedAt: at.toISOString(), producerCommitSha: "b".repeat(40), sources: {}, sourceHealth: {},
    locations: Object.fromEntries(release3.locationIds.filter((id) => id.startsWith(`${countryCode.toLowerCase()}-`)).map((id) => [id, emptyConditions()])) }));
}
function atByteLimit(file: ReturnType<typeof files>[number], byteLimit: number) {
  file.sources["open-meteo-weather"] = { ...conditionAttribution("open-meteo-weather"), notice: "Marine 🌊 context" };
  const source = file.sources["open-meteo-weather"]!;
  for (const [field, max] of [["notice", 500], ["name", 120], ["license", 120], ["officialUrl", 1000], ["licenseUrl", 1000]] as const) {
    const remaining = byteLimit - Buffer.byteLength(serializeCatalog3Conditions(file));
    if (remaining > 0) source[field] += "a".repeat(Math.min(remaining, max - source[field].length));
  }
  expect(Buffer.byteLength(serializeCatalog3Conditions(file))).toBe(byteLimit);
  return file;
}
function blobStore() {
  const bodies = new Map<string, string>(); let failPath: string | null = null;
  const pathOf = (path: string) => path.startsWith("https:") ? new URL(path).pathname.slice(1) : path;
  const metadata = (path: string) => ({ url: `https://unit.public.blob.vercel-storage.com/${path}`, downloadUrl: `https://unit.public.blob.vercel-storage.com/${path}`,
    pathname: path, contentDisposition: "inline", cacheControl: "60", uploadedAt: now, etag: "version", contentType: "application/json", size: Buffer.byteLength(bodies.get(path) || "") });
  const headBlob = vi.fn<typeof head>().mockImplementation(async (path) => { const key = pathOf(path); if (!bodies.has(key)) throw new BlobNotFoundError(); return metadata(key); });
  const getBlob = vi.fn<typeof get>().mockImplementation(async (path) => { const key = pathOf(path); return { statusCode: 200, stream: new Blob([bodies.get(key)!]).stream(), headers: new Headers(), blob: metadata(key) }; });
  const putBlob = vi.fn<typeof put>().mockImplementation(async (path, body) => { if (path === failPath) throw new Error("controlled publication failure"); if (typeof body !== "string") throw new Error("Expected JSON"); bodies.set(path, body); return metadata(path); });
  return { bodies, headBlob, getBlob, putBlob, now, fail(path: string | null) { failPath = path; } };
}

describe("immutable catalog3 country wire allocations", () => {
  it("allocates every frozen country exactly once and bounds every mixed generation by the sum of fixed allocations", () => {
    expect(Object.keys(budgets.countryBytes).sort()).toEqual(countries);
    expect(Object.values(budgets.countryBytes).reduce((sum, bytes) => sum + bytes, 0)).toBe(1_566_976);
    expect(Object.values(budgets.countryBytes).reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(CONDITIONS_TOTAL_LIMIT);
    for (const [country, bytes] of Object.entries(budgets.countryBytes)) {
      expect(bytes).toBeGreaterThan(0); expect(Number.isInteger(bytes)).toBe(true); expect(bytes).toBeLessThanOrEqual(CONDITIONS_COUNTRY_LIMIT);
      expect(catalog3ConditionsCountryLimit(country as keyof typeof budgets.countryBytes)).toBe(bytes);
    }
  });

  it("accepts exactly the country UTF8 byte limit while one extra byte rejects the whole generation before requests", async () => {
    const input = files(); const va = input.find(({ countryCode }) => countryCode === "VA")!;
    atByteLimit(va, budgets.countryBytes.VA); const before = structuredClone(input); const blob = blobStore();
    expect(serializeCatalog3Conditions(va).length).toBeLessThan(budgets.countryBytes.VA);
    expect(await publishCatalog3ConditionsFiles(input, "token", blob)).toMatchObject({ published: countries, failed: [] });
    expect(blob.bodies.get("catalogs/3/conditions/v3/VA.json")).toBe(serializeCatalog3Conditions(va));
    expect(input).toEqual(before);
    va.sources["open-meteo-weather"]!.licenseUrl += "a";
    expect(ConditionsV3Schema.safeParse(va).success).toBe(true);
    expect(Buffer.byteLength(serializeCatalog3Conditions(va))).toBe(budgets.countryBytes.VA + 1);
    const untouched = blobStore(); await expect(publishCatalog3ConditionsFiles(input, "token", untouched)).rejects.toThrow(/size/);
    expect(untouched.headBlob).not.toHaveBeenCalled(); expect(untouched.getBlob).not.toHaveBeenCalled(); expect(untouched.putBlob).not.toHaveBeenCalled();
  });

  it("measures stored compact wire bytes rather than its larger normalized representation", async () => {
    const input = files(); const va = atByteLimit(input.find(({ countryCode }) => countryCode === "VA")!, budgets.countryBytes.VA);
    const wire = serializeCatalog3Conditions(va); expect(Buffer.byteLength(JSON.stringify(ConditionsV3Schema.parse(JSON.parse(wire))))).toBeGreaterThan(budgets.countryBytes.VA);
    const blob = blobStore(); blob.bodies.set("catalogs/3/conditions/v3/VA.json", wire);
    expect(await publishCatalog3ConditionsFiles(input, "token", blob)).toMatchObject({ unchanged: ["VA"], failed: [] });
    expect(blob.putBlob.mock.calls.some(([path]) => path.endsWith("/VA.json"))).toBe(false);
  });

  it("rejects an oversized stored wire even when its normalized content fits, and retains it for repair", async () => {
    vi.useFakeTimers(); const input = files(); const blob = blobStore(); const va = input.find(({ countryCode }) => countryCode === "VA")!;
    const path = "catalogs/3/conditions/v3/VA.json"; const small = serializeCatalog3Conditions(va);
    const wire = small + " ".repeat(budgets.countryBytes.VA + 1 - Buffer.byteLength(small)); blob.bodies.set(path, wire);
    expect(ConditionsV3Schema.parse(JSON.parse(wire))).toEqual(va);
    const pending = publishCatalog3ConditionsFiles(input, "token", blob); await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ failed: [{ countryCode: "VA", code: "read_failed" }] });
    expect(blob.bodies.get(path)).toBe(wire); expect(blob.putBlob.mock.calls.some(([key]) => key === path)).toBe(false);
  });

  it("keeps a partial publication within fixed country limits and repairs only the older failed generation", async () => {
    const blob = blobStore(); const old = files(new Date(now.getTime() - 60000));
    for (const file of old) blob.bodies.set(`catalogs/3/conditions/v3/${file.countryCode}.json`, serializeCatalog3Conditions(file));
    const input = files(); atByteLimit(input.find(({ countryCode }) => countryCode === "VA")!, budgets.countryBytes.VA);
    blob.fail("catalogs/3/conditions/v3/MC.json"); const pending = publishCatalog3ConditionsFiles(input, "token", blob);
    expect(await pending).toMatchObject({ failed: [{ countryCode: "MC", code: "write_failed" }] });
    const generations = new Set<string>(); let bytes = 0;
    for (const [path, body] of blob.bodies) {
      const file = ConditionsV3Schema.parse(JSON.parse(body)); generations.add(file.generatedAt); bytes += Buffer.byteLength(body);
      expect(Buffer.byteLength(body), path).toBeLessThanOrEqual(catalog3ConditionsCountryLimit(file.countryCode));
    }
    expect(generations.size).toBe(2); expect(bytes).toBeLessThanOrEqual(CONDITIONS_TOTAL_LIMIT);
    blob.fail(null); const replay = publishCatalog3ConditionsFiles(input, "token", blob);
    expect(await replay).toEqual({ published: ["MC"], unchanged: countries.filter((country) => country !== "MC"), failed: [] });
  });
});
