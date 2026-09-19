import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import playwrightConfig from "../../playwright.config";
import { LocationStateSchema } from "../../src/lib/domain/schemas";

const PLAYWRIGHT_INSTALL = "npx --no-install playwright install --with-deps chromium webkit";

function stripYamlComment(line: string) {
  return line.replace(/(?:^|\s)#.*$/, "");
}

function uncommentedYaml(source: string) {
  return source.split(/\r?\n/).map(stripYamlComment).join("\n");
}

function workflowRunCommands(source: string) {
  const commands: string[] = [];
  const lines = uncommentedYaml(source).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const block = line.match(/^[\t ]+-?[\t ]*run:[\t ]*([|>])[+-]?[ \t]*$/);
    if (block) {
      const indent = line.match(/^[\t ]*/)?.[0].length ?? 0;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim() === "") { body.push(""); index += 1; continue; }
        const nextIndent = next.match(/^[\t ]*/)?.[0].length ?? 0;
        if (nextIndent <= indent) break;
        body.push(next.slice(indent + 2).trimEnd());
        index += 1;
      }
      index -= 1;
      commands.push(body.join("\n").trim());
      continue;
    }
    const single = line.match(/^[\t ]+-?[\t ]*run:[\t ]+(.+)$/);
    if (single) commands.push(single[1].trim());
  }
  return commands;
}

function workflowOnTriggers(source: string) {
  const lines = uncommentedYaml(source).split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:[\t ]*(?:\[.*\])?[\t ]*$/.test(line));
  if (start < 0) return [];
  const flow = lines[start].match(/^on:[\t ]*\[(.*)\][\t ]*$/);
  if (flow) return flow[1].split(",").map((part) => part.trim()).filter(Boolean);
  const triggers: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (!/^[\t ]/.test(line)) break;
    const key = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):/);
    if (key) triggers.push(key[1]);
  }
  return triggers;
}

function playwrightInstallBrowsers(command: string) {
  const match = command.match(/playwright install(?: --with-deps)?(.*)$/);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

function projectBrowserName(project: { use?: { browserName?: string; defaultBrowserType?: string } }) {
  return project.use?.browserName ?? project.use?.defaultBrowserType;
}

const VISUAL_GOLDEN_RATIOS = {
  "desktop-brand-lockup.png": 0.02,
  "desktop-control-rail.png": 0.02,
  "desktop-control-rail-high.png": 0.02,
  "desktop-control-rail-short.png": 0.02,
  "desktop-control-rail-unavailable.png": 0.02,
  "desktop-search-results.png": 0.02,
  "desktop-attention-popover.png": 0.02,
  "desktop-app-menu.png": 0.02,
  "mobile-brand-lockup.png": 0.02,
  "desktop-map-first.png": 0.03,
  "desktop-severe-drawer.png": 0.03,
  "desktop-normal-card.png": 0.03,
  "desktop-coverage-expanded.png": 0.03,
  "desktop-coverage-delayed.png": 0.03,
  "mobile-map-first.png": 0.03,
  "mobile-updates-unavailable.png": 0.03,
  "mobile-attention-sheet.png": 0.03,
  "mobile-severe-sheet.png": 0.03,
  "desktop-map-fallback.png": 0.03,
} as const;

function screenshotComparisons(source: string) {
  return [...source.matchAll(/toHaveScreenshot\(\s*"([^"]+)"\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g)].map((match) => {
    const ratioMatch = match[2]?.match(/maxDiffPixelRatio:\s*([0-9.]+)/);
    return { name: match[1]!, ratio: ratioMatch ? Number(ratioMatch[1]) : Number.NaN, options: match[2] ?? "" };
  });
}

function darwinVisualFlagExpression(helpersSource: string) {
  return helpersSource.match(/export const DARWIN_VISUAL_SNAPSHOTS = ([^;]+);/)?.[1]?.trim() ?? "";
}

function evaluateDarwinVisualFlag(expression: string, platform: string) {
  return Boolean(Function("process", `"use strict"; return (${expression});`)({ platform }));
}

