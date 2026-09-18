import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConditionsV3Schema, SnapshotV11Schema } from "@/lib/domain/catalog-public";
import { PublicationManifestV1Schema, PublicationPointerV1Schema } from "@/lib/domain/publication";
import { publicationSha256 } from "@/lib/publication-store";
import release3 from "../../data/catalog-releases/3.json";
import links from "../../data/country-information-links.json";

const require = createRequire(import.meta.url);
describe("atomic Catalog 3 demo", () => {
  it("generates and verifies one pointer, one manifest, and46 immutable payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "travelcanary-demo3-"));
    try {
      const command = ["--import", require.resolve("tsx"), resolve("scripts/generate-demo-v3.ts")];
      const options = { cwd: directory, env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") }, stdio: "pipe" as const, timeout: 15_000 };
      execFileSync(process.execPath, command, options); execFileSync(process.execPath, [...command, "--check"], options);
      const read = (path: string) => readFile(join(directory, "public", path), "utf8");
      const pointer = PublicationPointerV1Schema.parse(JSON.parse(await read("catalogs/3/publication/latest.json")));
      const manifestBody = await read(pointer.manifestPath);
      expect(publicationSha256(manifestBody)).toBe(pointer.manifestSha256);
      const manifest = PublicationManifestV1Schema.parse(JSON.parse(manifestBody));
      const snapshotBody = await read(manifest.snapshot.path);
      expect(publicationSha256(snapshotBody)).toBe(manifest.snapshot.sha256);
      const snapshot = SnapshotV11Schema.parse(JSON.parse(snapshotBody));
      expect(Object.keys(snapshot.locations).sort()).toEqual([...release3.locationIds].sort());
      expect(manifest.conditions).toHaveLength(45);
      for (const reference of manifest.conditions) {
        const body = await read(reference.path);
        expect(publicationSha256(body)).toBe(reference.sha256);
        expect(ConditionsV3Schema.parse(JSON.parse(body)).countryCode).toBe(reference.countryCode);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 40_000);

  it("keeps new-country official context links explicitly scoped and HTTPS-only", () => {
    const countries = [...new Set(release3.locationIds.map((id) => id.slice(0, 2).toUpperCase()))];
    for (const [country, entries] of Object.entries(links)) {
      expect(countries).toContain(country); expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(new URL(entry.url).protocol).toBe("https:");
    }
  });
});
