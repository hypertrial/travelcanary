import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEAVY_VITEST_FILES,
  assertCleanTree,
  catalogHtmlMatches,
  distDirForCatalog,
  elapsed,
  looksLikeNextDev,
  run,
  runParallel,
  serializeEvidence,
} from "../../scripts/check";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function initGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "travelcanary-verify-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "verify@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Verify"], { cwd: dir });
  writeFileSync(path.join(dir, "README"), "ok\n");
  execFileSync("git", ["add", "README"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("verification coordinator", () => {
  it("uses isolated catalog output directories", () => {
    expect(distDirForCatalog(2)).toBe(".next-c2");
    expect(distDirForCatalog(3)).toBe(".next-c3");
    expect(() => distDirForCatalog(1)).toThrow(/Unsupported catalog version/);
  });

  it("isolates raster, generator, and long catalog-capacity tests in the heavy pool", () => {
    expect(HEAVY_VITEST_FILES).toEqual([
      "tests/unit/effis.test.ts",
      "tests/unit/firms.test.ts",
      "tests/unit/context-feeds.test.ts",
      "tests/unit/catalog3-geography.test.ts",
      "tests/unit/catalog3-demo.test.ts",
      "tests/unit/catalog3-conditions-projection.test.ts",
      "tests/unit/catalog3-conditions-serialization.test.ts",
      "tests/unit/catalog3-production-verification.test.ts",
      "tests/unit/catalog-publication.test.ts",
      "tests/unit/legacy-demo-generator.test.ts",
      "tests/unit/avalanche-mapping.test.ts",
      "tests/unit/europe-expansion-capacity.test.ts",
      "tests/unit/europe-populated-capacity.test.ts",
      "tests/unit/warning-expansion.test.ts",
    ]);
  });

  it("allows a dirty tree only when VERIFY_ALLOW_DIRTY=1", () => {
    expect(() => assertCleanTree({ VERIFY_ALLOW_DIRTY: "1" })).not.toThrow();
  });

  it("refuses a dirty git tree for exact-SHA full verification", () => {
    const dir = initGitRepo();
    writeFileSync(path.join(dir, "dirty.txt"), "dirty\n");
    expect(() => assertCleanTree({}, dir)).toThrow(/clean git tree/);
  });

  it("matches catalog metadata and rejects Next.js development chrome", () => {
    expect(catalogHtmlMatches(`<meta name="travelcanary-catalog-version" content="2">`, 2)).toBe(true);
    expect(catalogHtmlMatches(`<meta name="travelcanary-catalog-version" content="3">`, 2)).toBe(false);
    expect(looksLikeNextDev(`<button aria-label="Open Next.js Dev Tools">`)).toBe(true);
    expect(looksLikeNextDev(`<html><body>TravelCanary</body></html>`)).toBe(false);
  });

  it("kills remaining child processes when a parallel lane fails", async () => {
    const started = performance.now();
    await expect(runParallel([
      () => run("sleep", ["8"], { name: "sleep-8", stdio: "ignore" }),
      () => run("false", [], { name: "fail-now", stdio: "ignore" }),
    ])).rejects.toThrow(/fail-now/);
    expect(elapsed(started)).toBeLessThan(3000);
  });

  it("serializes exact-SHA verification evidence", () => {
    const evidence = serializeEvidence("fast", performance.now());
    expect(evidence.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.dirty).toBeTypeOf("boolean");
    expect(evidence.host).toBeTruthy();
    expect(evidence.os).toMatch(/Darwin|Linux/);
    expect(evidence.arch).toMatch(/arm64|x64/);
    expect(evidence.node).toMatch(/^v\d+/);
    expect(evidence.npm).toMatch(/^\d+\./);
    expect(evidence.playwright).toMatch(/^\d+\./);
    expect(evidence.mode).toBe("fast");
    expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
  });
});
