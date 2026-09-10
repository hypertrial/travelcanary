import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { locations } from "@/lib/data";
import { locationPolygon } from "@/lib/geospatial";
import reviewed from "../../data/avalanche-report-region-mapping.json";
// @ts-expect-error JavaScript offline generator has no declaration file.
import { generateAvalancheMapping } from "../../scripts/generate-avalanche-report-mapping.mjs";

const date = "2026-08-31";
const collection = { type: "FeatureCollection", features: reviewed.mappings.map((mapping) => ({
  ...locationPolygon(locations.find(({ id }) => id === mapping.locationId)!),
  properties: { id: `${mapping.regionPrefixes[0]}fixture`, start_date: "2020-01-01" },
})) };
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("avalanche mapping regeneration", () => {
  it("preserves V2, all reviewed countries, disabled feed gates and provenance", () => {
    const output = generateAvalancheMapping(locations, [collection], reviewed, date);
    expect(output).toMatchObject({ schemaVersion: 2, partitions: reviewed.partitions, reviewedAt: reviewed.reviewedAt, urlTemplate: reviewed.urlTemplate, license: reviewed.license });
    expect(output.mappings.map(({ locationId }: { locationId: string }) => locationId).sort()).toEqual(reviewed.mappings.map(({ locationId }) => locationId).sort());
    for (const mapping of output.mappings) {
      expect(mapping.feedCodes).toEqual(reviewed.mappings.find(({ locationId }) => locationId === mapping.locationId)!.feedCodes);
      expect(mapping.regionPrefixes).toEqual(reviewed.mappings.find(({ locationId }) => locationId === mapping.locationId)!.regionPrefixes);
      expect(mapping.regionPrefixes.length).toBeGreaterThan(0);
      expect(mapping).not.toHaveProperty("regionIds");
    }
    expect(generateAvalancheMapping(locations, [collection], reviewed, date)).toEqual(output);
    expect(generateAvalancheMapping(locations, [collection], output, date)).toEqual(output);
  });

  it("rejects incomplete, stale, unreviewed or incompatible input instead of erasing mappings", () => {
    expect(() => generateAvalancheMapping(locations, [], reviewed, date)).toThrow(/FeatureCollections/);
    expect(() => generateAvalancheMapping(locations, [{ ...collection, features: [] }], reviewed, date)).toThrow(/refusing to erase/);
    expect(() => generateAvalancheMapping(locations, [collection], { ...reviewed, schemaVersion: 1 }, date)).toThrow(/V2/);
    expect(() => generateAvalancheMapping(locations, [{ ...collection, features: collection.features.map((feature) => ({ ...feature, properties: { ...feature.properties, end_date: date } })) }], reviewed, date)).toThrow(/refusing to erase/);
    expect(() => generateAvalancheMapping(locations, [collection], { ...reviewed, mappings: [{ locationId: "unknown", feedCodes: ["FI"], regionPrefixes: ["FI-"] }] }, date)).toThrow(/Invalid reviewed/);
  });

  it("writes an artifact accepted by the actual coverage generator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "travelcanary-avalanche-test-"));
    temporaryDirectories.push(directory);
    await cp(resolve("data"), join(directory, "data"), { recursive: true });
    await writeFile(join(directory, "regions.json"), JSON.stringify(collection));
    execFileSync(process.execPath, [resolve("scripts/generate-avalanche-report-mapping.mjs"), "regions.json"], { cwd: directory });
    execFileSync(process.execPath, [resolve("scripts/generate-coverage.mjs")], { cwd: directory });
    execFileSync(process.execPath, [resolve("scripts/generate-coverage.mjs"), "--check"], { cwd: directory });
    const output = JSON.parse(await readFile(join(directory, "data/avalanche-report-region-mapping.json"), "utf8"));
    expect(output.schemaVersion).toBe(2);
    expect(output.partitions).toEqual(reviewed.partitions);
    const before = await readFile(join(directory, "data/avalanche-report-region-mapping.json"), "utf8");
    await writeFile(join(directory, "regions.json"), JSON.stringify({ type: "FeatureCollection", features: [] }));
    expect(() => execFileSync(process.execPath, [resolve("scripts/generate-avalanche-report-mapping.mjs"), "regions.json"], { cwd: directory, stdio: "pipe" })).toThrow();
    expect(await readFile(join(directory, "data/avalanche-report-region-mapping.json"), "utf8")).toBe(before);
  });
});
