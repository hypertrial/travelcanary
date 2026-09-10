import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobNotFoundError, type get, type head, type put } from "@vercel/blob";
import { catalogV2Paths, catalogV2SnapshotUrl, catalogV3Paths, catalogV3SnapshotUrl } from "@/lib/catalog-paths";
import { getPublicDataConfig } from "@/lib/config";
import { conditionsUrl } from "@/lib/use-conditions";
import { ConditionsV2Schema } from "@/lib/domain/conditions";

const austria = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/AT.json", "utf8")));
const origin = "https://unit.public.blob.vercel-storage.com";

afterEach(() => { vi.doUnmock("@/lib/data"); vi.resetModules(); });

function blobSpies() {
  return {
    getBlob: vi.fn<typeof get>().mockResolvedValue(null),
    headBlob: vi.fn<typeof head>().mockRejectedValue(new BlobNotFoundError()),
    putBlob: vi.fn<typeof put>().mockResolvedValue({
      url: `${origin}/conditions/v2/AT.json`, downloadUrl: `${origin}/conditions/v2/AT.json`,
      pathname: "conditions/v2/AT.json", contentType: "application/json", contentDisposition: "inline", etag: "new",
    }),
  };
}

async function futureCatalogPublisher() {
  vi.resetModules();
  vi.doMock("@/lib/data", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/lib/data")>();
    return { ...original, locations: [{ ...original.locations[0], id: "gb-london", countryCode: "GB" }] };
  });
  return (await import("@/lib/storage")).publishConditionsFiles;
}

describe("catalog release2 paths", () => {
  it("keeps the existing public and publication paths explicit", () => {
    expect(catalogV2Paths).toEqual({ catalog: "/locations.json", geography: "/covered-countries.geojson", snapshot: "latest.json", previousSnapshot: "previous.json", conditions: "conditions/v2/", demoSnapshot: "/demo-snapshot.json" });
    expect(getPublicDataConfig({})).toEqual({ mode: "demo", snapshotUrl: "/demo-snapshot.json", catalogVersion: 2 });
    expect(conditionsUrl("/demo-snapshot.json", "PT")).toBe("/conditions/v2/PT.json");
  });

  it.each(["/latest.json", "/tenant/a/latest.json"])("preserves the legacy snapshot directory for %s", (path) => {
    const url = `${origin}${path}`;
    const expectedConditions = `${origin}${path.slice(0, -"latest.json".length)}conditions/v2/PT.json`;
    expect(catalogV2SnapshotUrl(`  ${url}  `)?.href).toBe(url);
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: `  ${url}  ` })).toEqual({ mode: "live", snapshotUrl: url, catalogVersion: 2 });
    expect(conditionsUrl(url, "PT")).toBe(expectedConditions);
  });

  it.each([
    null, undefined, "", "   ", "/latest.json", "https://example.com/latest.json",
    "https://unit.public.blob.vercel-storage.com.evil.test/latest.json", `${origin.replace("https:", "http:")}/latest.json`,
    `https://user:secret@unit.public.blob.vercel-storage.com/latest.json`, `${origin}/latest.json?token=x`,
    `${origin}/latest.json#fragment`, `${origin}/not-latest.json`, `${origin}/previous.json`,
  ])("rejects an unsupported snapshot URL: %s", (url) => {
    expect(catalogV2SnapshotUrl(url)).toBeNull();
    expect(conditionsUrl(url ?? null, "PT")).toBeNull();
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: url ?? undefined })).toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 2 });
  });

  it.each(["../IE", "pt", "PT/IE", "P", "PT?x=1"])("rejects malformed conditions country %s", (country) => {
    expect(conditionsUrl(`${origin}/tenant/a/latest.json`, country)).toBeNull();
    expect(conditionsUrl("/demo-snapshot.json", country)).toBeNull();
  });
});

describe("frozen catalog2 conditions publication", () => {
  it("publishes a valid single legacy country when the active catalog contains only a future country", async () => {
    const publish = await futureCatalogPublisher();
    const blob = blobSpies();
    await expect(publish([austria], "test-token", blob)).resolves.toEqual({ published: ["AT"], unchanged: [], failed: [] });
    expect(blob.putBlob).toHaveBeenCalledTimes(1);
    expect(blob.putBlob).toHaveBeenCalledWith("conditions/v2/AT.json", JSON.stringify(austria), expect.objectContaining({ access: "public", allowOverwrite: false }));
  });

  it.each(["missing", "extra", "same-count substitution", "future country", "duplicate country"] as const)("rejects %s before reading or writing blobs", async (kind) => {
    const publish = await futureCatalogPublisher();
    const file = structuredClone(austria);
    const id = Object.keys(file.locations)[0];
    if (kind === "missing") delete file.locations[id];
    if (kind === "extra" || kind === "same-count substitution") file.locations["at-future-place"] = file.locations[id];
    if (kind === "same-count substitution") {
      delete file.locations[id];
      expect(Object.keys(file.locations)).toHaveLength(Object.keys(austria.locations).length);
    }
    if (kind === "future country") {
      file.countryCode = "GB";
      file.locations = { "gb-london": file.locations[id] };
    }
    // Ensure the identity guard, rather than a malformed conditions record, rejects it.
    expect(ConditionsV2Schema.safeParse(file).success).toBe(true);
    const blob = blobSpies();
    await expect(publish(kind === "duplicate country" ? [file, file] : [file], "test-token", blob)).rejects.toThrow(kind === "duplicate country" ? /Duplicate conditions country/ : /catalog mismatch/);
    expect(blob.getBlob).not.toHaveBeenCalled();
    expect(blob.headBlob).not.toHaveBeenCalled();
    expect(blob.putBlob).not.toHaveBeenCalled();
  });
});


describe("catalog release3 path isolation", () => {
  it("uses the explicitly versioned namespace without changing active config", () => {
    expect(catalogV3Paths).toEqual({ catalog: "/catalogs/3/locations.json", geography: "/catalogs/3/covered-countries.geojson", snapshot: "catalogs/3/latest.json", previousSnapshot: "catalogs/3/previous.json", conditions: "catalogs/3/conditions/v3/", demoSnapshot: "/catalogs/3/demo-snapshot.json" });
    const url = `${origin}/catalogs/3/latest.json`;
    expect(catalogV3SnapshotUrl(`  ${url}  `)?.href).toBe(url);
    expect(catalogV2SnapshotUrl(url)).toBeNull();
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: url })).toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 2 });
  });

  it.each(["/catalogs/2/latest.json", "/catalogs/4/latest.json", "/tenant/catalogs/3/latest.json"])("reserves future or nested namespaces from legacy readers: %s", (path) => {
    expect(catalogV2SnapshotUrl(`${origin}${path}`)).toBeNull();
    expect(catalogV3SnapshotUrl(`${origin}${path}`)).toBeNull();
  });

  it.each([null, undefined, "", "/catalogs/3/latest.json", `${origin}/latest.json`, `${origin}/catalogs/3/previous.json`,
    `${origin}/catalogs/3/latest.json?x=1`, `${origin}/catalogs/3/latest.json#hash`,
    "https://user:secret@unit.public.blob.vercel-storage.com/catalogs/3/latest.json",
    "http://unit.public.blob.vercel-storage.com/catalogs/3/latest.json",
    "https://unit.public.blob.vercel-storage.com.evil.test/catalogs/3/latest.json"])("rejects untrusted or wrong-release URL %s", (url) => {
    expect(catalogV3SnapshotUrl(url)).toBeNull();
  });
});
