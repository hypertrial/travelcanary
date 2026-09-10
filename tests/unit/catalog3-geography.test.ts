import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { describe, expect, it } from "vitest";
import scope from "../../data/catalog-releases/3-geography.json";
import release from "../../data/catalog-releases/3.json";

async function geometry() { return JSON.parse(await readFile("public/catalogs/3/covered-countries.geojson", "utf8")) as FeatureCollection<Polygon | MultiPolygon, { countryCode: string }>; }
describe("reviewed offline catalog3 display geography", () => {
  it("replays the pinned input through the real --catalog3 --check generator with exact45 countries and untouched legacy bytes", async () => {
    const before = await readFile("public/covered-countries.geojson"); const input = await readFile(scope.input);
    expect(createHash("sha256").update(input).digest("hex")).toBe(scope.inputSha256);
    const output = execFileSync(process.execPath, [resolve("scripts/generate-covered-countries.mjs"), "--catalog", "3", "--check"], {
      cwd: process.cwd(), env: { ...process.env, NATURAL_EARTH_PATH: resolve(scope.input) }, stdio: "pipe", timeout: 15000,
    }).toString();
    expect(output).toContain("45 countries");
    const collection = await geometry(); const countries = [...new Set(release.locationIds.map((id) => id.slice(0, 2).toUpperCase()))].sort();
    expect(collection.features.map(({ properties }) => properties.countryCode).sort()).toEqual(countries);
    expect(collection.features).toHaveLength(45); expect((await readFile("public/covered-countries.geojson")).equals(before)).toBe(true);
  }, 20_000);

  it("retains nondegenerate microstates, separate Kosovo and Serbia, Norwegian mainland, and the Azores", async () => {
    const collection = await geometry(); const feature = (code: string) => collection.features.find(({ properties }) => properties.countryCode === code)!;
    for (const code of ["VA", "MC", "SM"]) {
      const shape = feature(code).geometry; const polygons = shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates;
      expect(polygons.length).toBeGreaterThan(0);
      for (const [outer] of polygons) {
        expect(new Set(outer.map((coordinate) => coordinate.join(","))).size).toBeGreaterThanOrEqual(3);
        expect(outer[0]).toEqual(outer.at(-1));
        const twiceArea = outer.slice(1).reduce((sum, [x, y], index) => sum + outer[index][0] * y - x * outer[index][1], 0);
        expect(Math.abs(twiceArea)).toBeGreaterThan(1e-12);
      }
    }
    expect(booleanPointInPolygon([21.1622, 42.6629], feature("XK"))).toBe(true);
    expect(booleanPointInPolygon([21.1622, 42.6629], feature("RS"))).toBe(false);
    expect(booleanPointInPolygon([20.46, 44.82], feature("RS"))).toBe(true);
    expect(booleanPointInPolygon([10.75, 59.91], feature("NO"))).toBe(true);
    for (const point of [[15.633, 78.223], [-8.417, 70.98]]) expect(booleanPointInPolygon(point, feature("NO"))).toBe(false);
    expect(booleanPointInPolygon([-25.5, 37.8], feature("PT"))).toBe(true);
    expect(booleanPointInPolygon([-31.21, 39.45], feature("PT"))).toBe(true);
  });

  it("rejects an unreviewed input before altering either geography artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "travelcanary-unreviewed-geometry-"));
    const expanded = await readFile("public/catalogs/3/covered-countries.geojson"); const legacy = await readFile("public/covered-countries.geojson");
    try {
      const unreviewed = join(directory, "boundaries.json"); await writeFile(unreviewed, `${await readFile(scope.input, "utf8")} `);
      let error: unknown;
      try { execFileSync(process.execPath, [resolve("scripts/generate-covered-countries.mjs"), "--catalog", "3", "--check"], { env: { ...process.env, NATURAL_EARTH_PATH: unreviewed }, stdio: "pipe", timeout: 15000 }); }
      catch (failure) { error = failure; }
      expect(String(error)).toContain("Unreviewed country geometry input");
      expect((await readFile("public/catalogs/3/covered-countries.geojson")).equals(expanded)).toBe(true); expect((await readFile("public/covered-countries.geojson")).equals(legacy)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
});
