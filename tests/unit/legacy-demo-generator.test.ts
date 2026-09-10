import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CompleteSnapshotV10Schema } from "@/lib/snapshot-validation";
import release2 from "../../data/catalog-releases/2.json";

const require = createRequire(import.meta.url);
describe("frozen legacy demo generator", () => {
  it("generates V10 with exact503 destinations and28 country partitions from current private state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "travelcanary-legacy-demo-"));
    const canonicalPath = resolve("public/demo-snapshot.json"); const canonicalBefore = await readFile(canonicalPath);
    try {
      await mkdir(join(directory, "public"));
      execFileSync(process.execPath, ["--import", require.resolve("tsx"), resolve("scripts/generate-demo.ts")], {
        cwd: directory, env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") }, stdio: "pipe", timeout: 15000,
      });
      const output = JSON.parse(await readFile(join(directory, "public/demo-snapshot.json"), "utf8"));
      const snapshot = CompleteSnapshotV10Schema.parse(output);
      expect(snapshot.schemaVersion).toBe(10); expect(snapshot.catalogVersion).toBe(2);
      expect(Object.keys(snapshot.locations).sort()).toEqual([...release2.locationIds].sort());
      const countries = [...new Set(release2.locationIds.map((id) => id.slice(0, 2).toUpperCase()))].sort();
      expect(countries).toHaveLength(28);
      for (const id of ["meteoalarm", "eea-aqi", "national-civil-alerts"] as const) {
        expect(Object.keys(snapshot.providers[id].partitions!).sort()).toEqual(countries);
        expect(Object.keys(output.providers[id].partitions).sort()).toEqual(countries);
      }
      expect(Object.values(snapshot.locations).some(({ hazards }) => hazards.length > 0)).toBe(true);
      expect(await readFile(canonicalPath)).toEqual(canonicalBefore);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
