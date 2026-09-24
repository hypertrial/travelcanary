import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPublicationSnapshot } from "@/lib/publication-client";
import { loadConditions } from "@/lib/use-conditions";

const pointerUrl = "http://localhost/catalogs/3/publication/latest.json";
const pointer = JSON.parse(readFileSync(resolve("public/catalogs/3/publication/latest.json"), "utf8")) as {
  manifestPath: string; manifestSha256: string; publishedAt: string;
};
const manifest = JSON.parse(readFileSync(resolve("public", pointer.manifestPath), "utf8")) as {
  snapshot: { path: string }; conditions: Array<{ countryCode: string; path: string; sha256: string; bytes: number }>;
};

function fixtureFetch(requests: string[], change?: (path: string, body: string) => string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.slice(1);
    requests.push(path);
    const body = readFileSync(resolve("public", path), "utf8");
    return new Response(change?.(path, body) ?? body);
  }) as typeof fetch;
}

describe("verified publication client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the snapshot's verified country reference without another pointer or manifest request", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost/", origin: "http://localhost" } });
    const requests: string[] = [];
    const fetchFixture = fixtureFetch(requests);
    const loaded = await loadPublicationSnapshot(pointerUrl, fetchFixture);
    expect(loaded.generation).toBe(pointer.manifestSha256);
    expect(loaded.publishedAt).toBe(pointer.publishedAt);
    expect(loaded.snapshot.catalogVersion).toBe(3);
    const austria = manifest.conditions.find(({ countryCode }) => countryCode === "AT")!;
    expect(loaded.conditionsByCountry.AT).toEqual({
      url: `http://localhost/${austria.path}`,
      reference: austria,
    });
    expect(requests).toEqual(["catalogs/3/publication/latest.json", pointer.manifestPath, manifest.snapshot.path]);
    const ids = Object.keys(JSON.parse(readFileSync(resolve("public", austria.path), "utf8")).locations);
    await loadConditions(loaded.conditionsByCountry.AT.url, "AT", ids, fetchFixture, 3, loaded.conditionsByCountry.AT.reference);
    expect(requests).toEqual(["catalogs/3/publication/latest.json", pointer.manifestPath, manifest.snapshot.path, austria.path]);
  });

  it("rejects tampered manifest and snapshot bytes before exposing references", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost/", origin: "http://localhost" } });
    for (const path of [pointer.manifestPath, manifest.snapshot.path]) {
      const fetchFixture = fixtureFetch([], (requested, body) => requested === path ? `${body} ` : body);
      await expect(loadPublicationSnapshot(pointerUrl, fetchFixture)).rejects.toThrow(/digest|size|large/i);
    }
  });

  it("verifies the selected immutable country object against the accepted reference", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost/", origin: "http://localhost" } });
    const loaded = await loadPublicationSnapshot(pointerUrl, fixtureFetch([]));
    const austria = loaded.conditionsByCountry.AT;
    const ids = Object.keys(JSON.parse(readFileSync(resolve("public", austria.reference.path), "utf8")).locations);
    const altered = fixtureFetch([], (path, body) => path === austria.reference.path ? ` ${body.slice(1)}` : body);
    await expect(loadConditions(`${austria.url}?tampered=1`, "AT", ids, altered, 3, austria.reference)).rejects.toThrow(/digest mismatch/);
  });

  it("rechecks a changed digest reference even when the immutable URL was cached", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost/", origin: "http://localhost" } });
    const loaded = await loadPublicationSnapshot(pointerUrl, fixtureFetch([]));
    const austria = loaded.conditionsByCountry.AT;
    const ids = Object.keys(JSON.parse(readFileSync(resolve("public", austria.reference.path), "utf8")).locations);
    const requests: string[] = [];
    const fetchFixture = fixtureFetch(requests);
    const url = `${austria.url}?reference-check=1`;
    await loadConditions(url, "AT", ids, fetchFixture, 3, austria.reference);
    await expect(loadConditions(url, "AT", ids, fetchFixture, 3, { ...austria.reference, sha256: "0".repeat(64) })).rejects.toThrow(/digest mismatch/);
    expect(requests).toEqual([austria.reference.path, austria.reference.path]);
  });
});
