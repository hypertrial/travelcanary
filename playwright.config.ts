import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "3000";
const baseURL = `http://127.0.0.1:${port}`;
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";
const distDir = process.env.PLAYWRIGHT_DIST_DIR || process.env.NEXT_DIST_DIR || ".next";
const strict = process.env.PLAYWRIGHT_STRICT === "1" || Boolean(process.env.CI);

export default defineConfig({
  testDir: process.env.PLAYWRIGHT_CATALOG_VERSION === "3" ? "./tests/catalog3-e2e" : "./tests/e2e",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  failOnFlakyTests: strict,
  workers: process.env.CI ? 1 : Number(process.env.PLAYWRIGHT_WORKERS || 4),
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  webServer: reuseExistingServer
    ? undefined
    : {
        command: `NEXT_DIST_DIR=${distDir} npm run ${process.env.PLAYWRIGHT_USE_BUILD === "true" ? "start" : "dev"} -- --hostname 127.0.0.1 --port ${port}`,
        timeout: 120_000,
        url: baseURL,
        reuseExistingServer: false,
        env: {
          NEXT_PUBLIC_DATA_MODE: "demo",
          NEXT_PUBLIC_CATALOG_VERSION: process.env.PLAYWRIGHT_CATALOG_VERSION || "2",
          NEXT_DIST_DIR: distDir,
        },
      },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@webkit-only/ },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] }, grep: /@webkit-only|@smoke/ },
  ],
});
