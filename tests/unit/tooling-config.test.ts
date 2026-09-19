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
  });

  it("keeps reliability-gated GDELT disabled in the production environment example", async () => {
    const example = await readFile(".env.example", "utf8");
    const operations = await readFile("docs/OPERATIONS.md", "utf8");
    expect(example).toMatch(/^GDELT_ENABLED=false$/m);
    expect(operations).toContain("Keep `GDELT_ENABLED=false`");
  });
});