function fileLevelDarwinVisualSkip(source: string) {
  const firstTest = source.search(/^test\(/m);
  if (firstTest < 0) return false;
  return /test\.skip\(\s*!DARWIN_VISUAL_SNAPSHOTS\b/.test(source.slice(0, firstTest));
}

function sliceBalancedBraceBody(source: string, openIndex: number) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return "";
}

function darwinVisualGateRanges(source: string) {
  const ranges: Array<{ start: number; end: number; body: string }> = [];
  const needle = "if (DARWIN_VISUAL_SNAPSHOTS)";
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const start = source.indexOf(needle, searchFrom);
    if (start < 0) break;
    const open = source.indexOf("{", start + needle.length);
    if (open < 0 || open > start + needle.length + 8) break;
    const body = sliceBalancedBraceBody(source, open);
    const end = open + body.length + 1;
    ranges.push({ start, end, body });
    searchFrom = end + 1;
  }
  return ranges;
}

function darwinGatedScreenshotBodies(source: string) {
  return darwinVisualGateRanges(source).map((range) => range.body);
}

function withoutDarwinVisualGates(source: string) {
  let result = source;
  for (const range of darwinVisualGateRanges(source).reverse()) {
    result = `${result.slice(0, range.start)}${result.slice(range.end + 1)}`;
  }
  return result;
}

function ungatedScreenshotPaths(files: Array<{ path: string; source: string }>) {
  return files.flatMap(({ path, source }) => {
    const compares = screenshotComparisons(source);
    if (compares.length === 0) return [];
    if (path.endsWith("visual.spec.ts") && fileLevelDarwinVisualSkip(source)) return [];
    const gated = screenshotComparisons(darwinGatedScreenshotBodies(source).join("\n"));
    return compares.length === gated.length ? [] : [path];
  });
}

function platformSuffixedSnapshotEntries(entries: string[]) {
  return entries.filter((entry) => /\.png$/i.test(entry) && /(^|[^A-Za-z0-9])(linux|darwin)([^A-Za-z0-9]|$)/i.test(entry));
}

