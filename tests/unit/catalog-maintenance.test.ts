import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotV11Schema } from "@/lib/domain/catalog-public";
import { CaptureCasesSchema } from "../../scripts/coverage-measurement";

const root = process.cwd();
const frozen = ["data/locations.json", "tests/fixtures/legacy-catalog-2/locations.json"];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("current catalog maintenance commands", () => {
  it("regenerates active artifacts while preserving frozen catalog inputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "travelcanary-maintenance-"));
    try {
      for (const path of ["data", "src", "scripts", "tests/fixtures/legacy-catalog-2"]) cpSync(path, join(directory, path), { recursive: true });
      for (const path of ["package.json", "tsconfig.json"]) cpSync(path, join(directory, path));
      symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
      const before = frozen.map((path) => digest(join(directory, path)));
      for (const command of ["data:metadata", "data:generate"]) {
        const result = spawnSync("npm", ["run", command], { cwd: directory, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(frozen.map((path) => digest(join(directory, path)))).toEqual(before);
      }
      expect(JSON.parse(readFileSync(join(directory, "public/catalogs/3/locations.json"), "utf8"))).toHaveLength(679);
      for (const script of ["generate-catalog.mjs", "update-catalog-metadata.mjs"]) {
        const result = spawnSync(process.execPath, [`scripts/${script}`], { cwd: directory, encoding: "utf8" });
        expect(result.status).toBe(1); expect(result.stderr).toMatch(/frozen/i);
        expect(frozen.map((path) => digest(join(directory, path)))).toEqual(before);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("captures incidents from current V11 and permits all 679 expected destinations", () => {
    const directory = mkdtempSync(join(tmpdir(), "travelcanary-capture-"));
    try {
      const snapshot = SnapshotV11Schema.parse(JSON.parse(readFileSync("public/catalogs/3/demo-snapshot.json", "utf8")));
      const hazard = Object.values(snapshot.locations).flatMap(({ hazards }) => hazards)[0];
      const evidence = hazard.evidence[0];
      const sample = { id: "current-capture", headline: hazard.headline, hazard: hazard.type, sourceUpdatedAt: evidence.sourceUpdatedAt,
        evidenceUrl: evidence.sourceUrl, locationIds: Object.entries(snapshot.locations).filter(([, state]) => state.hazards.some((item) =>
          item.headline === hazard.headline && item.type === hazard.type && item.evidence.some((source) =>
            source.sourceUrl === evidence.sourceUrl && source.sourceUpdatedAt === evidence.sourceUpdatedAt))).map(([id]) => id) };
      expect(CaptureCasesSchema.parse([{ ...sample, locationIds: Object.keys(snapshot.locations) }])[0].locationIds).toHaveLength(679);
      mkdirSync(join(directory, "inputs")); const cases = join(directory, "inputs/cases.json");
      const run = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/coverage-history.ts", "capture",
        "public/catalogs/3/demo-snapshot.json", cases], { cwd: root, encoding: "utf8" });
      writeFileSync(cases, JSON.stringify([sample])); const matched = run();
      expect(matched.status, matched.stderr).toBe(0);
      expect(JSON.parse(matched.stdout).cases[0]).toMatchObject({ missed: [], unexpected: [] });
      writeFileSync(cases, JSON.stringify([{ ...sample, evidenceUrl: "https://example.test/other-incident" }]));
      const missed = run(); expect(missed.status).toBe(1);
      expect(JSON.parse(missed.stdout).cases[0].missed).toEqual([...sample.locationIds].sort());
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
