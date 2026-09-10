import { type Page } from "@playwright/test";
import { expect, test } from "../playwright-fixtures";

test.describe.configure({ mode: "serial" });

async function hideDevelopmentChrome(page: Page) {
  await page.addStyleTag({
    content: `
      nextjs-portal, button[aria-label="Open Next.js Dev Tools"] { display: none !important; }
      .maplibregl-canvas { visibility: hidden !important; }
      .maplibregl-map { background: #c6c2b8 !important; }
      *, *::before, *::after { animation: none !important; transition: none !important; }
    `,
  });
}

async function selectSevereDestination(page: Page) {
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Klagenfurt");
  const option = page.getByRole("option", { name: /Klagenfurt/ });
  await expect(option).toBeVisible();
  await option.click({ force: true });
}

async function selectBudapest(page: Page) {
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Budapest");
  await page.getByRole("option", { name: /Budapest/ }).click();
}

async function failHungarianWeather(page: Page) {
  await page.route("**/demo-snapshot.json", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as {
      providers: { meteoalarm: { partitions: Record<string, { status: string }> } };
    };
    snapshot.providers.meteoalarm.partitions.HU.status = "failed";
    await route.fulfill({ response, json: snapshot });
  });
}

test("desktop TravelCanary brand lockup is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "TravelCanary, current Europe location risk. Alpha preview", exact: true })).toHaveScreenshot("desktop-brand-lockup.png", {
    maxDiffPixelRatio: 0.02,
  });
});

test("desktop control rail is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("TravelCanary controls")).toHaveScreenshot("desktop-control-rail.png", {
    maxDiffPixelRatio: 0.02,
  });
  await page.getByRole("button", { name: /^High & Severe/ }).click();
  await expect(page.getByLabel("TravelCanary controls")).toHaveScreenshot("desktop-control-rail-high.png", {
    maxDiffPixelRatio: 0.02,
  });
  await page.setViewportSize({ width: 1024, height: 600 });
  await expect(page.getByLabel("TravelCanary controls")).toHaveScreenshot("desktop-control-rail-short.png", {
    maxDiffPixelRatio: 0.02,
  });
});

test("desktop unavailable rail is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.route("**/demo-snapshot.json", (route) => route.abort());
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();
  // The rail is fixed inside this viewport. Verify its layout, then capture
  // those pixels directly without an unnecessary element auto-scroll action.
  const rail = page.getByLabel("TravelCanary controls");
  const bounds = { x: 0, y: 0, width: 344, height: 768 };
  await expect.poll(() => rail.boundingBox()).toEqual(bounds);
  await expect(page).toHaveScreenshot("desktop-control-rail-unavailable.png", {
    clip: bounds,
    maxDiffPixelRatio: 0.02,
  });
});

test("desktop control overlays are visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });

  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Klagenfurt");
  await expect(page.getByRole("listbox", { name: "Destination results" })).toHaveScreenshot("desktop-search-results.png", {
    maxDiffPixelRatio: 0.02,
  });
  await search.fill("");

  await page.getByRole("button", { name: /Open destinations needing attention/ }).click();
  const attention = page.getByRole("dialog", { name: "Destinations needing attention" });
  await expect(attention).toHaveScreenshot("desktop-attention-popover.png", { maxDiffPixelRatio: 0.02 });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open app menu" }).click();
  const menu = page.getByRole("dialog", { name: "TravelCanary" });
  await expect(menu).toHaveScreenshot("desktop-app-menu.png", { maxDiffPixelRatio: 0.02 });
});

test("mobile TravelCanary brand lockup is visually stable", { tag: "@webkit-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "TravelCanary, current Europe location risk. Alpha preview", exact: true })).toHaveScreenshot("mobile-brand-lockup.png", {
    maxDiffPixelRatio: 0.02,
  });
});

test("desktop map-first chrome is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("combobox", { name: "Where are you going?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open destinations needing attention/ })).toBeVisible();
  await expect(page).toHaveScreenshot("desktop-map-first.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("desktop severe drawer is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await selectSevereDestination(page);
  await expect(page.getByRole("complementary")).toBeVisible({ timeout: 12_000 });
  await expect(page).toHaveScreenshot("desktop-severe-drawer.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("desktop normal briefing card is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  await expect(page.getByRole("complementary", { name: /Vienna/ })).toBeVisible();
  await expect(page).toHaveScreenshot("desktop-normal-card.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("desktop expanded coverage evidence is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await selectBudapest(page);
  const panel = page.getByRole("complementary", { name: /Budapest/ });
  await panel.getByText("Fully checked (3)").click();
  await panel.getByText("Air quality", { exact: true }).first().click();
  await expect(panel.getByRole("link", { name: /Official provider site/ }).first()).toBeVisible();
  const airQuality = panel.locator('details[data-status="available"]').filter({ hasText: "Air quality" });
  await expect(airQuality).toHaveScreenshot("desktop-coverage-expanded.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("desktop delayed destination coverage is visually stable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await failHungarianWeather(page);
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await selectBudapest(page);
  const panel = page.getByRole("complementary", { name: /Budapest/ });
  await expect(panel.getByText("Update delayed", { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("region", { name: "What TravelCanary checks for Budapest" })).toHaveScreenshot("desktop-coverage-delayed.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("mobile default chrome is visually stable", { tag: "@webkit-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status", { name: /Demo data/ })).toBeVisible();
  await expect(page).toHaveScreenshot("mobile-map-first.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("mobile unavailable-data recovery is visually stable", { tag: "@webkit-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/demo-snapshot.json", (route) => route.abort());
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();
  await expect(page.locator('[data-ui="destination-search"]')).toBeVisible();
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveScreenshot("mobile-updates-unavailable.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("mobile grouped Alerts view is visually stable", { tag: "@webkit-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await page.getByRole("button", { name: /Alerts/ }).click();
  await expect(page.getByRole("region", { name: "Current alerts" })).toBeVisible();
  await expect(page).toHaveScreenshot("mobile-attention-sheet.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("mobile severe sheet is visually stable", { tag: "@webkit-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await selectSevereDestination(page);
  await expect(page.getByRole("dialog", { name: /Klagenfurt/ })).toBeVisible();
  await expect(page).toHaveScreenshot("mobile-severe-sheet.png", {
    maxDiffPixelRatio: 0.03,
  });
});

test("map failure fallback is visually stable", { tag: "@map-failure" }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/openfreemap/, (route) => route.abort());
  await page.goto("/");
  await hideDevelopmentChrome(page);
  await expect(page.getByRole("heading", { name: "Destination list" })).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveScreenshot("desktop-map-fallback.png", {
    maxDiffPixelRatio: 0.03,
  });
});