describe("tooling configuration", () => {
  it("does not reuse an arbitrary server for browser tests", () => {
    const webServer = Array.isArray(playwrightConfig.webServer) ? playwrightConfig.webServer[0] : playwrightConfig.webServer;
    expect(webServer).toBeDefined();
    expect(webServer?.reuseExistingServer).toBe(false);
  });

  it("ignores Next-managed type declarations", async () => {
    expect((await readFile(".gitignore", "utf8")).split(/\r?\n/)).toContain("next-env.d.ts");
    expect(JSON.parse(await readFile("package.json", "utf8")).scripts.typecheck).toMatch(/^next typegen/);
  });

  it("includes the Git ignore contract in Vercel uploads without local environment credentials", async () => {
    const rules = (await readFile(".vercelignore", "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    expect(rules).toContain("!.gitignore");
    expect(rules).toContain(".env*");
    expect(rules).toContain("!.env.example");
    expect(rules.indexOf("!.env.example")).toBeGreaterThan(rules.indexOf(".env*"));
    expect(rules.filter((rule) => rule.startsWith("!.env"))).toEqual(["!.env.example"]);
  });

  it("documents the current snapshot contract with valid location examples", async () => {
    const spec = await readFile("PRODUCT_SPEC.md", "utf8");
    const example = JSON.parse(spec.split("## Snapshot Contract")[1].split("```json")[1].split("```")[0]);
    const demo = JSON.parse(await readFile("tests/fixtures/legacy-catalog-2/demo-snapshot.json", "utf8"));
    expect(example.schemaVersion).toBe(demo.schemaVersion);
    expect(example.catalogVersion).toBe(demo.catalogVersion);
    for (const state of Object.values(example.locations)) LocationStateSchema.parse(state);
  });

  it("includes every deployed cron in the release verification commands", async () => {
    const operations = await readFile("docs/OPERATIONS.md", "utf8");
    const commands = operations.split("## 3. Verify cron routes")[1].split("```")[1];
    const config = JSON.parse(await readFile("vercel.json", "utf8"));
    for (const cron of config.crons) expect(commands).toContain(cron.path);
  });

  it("uses GitHub Actions as the automatic lightweight gate and Vercel as the deploy compile gate", async () => {
    const config = JSON.parse(await readFile("vercel.json", "utf8"));
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const ignore = await readFile(".gitignore", "utf8");
    expect(config.buildCommand).toBe("npm run check:deploy");
    expect(packageJson.scripts["check:deploy"]).toBe("npm run check:fast && npm run build");
    expect(packageJson.scripts["check:fast"]).toBe("node --import tsx scripts/check.ts --fast");
    expect(packageJson.scripts["check:full"]).toBe("node --import tsx scripts/check.ts --full");
    expect(packageJson.scripts["check:release"]).toContain("scripts/verify");
    expect(packageJson.scripts["check:catalog3"]).toContain("scripts/verify");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/^\s+push:/m);
    expect(workflow).toMatch(/^\s+pull_request:/m);
    expect(workflow).toMatch(/^  check-fast:/m);
    expect(workflow).toContain("npm run check:fast");
    expect(workflow).not.toMatch(/check:release/);
    expect(workflow).not.toMatch(/check:catalog3/);
    expect(workflow).not.toContain("mcr.microsoft.com/playwright");
    expect(workflow).not.toContain("check:full");
    expect(ignore).toContain(".next-c2/");
    expect(ignore).toContain(".next-c3/");
    expect(ignore).toContain(".cursor/");
    expect(await readFile("eslint.config.mjs", "utf8")).toContain(".next-c2/**");
    expect(await readFile("eslint.config.mjs", "utf8")).toContain(".next-c3/**");
  });

  it("runs the full check gate on main and manual dispatch only", async () => {
    const workflow = await readFile(".github/workflows/ci-full.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/^\s+push:/m);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toMatch(/pull_request/);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("timeout-minutes: 45");
    expect(workflow).toContain("ci-full-${{ github.ref }}");
    expect(workflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("node-version: 24.19.0");
    expect(workflow).toContain("npm@11.6.2");
    expect(workflow).toContain("npm ci --no-audit --no-fund");
    expect(workflow).toContain("~/.cache/ms-playwright");
    expect(workflow).toContain("npx --no-install playwright install --with-deps chromium webkit");
    expect(workflow).toContain("npm run check:full");
    expect(workflow).toContain("playwright-report");
    expect(workflow).toContain("test-results");
    expect(workflow).toMatch(/if:\s*failure\(\)/);
  });

  it("installs WebKit as well as Chromium because check:full runs both Playwright projects", async () => {
    const workflow = await readFile(".github/workflows/ci-full.yml", "utf8");
    const checkSource = await readFile("scripts/check.ts", "utf8");
    const installCommands = workflowRunCommands(workflow).filter((command) => /playwright install/.test(command));
    expect(installCommands).toEqual([PLAYWRIGHT_INSTALL]);
    expect(installCommands).not.toEqual(["npx --no-install playwright install --with-deps chromium"]);
    expect(playwrightInstallBrowsers(installCommands[0]!)).toEqual(["chromium", "webkit"]);
    expect(playwrightInstallBrowsers(installCommands[0]!)).not.toEqual(["chromium"]);
    expect(playwrightInstallBrowsers("npx --no-install playwright install --with-deps chromium")).not.toContain("webkit");

    const projectBrowsers = playwrightConfig.projects?.map((project) => ({
      name: project.name,
      browser: projectBrowserName(project),
    }));
    expect(projectBrowsers).toEqual([
      { name: "desktop-chromium", browser: "chromium" },
      { name: "mobile-webkit", browser: "webkit" },
    ]);
    expect(new Set(projectBrowsers?.map((project) => project.browser))).toEqual(new Set(["chromium", "webkit"]));
    expect(checkSource).toContain('const playwrightArgs = ["exec", "playwright", "test"]');
    expect(checkSource).not.toMatch(/--project\b/);
    expect(uncommentedYaml(workflow)).not.toMatch(/playwright install --with-deps chromium\s*$/m);
  });

  it("keeps pull_request off the full-check trigger list", async () => {
    const workflow = await readFile(".github/workflows/ci-full.yml", "utf8");
    const lightweight = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflowOnTriggers(workflow)).toEqual(["workflow_dispatch", "push"]);
    expect(workflowOnTriggers(workflow)).not.toContain("pull_request");
    expect(workflowOnTriggers(workflow)).not.toContain("pull_request_target");
    expect(workflow).not.toMatch(/pull_request/);
    expect(uncommentedYaml(workflow)).not.toMatch(/^\s*on:\s*\[.*pull_request/m);
    expect(uncommentedYaml(workflow).split(/\r?\n/).some((line) => /^\s*pull_request(?:_target)?:/.test(line))).toBe(false);
    expect(workflowOnTriggers(lightweight)).toContain("pull_request");
  });

  it("treats a commented WebKit install or a restored pull_request key as a regression", () => {
    const chromiumOnly = `
on:
  workflow_dispatch:
  push:
    branches: [main]
  pull_request:
jobs:
  check-full:
    steps:
      # - run: ${PLAYWRIGHT_INSTALL}
      - run: npx --no-install playwright install --with-deps chromium
`;
    expect(workflowOnTriggers(chromiumOnly)).toEqual(["workflow_dispatch", "push", "pull_request"]);
    expect(workflowOnTriggers(chromiumOnly)).toContain("pull_request");
    const installCommands = workflowRunCommands(chromiumOnly).filter((command) => /playwright install/.test(command));
    expect(installCommands).toEqual(["npx --no-install playwright install --with-deps chromium"]);
    expect(installCommands).not.toEqual([PLAYWRIGHT_INSTALL]);
    expect(playwrightInstallBrowsers(installCommands[0]!)).toEqual(["chromium"]);
    expect(playwrightInstallBrowsers(installCommands[0]!)).not.toContain("webkit");
  });

  it("keeps direct Playwright invocations isolated and treats Darwin snapshots as authoritative", async () => {
    const webServer = Array.isArray(playwrightConfig.webServer) ? playwrightConfig.webServer[0] : playwrightConfig.webServer;
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(playwrightConfig.retries).toBe(0);
    expect(playwrightConfig.snapshotPathTemplate).toBe("{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}");
    expect(playwrightConfig.testMatch).toEqual(["e2e/**/*.spec.ts", "catalog3-e2e/**/*.spec.ts"]);
    expect(playwrightConfig.projects?.map((project) => project.name)).toEqual(["desktop-chromium", "mobile-webkit"]);
    expect(playwrightConfig.projects?.[0]?.grepInvert).toEqual(/@webkit-only/);
    expect(playwrightConfig.projects?.[1]?.grep).toEqual(/@webkit-only|@smoke/);
    expect(await readFile("next.config.ts", "utf8")).toContain("agentRules: false");
    const nextConfig = await readFile("next.config.ts", "utf8");
    expect(nextConfig).toContain('outputFileTracingIncludes: { "/api/v1/health": [');
    expect(nextConfig).toContain('"./public/catalogs/3/publication/latest.json"');
    expect(nextConfig).toContain('"./public/catalogs/3/generations/**/*"');
    expect(nextConfig).toContain('"./public/catalogs/3/objects/**/*"');
    expect(await readFile("next.config.ts", "utf8")).toContain('distDir: process.env.NEXT_DIST_DIR || ".next"');
    const source = await readFile("playwright.config.ts", "utf8");
    expect(source).toContain('failOnFlakyTests: strict');
    expect(source).toContain('PLAYWRIGHT_STRICT === "1"');
    const { readdir } = await import("node:fs/promises");
    const snapshotRoots = ["tests/e2e", "tests/catalog3-e2e"];
    for (const root of snapshotRoots) {
      const entries = await readdir(root, { recursive: true });
      expect(entries.filter((entry) => entry.endsWith("-linux.png") || entry.endsWith("-darwin.png"))).toEqual([]);
    }
    const helpers = await readFile("tests/e2e/helpers.ts", "utf8");
    const visual = await readFile("tests/e2e/visual.spec.ts", "utf8");
    const mapFilters = await readFile("tests/e2e/map-filters.spec.ts", "utf8");
    expect(helpers).toContain('export const DARWIN_VISUAL_SNAPSHOTS = process.platform === "darwin"');
    expect(visual).toContain("test.skip(!DARWIN_VISUAL_SNAPSHOTS");
    expect(mapFilters).toContain("if (DARWIN_VISUAL_SNAPSHOTS)");
  });

  it("enables pixel compare only on Darwin and never on Linux CI hosts", async () => {
    const helpers = await readFile("tests/e2e/helpers.ts", "utf8");
    const expression = darwinVisualFlagExpression(helpers);
    expect(expression).toBe('process.platform === "darwin"');
    expect(expression).not.toMatch(/!==\s*"linux"/);
    expect(evaluateDarwinVisualFlag(expression, "darwin")).toBe(true);
    expect(evaluateDarwinVisualFlag(expression, "linux")).toBe(false);
    expect(evaluateDarwinVisualFlag(expression, "win32")).toBe(false);
    expect(evaluateDarwinVisualFlag(expression, "android")).toBe(false);
    expect(evaluateDarwinVisualFlag(expression, "")).toBe(false);
    expect(evaluateDarwinVisualFlag(expression, "Darwin")).toBe(false);
    expect(evaluateDarwinVisualFlag(expression, "linux-gnu")).toBe(false);
  });

  it("skips the visual spec on non-Darwin before any compare runs", async () => {
    const visual = await readFile("tests/e2e/visual.spec.ts", "utf8");
    expect(fileLevelDarwinVisualSkip(visual)).toBe(true);
    expect(visual).toMatch(/^test\.skip\(!DARWIN_VISUAL_SNAPSHOTS, "Darwin snapshots are authoritative; Linux CI skips pixel compare"\);$/m);
    expect(visual.indexOf("test.skip(!DARWIN_VISUAL_SNAPSHOTS")).toBeLessThan(visual.search(/^test\(/m));
    expect(visual).not.toMatch(/test\.skip\(\s*DARWIN_VISUAL_SNAPSHOTS\s*,/);
    expect(screenshotComparisons(visual).map((compare) => compare.name)).toEqual(Object.keys(VISUAL_GOLDEN_RATIOS));
  });

  it("does not loosen Darwin screenshot thresholds to absorb Linux font drift", async () => {
    const visual = await readFile("tests/e2e/visual.spec.ts", "utf8");
    const mapFilters = await readFile("tests/e2e/map-filters.spec.ts", "utf8");
    const visualCompares = screenshotComparisons(visual);
    expect(Object.fromEntries(visualCompares.map((compare) => [compare.name, compare.ratio]))).toEqual(VISUAL_GOLDEN_RATIOS);
    expect(visualCompares.every((compare) => Number.isFinite(compare.ratio))).toBe(true);
    expect(Math.max(...visualCompares.map((compare) => compare.ratio))).toBe(0.03);
    expect(visualCompares.filter((compare) => /brand-lockup/.test(compare.name)).map((compare) => compare.ratio)).toEqual([0.02, 0.02]);
    expect(visualCompares.some((compare) => /maxDiffPixels/.test(compare.options))).toBe(false);

    const cameraCompares = screenshotComparisons(mapFilters);
    expect(cameraCompares).toEqual([
      { name: "landscape-camera.png", ratio: 0.001, options: " maxDiffPixelRatio: 0.001 " },
      { name: "landscape-camera.png", ratio: 0.001, options: " maxDiffPixelRatio: 0.001 " },
    ]);
    expect(cameraCompares.every((compare) => compare.ratio === 0.001)).toBe(true);
    expect(cameraCompares.every((compare) => compare.ratio < 0.01)).toBe(true);
  });

  it("keeps map-filter camera and CSS assertions running when Linux skips pixel compare", async () => {
    const mapFilters = await readFile("tests/e2e/map-filters.spec.ts", "utf8");
    expect(fileLevelDarwinVisualSkip(mapFilters)).toBe(false);
    expect(mapFilters).not.toMatch(/test\.skip\(\s*!DARWIN_VISUAL_SNAPSHOTS/);
    const rotation = mapFilters.split('test("an untouched map restores its core-Europe framing after rotation"')[1] ?? "";
    const gatedBodies = darwinGatedScreenshotBodies(rotation);
    expect(gatedBodies).toHaveLength(2);
    for (const body of gatedBodies) {
      expect(screenshotComparisons(body)).toEqual([
        { name: "landscape-camera.png", ratio: 0.001, options: " maxDiffPixelRatio: 0.001 " },
      ]);
      expect(body).not.toMatch(/toHaveCSS|data-camera|expect\.poll\(camera\)/);
    }
    const withoutVisual = withoutDarwinVisualGates(rotation);
    expect(withoutVisual).toContain('toHaveCSS("width", "768px")');
    expect(withoutVisual).toContain('toHaveCSS("width", "667px")');
    expect(withoutVisual).toContain("expect.poll(camera)");
    expect(withoutVisual).toContain("data-camera-lng");
    expect(withoutVisual).toContain("data-camera-lat");
    expect(withoutVisual).toContain("data-camera-zoom");
    expect(withoutVisual).toContain("data-camera-padding");
    expect(withoutVisual).not.toContain("toHaveScreenshot");
  });

  it("does not leave any Playwright golden compare reachable on Linux CI", async () => {
    const { readdir } = await import("node:fs/promises");
    const files: Array<{ path: string; source: string }> = [];
    for (const root of ["tests/e2e", "tests/catalog3-e2e"]) {
      for (const entry of await readdir(root, { recursive: true })) {
        if (!String(entry).endsWith(".spec.ts")) continue;
        const filePath = `${root}/${entry}`;
        files.push({ path: filePath, source: await readFile(filePath, "utf8") });
      }
    }
    expect(files.filter((file) => file.source.includes("toHaveScreenshot")).map((file) => file.path).sort()).toEqual([
      "tests/e2e/map-filters.spec.ts",
      "tests/e2e/visual.spec.ts",
    ]);
    expect(ungatedScreenshotPaths(files)).toEqual([]);
    for (const root of ["tests/e2e", "tests/catalog3-e2e"]) {
      expect(platformSuffixedSnapshotEntries((await readdir(root, { recursive: true })).map(String))).toEqual([]);
    }
    expect(playwrightConfig.snapshotPathTemplate).not.toMatch(/\{platform\}/i);
    expect(await readFile("scripts/check.ts", "utf8")).not.toMatch(/update-snapshots/);
    expect(uncommentedYaml(await readFile(".github/workflows/ci-full.yml", "utf8"))).not.toMatch(/update-snapshots/);
    expect(await readFile(".github/workflows/ci-full.yml", "utf8")).toMatch(/^\s+runs-on:\s*ubuntu-latest$/m);
  });

  it("treats an inverted skip, raised camera threshold, or platform-suffixed golden as a regression", () => {
    expect(fileLevelDarwinVisualSkip(`test.skip(DARWIN_VISUAL_SNAPSHOTS, "oops");\ntest("lockup", async () => {});\n`)).toBe(false);
    expect(fileLevelDarwinVisualSkip(`test("lockup", async () => {});\ntest.skip(!DARWIN_VISUAL_SNAPSHOTS, "too late");\n`)).toBe(false);
    expect(evaluateDarwinVisualFlag('process.platform !== "linux"', "win32")).toBe(true);
    expect(evaluateDarwinVisualFlag('process.platform === "darwin"', "win32")).toBe(false);
    expect(screenshotComparisons(`await expect(canvas).toHaveScreenshot("landscape-camera.png", { maxDiffPixelRatio: 0.01 });`).map((compare) => compare.ratio)).toEqual([0.01]);
    expect(screenshotComparisons(`await expect(canvas).toHaveScreenshot("landscape-camera.png", { maxDiffPixelRatio: 0.01 });`)[0]?.ratio).toBeGreaterThan(0.001);
    expect(ungatedScreenshotPaths([
      { path: "tests/e2e/app.spec.ts", source: `await expect(page).toHaveScreenshot("desktop-brand-lockup.png", { maxDiffPixelRatio: 0.02 });` },
    ])).toEqual(["tests/e2e/app.spec.ts"]);
    expect(ungatedScreenshotPaths([
      { path: "tests/e2e/visual.spec.ts", source: `test.skip(!DARWIN_VISUAL_SNAPSHOTS, "Darwin snapshots are authoritative; Linux CI skips pixel compare");\ntest("lockup", async () => {\n  await expect(page).toHaveScreenshot("desktop-brand-lockup.png", { maxDiffPixelRatio: 0.02 });\n});\n` },
    ])).toEqual([]);
    expect(ungatedScreenshotPaths([
      { path: "tests/e2e/map-filters.spec.ts", source: `if (DARWIN_VISUAL_SNAPSHOTS) {\n  await expect(canvas).toHaveScreenshot("landscape-camera.png", { maxDiffPixelRatio: 0.001 });\n}\n` },
    ])).toEqual([]);
    expect(platformSuffixedSnapshotEntries(["visual.spec.ts-snapshots/desktop-brand-lockup-linux.png", "map-filters.spec.ts-snapshots/landscape-camera-linux-desktop-chromium.png"])).toEqual([
      "visual.spec.ts-snapshots/desktop-brand-lockup-linux.png",
      "map-filters.spec.ts-snapshots/landscape-camera-linux-desktop-chromium.png",
    ]);
    expect(platformSuffixedSnapshotEntries(["visual.spec.ts-snapshots/desktop-brand-lockup-desktop-chromium.png"])).toEqual([]);
  });

  it("keeps reliability-gated GDELT disabled in the production environment example", async () => {
    const example = await readFile(".env.example", "utf8");
    const operations = await readFile("docs/OPERATIONS.md", "utf8");
    expect(example).toMatch(/^GDELT_ENABLED=false$/m);
    expect(operations).toContain("Keep `GDELT_ENABLED=false`");
  });
});
