import { type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "../playwright-fixtures";
import { destinationSearch, destinationDetails, selectDestination, type MutableDemoSnapshot } from "./helpers";

test("keeps search and the destination directory usable when map tiles fail", { tag: ["@smoke", "@map-failure"] }, async ({ page }) => {
  await page.route(/openfreemap/, (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Destination list" })).toBeVisible();
  await expect(destinationSearch(page)).toBeEnabled();
  await expect(page.getByRole("region", { name: /Interactive map of destination risk/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zoom in" })).toHaveCount(0);
  await page.getByRole("region", { name: "Destination list" }).getByRole("button", { name: /Vienna/ }).click();
  await expect(destinationDetails(page).getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
});

test("shows the destination directory when tiles fail after the map style loads", { tag: "@map-failure" }, async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/styles/positron" || pathname === "/planet") await route.continue();
    else await route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Destination list" })).toBeVisible({ timeout: 15_000 });
  await expect(destinationSearch(page)).toBeEnabled();
});

test("keeps the destination directory usable when the map module fails", { tag: "@map-failure" }, async ({ page }) => {
  let blocked = false;
  const distDir = process.env.PLAYWRIGHT_DIST_DIR || process.env.NEXT_DIST_DIR || ".next";
  const productionChunk = process.env.PLAYWRIGHT_USE_BUILD === "true"
    ? readdirSync(`${distDir}/static/chunks`).find((file) => file.endsWith(".js") && readFileSync(`${distDir}/static/chunks/${file}`, "utf8").includes("getRTLTextPluginStatus"))
    : null;
  if (process.env.PLAYWRIGHT_USE_BUILD === "true") expect(productionChunk).toBeTruthy();
  await page.route(productionChunk ? `**/${productionChunk}` : /node_modules_maplibre-gl_dist.*\.js/, (route) => {
    blocked = true;
    return route.abort();
  });
  await page.goto("/");
  await expect.poll(() => blocked).toBe(true);
  await expect(page.getByRole("heading", { name: "Destination list" })).toBeVisible();
  await expect(destinationSearch(page)).toBeEnabled();
  await page.getByRole("region", { name: "Destination list" }).getByRole("button", { name: /Vienna/ }).click();
  await expect(destinationDetails(page).getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
});

test("exposes unavailable destinations through the attention experience when the snapshot fails", { tag: "@smoke" }, async ({ page }, testInfo) => {
  await page.route("**/demo-snapshot.json", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();
  if (testInfo.project.name === "mobile-webkit") {
    await page.getByRole("button", { name: /Alerts/ }).click();
    await expect(page.getByRole("heading", { name: "Updates unavailable" })).toBeVisible();
    await expect(page.getByText(/Current alerts could not be confirmed/)).toBeVisible();
    await page.getByRole("button", { name: "Map", exact: true }).click();
  } else {
    const trigger = page.getByRole("button", { name: /Open destinations needing attention/ });
    await expect(trigger).toContainText("503 updates unavailable");
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Updates unavailable" })).toBeVisible();
    await expect(dialog.getByText(/could not be confirmed for 503 destinations/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Vienna/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  await selectDestination(page, "Vienna", /Vienna/);
  await expect(destinationDetails(page).getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
  await expect(destinationDetails(page).locator('span[data-level="UNKNOWN"]')).toContainText("Updates unavailable");
});

test("keeps updates unavailable visible while a retry is pending", async ({ page }) => {
  let attempts = 0;
  const pendingRetries: Route[] = [];
  await page.route("**/demo-snapshot.json", (route) => {
    attempts += 1;
    if (attempts === 1) return route.abort();
    pendingRetries.push(route);
  });
  await page.goto("/");
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();
  await pendingRetries[0]?.abort();
});

for (const [name, newerResponse] of [
  ["ignores an older snapshot request that finishes after a newer retry", 1],
  ["accepts fresher snapshot data even when it came from an earlier request", 0],
] as const) {
  test(name, async ({ page }) => {
    const base = await (await page.request.get("/demo-snapshot.json")).json() as MutableDemoSnapshot;
    const older = structuredClone(base);
    older.generatedAt = "2026-08-25T12:00:00.000Z";
    const newer = structuredClone(base);
    newer.generatedAt = "2026-08-25T12:10:00.000Z";
    newer.locations["at-vienna"] = { level: "UNKNOWN", coverage: "delayed", coverageGaps: [], delayedHazards: ["severe-weather"], hazards: [] };
    let attempts = 0;
    const pending: Route[] = [];
    await page.route("**/demo-snapshot.json", (route) => {
      attempts += 1;
      if (attempts === 1) return route.abort();
      pending.push(route);
    });
    await page.goto("/");
    const retry = page.getByRole("button", { name: "Retry" });
    await retry.click();
    await retry.click();
    await expect.poll(() => pending.length).toBe(2);
    await pending[newerResponse].fulfill({ json: newer });
    await pending[1 - newerResponse].fulfill({ json: older });

    await selectDestination(page, "Vienna", /Vienna/);
    await expect(destinationDetails(page).getByText("Updates unavailable")).toBeVisible();
  });
}

test("disables the attention summary when the destination catalog fails", async ({ page }, testInfo) => {
  await page.route("**/locations.json", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Destinations unavailable.")).toBeVisible();
  if (testInfo.project.name === "mobile-webkit") {
    await page.getByRole("button", { name: /Alerts/ }).click();
    await expect(page.getByRole("heading", { name: "Updates unavailable" })).toBeVisible();
  } else {
    const attention = page.getByRole("button", { name: /Destination alerts are unavailable/ });
    await expect(attention).toBeDisabled();
    await expect(attention).toContainText("Destinations unavailable");
  }
  await expect(page.getByText("No destinations flagged")).toHaveCount(0);
  await expect(page.getByText("No destinations are currently flagged.")).toHaveCount(0);
});

test("does not promise search or a directory when both map and catalog fail", { tag: "@map-failure" }, async ({ page }) => {
  await page.route("**/locations.json", (route) => route.abort());
  await page.route(/openfreemap/, (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The map could not load." })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("The destination list is also unavailable. Retry or check official local sources.")).toBeVisible();
  await expect(destinationSearch(page)).toBeDisabled();
  await expect(page.getByRole("region", { name: "Destination list" })).toHaveCount(0);
});

test("keeps the narrow recovery banner clear of search", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The 320px collision boundary only needs one browser engine.");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/demo-snapshot.json", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();

  const [bannerBox, searchBox] = await Promise.all([
    page.locator('[data-ui="data-health-banner"]').boundingBox(),
    page.locator('[data-ui="destination-search"]').boundingBox(),
  ]);
  expect(bannerBox && searchBox).toBeTruthy();
  expect((searchBox?.y ?? 0) + (searchBox?.height ?? 0) + 8).toBeLessThanOrEqual(bannerBox?.y ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("keeps the tile-failure directory accessible", { tag: ["@smoke", "@map-failure"] }, async ({ page }) => {
  await page.route(/openfreemap/, (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Destination list" })).toBeVisible();
  expect((await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations).toEqual([]);
});


