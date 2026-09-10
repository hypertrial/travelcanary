import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConditionsV3Schema, SnapshotV11Schema } from "@/lib/domain/catalog-public";
import { ConditionsV2Schema } from "@/lib/domain/conditions";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
import links from "../../data/country-information-links.json";

const require = createRequire(import.meta.url);
describe("catalog3 deterministic demonstration artifacts", () => {
  it("generates and checks all46 outputs in a temporary directory, preserving legacy evidence and source files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "travelcanary-demo3-"));
    const originalDemo = await readFile("public/demo-snapshot.json"); const legacy = JSON.parse(originalDemo.toString());
    const countries = [...new Set(release2.locationIds.map((id) => id.slice(0, 2).toUpperCase()))];
    const originals = new Map(await Promise.all(countries.map(async (country) => [country, await readFile(`public/conditions/v2/${country}.json`)] as const)));
    try {
      await mkdir(join(directory, "public")); await cp("public/demo-snapshot.json", join(directory, "public/demo-snapshot.json"));
      await cp("public/conditions/v2", join(directory, "public/conditions/v2"), { recursive: true });
      const command = ["--import", require.resolve("tsx"), resolve("scripts/generate-demo-v3.ts")];
      const options = { cwd: directory, env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") }, stdio: "pipe" as const, timeout: 15000 };
      execFileSync(process.execPath, command, options); execFileSync(process.execPath, [...command, "--check"], options);
      const snapshot = SnapshotV11Schema.parse(JSON.parse(await readFile(join(directory, "public/catalogs/3/demo-snapshot.json"), "utf8")));
      expect(Object.keys(snapshot.locations).sort()).toEqual([...release3.locationIds].sort());
      for (const id of release2.locationIds) expect(snapshot.locations[id]).toEqual(legacy.locations[id]);
      for (const id of release3.locationIds.filter((id) => !release2.locationIds.includes(id))) expect(snapshot.locations[id]).toMatchObject({ level: "UNKNOWN", updatePending: true, hazards: [] });
      const filenames = await readdir(join(directory, "public/catalogs/3/conditions/v3")); expect(filenames).toHaveLength(45);
      const ignoredTimes = new Set(["checkedAt", "sourceUpdatedAt", "startAt", "expiresAt", "observedAt", "occurredAt"]);
      const withoutTimes = (value: unknown) => JSON.parse(JSON.stringify(value, (key, field) => ignoredTimes.has(key) ? undefined : field));
      for (const name of filenames) {
        const file = ConditionsV3Schema.parse(JSON.parse(await readFile(join(directory, "public/catalogs/3/conditions/v3", name), "utf8")));
        expect(file.generatedAt).toBe(snapshot.generatedAt); expect(file.producerCommitSha).toBeNull();
        const original = originals.get(file.countryCode);
        if (original) {
          expect(withoutTimes(file.locations)).toEqual(withoutTimes(ConditionsV2Schema.parse(JSON.parse(original.toString())).locations));
          expect((await readFile(join(directory, "public/conditions/v2", name))).equals(original)).toBe(true);
        } else for (const entry of Object.values(file.locations)) expect(entry.limitations).toEqual(["update-pending"]);
      }
      expect((await readFile(join(directory, "public/demo-snapshot.json"))).equals(originalDemo)).toBe(true);
      expect((await readFile("public/demo-snapshot.json")).equals(originalDemo)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 40_000);

  it("keeps new-country official context links explicitly scoped and HTTPS-only", () => {
    const addedCountries = [...new Set(release3.locationIds.filter((id) => !release2.locationIds.includes(id)).map((id) => id.slice(0, 2).toUpperCase()))].sort();
    expect(Object.keys(links).sort()).toEqual(addedCountries);
    for (const entries of Object.values(links)) {
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) { const url = new URL(entry.url); expect(url.protocol).toBe("https:"); expect(url.username).toBe(""); expect(url.password).toBe(""); expect(entry.label.trim().length).toBeGreaterThan(0); }
    }
  });
});
