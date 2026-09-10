import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import playwrightConfig from "../../playwright.config";
import { LocationStateSchema } from "../../src/lib/domain/schemas";

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
    const demo = JSON.parse(await readFile("public/demo-snapshot.json", "utf8"));
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
    expect(ignore).toContain(".next-c2/");
    expect(ignore).toContain(".next-c3/");
    expect(ignore).toContain(".cursor/");
    expect(await readFile("eslint.config.mjs", "utf8")).toContain(".next-c2/**");
    expect(await readFile("eslint.config.mjs", "utf8")).toContain(".next-c3/**");
  });

  it("keeps direct Playwright invocations isolated and treats Darwin snapshots as authoritative", async () => {
    const webServer = Array.isArray(playwrightConfig.webServer) ? playwrightConfig.webServer[0] : playwrightConfig.webServer;
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(playwrightConfig.retries).toBe(0);
    expect(playwrightConfig.snapshotPathTemplate).toBe("{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}");
    expect(playwrightConfig.projects?.map((project) => project.name)).toEqual(["desktop-chromium", "mobile-webkit"]);
    expect(playwrightConfig.projects?.[0]?.grepInvert).toEqual(/@webkit-only/);
    expect(playwrightConfig.projects?.[1]?.grep).toEqual(/@webkit-only|@smoke/);
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
