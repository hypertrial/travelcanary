import { type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mapSnapshot } from "../fixtures/map-snapshots";
import { expect, test, installDeterministicBasemap } from "../playwright-fixtures";

const map = (page: Page) => page.getByRole("region", { name: /^Interactive map/ });
const filters = (page: Page) => page.getByRole("group", { name: "Map filters" });

async function chooseFilter(page: Page, label: string) {
  const desktopButton = filters(page).getByRole("button", { name: new RegExp(`^${label}`) });
  const trigger = page.getByRole("button", { name: /Map filter:/ });
  // A resize may update browser media before React replaces the old controls.
  const mobile = await page.evaluate(() => matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)").matches);
  if (!mobile) {
    await expect(trigger).toHaveCount(0);
    return desktopButton.click();
  }
  await expect(desktopButton).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole("dialog", { name: "Choose map filter" }).getByRole("button", { name: new RegExp(`^${label}`) }).click();
}

async function loadSnapshot(page: Page, alerts = 108, unavailable = 33) {
  const snapshot = mapSnapshot(alerts, unavailable);
  await installDeterministicBasemap(page);
  await page.route("**/demo-snapshot.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");
  await expect(map(page)).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

test("elevated-only snapshots populate the default map and expose exclusive destination counts", async ({ page }, testInfo) => {
  await loadSnapshot(page);
  const compact = page.getByRole("button", { name: /Map filter:/ });
  if (await compact.count()) await expect(compact).toContainText("All alerts · 108");
  else {
    await expect(filters(page).getByRole("button", { name: "All alerts · 108", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(filters(page).getByRole("button", { name: "High & Severe · 0", exact: true })).toBeVisible();
    await expect(filters(page).getByRole("button", { name: "Updates unavailable · 33", exact: true })).toBeVisible();
  }
  await expect(map(page)).toHaveAttribute("data-marker-count", "108");
  await page.screenshot({ path: testInfo.outputPath("elevated-only-map.png") });

  await chooseFilter(page, "High & Severe");
  await expect(map(page)).toHaveAttribute("data-marker-count", "0");
  await expect(page.getByText("No High or Severe alerts found in checked sources.")).toBeVisible();
  await page.getByRole("button", { name: /Show (108 )?Be aware/ }).click();
  await expect(map(page)).toHaveAttribute("data-marker-count", "108");

  await chooseFilter(page, "Updates unavailable");
  await expect(map(page)).toHaveAttribute("data-marker-count", "33");
  if (await compact.count()) await expect(compact).toContainText("Updates unavailable · 33");
  else await expect(filters(page).getByRole("button", { name: "All alerts · 108", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect((await new AxeBuilder({ page }).include('[data-ui="map-filters"]').analyze()).violations).toEqual([]);
});

test("quiet destinations remain searchable and selected markers override the filter without changing counts", async ({ page }) => {
  await loadSnapshot(page);
  await chooseFilter(page, "High & Severe");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  await expect(map(page)).toHaveAttribute("data-marker-count", "1");
  await expect(page.getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Close.*details/i }).click();
  await expect(map(page)).toHaveAttribute("data-marker-count", "0");
  const compact = page.getByRole("button", { name: /Map filter:/ });
  if (await compact.isVisible().catch(() => false)) await expect(compact).toContainText("High & Severe · 0");
  else await expect(filters(page).getByRole("button", { name: "All alerts · 108", exact: true })).toBeVisible();
});

test("a genuine zero-alert snapshot gives qualified empty results without green markers", async ({ page }) => {
  await loadSnapshot(page, 0, 0);
  await expect(map(page)).toHaveAttribute("data-marker-count", "0");
  await expect(page.getByText(/No alerts found in checked sources/).first()).toBeVisible();
  await chooseFilter(page, "High & Severe");
  await expect(page.getByText(/No High or Severe alerts found/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Show .* Be aware destinations/ })).toHaveCount(0);
  await chooseFilter(page, "Updates unavailable");
  await expect(page.getByText(/No destinations have updates unavailable/)).toBeVisible();
});

test("missing data does not claim zero alerts", async ({ page }) => {
  await page.route("**/demo-snapshot.json", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Live updates unavailable.")).toBeVisible();
  const compact = page.getByRole("button", { name: /Map filter:/ });
  if (await compact.count()) await expect(compact).toContainText("All alerts · —");
  else await expect(filters(page).getByRole("button", { name: "All alerts · —", exact: true })).toBeDisabled();
  await expect(page.getByText(/No alerts found in checked sources/)).toHaveCount(0);
});

test("zero alerts with unavailable updates offers the separate unavailable view", async ({ page }) => {
  await loadSnapshot(page, 0, 33);
  await expect(map(page)).toHaveAttribute("data-marker-count", "0");
  await expect(page.getByText(/No alerts found in checked sources/).first()).toBeVisible();
  await page.getByRole("button", { name: /Show (33 destinations with updates unavailable|unavailable)/ }).click();
  await expect(map(page)).toHaveAttribute("data-marker-count", "33");
  const compact = page.getByRole("button", { name: /Map filter:/ });
  if (await compact.count()) {
    await expect(compact).toContainText("Updates unavailable · 33");
    await expect(page.getByRole("button", { name: "Alerts, 33 destinations with updates unavailable" })).toBeVisible();
  }
  else await expect(filters(page).getByRole("button", { name: "Updates unavailable · 33", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("filter buttons support keyboard navigation and activation", async ({ page }, testInfo) => {
  await loadSnapshot(page);
  const compact = page.getByRole("button", { name: /Map filter:/ });
  if (await compact.count()) {
    await compact.focus();
    await page.keyboard.press("Enter");
    const highOption = page.getByRole("dialog", { name: "Choose map filter" }).getByRole("button", { name: /^High & Severe/ });
    await highOption.focus();
    await page.keyboard.press("Enter");
    await expect(compact).toContainText("High & Severe");
    await expect(page.getByRole("button", { name: "Alerts, 0 alert destinations" })).toBeVisible();
    return;
  }
  await filters(page).getByRole("button", { name: "All alerts · 108", exact: true }).focus();
  const high = filters(page).getByRole("button", { name: "High & Severe · 0", exact: true });
  // Mobile WebKit does not tab between native buttons; still verify activation.
  if (testInfo.project.name === "mobile-webkit") await high.focus();
  else await page.keyboard.press("Tab");
  await expect(high).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(high).toHaveAttribute("aria-pressed", "true");
  if (testInfo.project.name === "desktop-chromium") {
    await page.keyboard.press("Tab");
    await expect(filters(page).getByRole("button", { name: "Updates unavailable · 33", exact: true })).toBeFocused();
  }
});

test("empty-state recovery moves keyboard focus to the newly selected filter", async ({ page }) => {
  await loadSnapshot(page);
  test.skip(await page.getByRole("button", { name: /Map filter:/ }).count() > 0, "Compact filters return focus to their sheet trigger.");
  await filters(page).getByRole("button", { name: "High & Severe · 0", exact: true }).click();
  const recovery = page.getByRole("button", { name: "Show 108 Be aware destinations", exact: true });
  await recovery.focus();
  await page.keyboard.press("Enter");
  await expect(filters(page).getByRole("button", { name: "All alerts · 108", exact: true })).toBeFocused();
  await filters(page).getByRole("button", { name: "High & Severe · 0", exact: true }).click();
  await page.getByRole("button", { name: "Show 33 destinations with updates unavailable", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(filters(page).getByRole("button", { name: "Updates unavailable · 33", exact: true })).toBeFocused();
});

test("short-screen filters do not cover the failure banner or its retry control", async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.route("**/demo-snapshot.json", (route) => route.abort());
  await page.goto("/");
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  const banner = (await retry.locator("..").boundingBox())!;
  const trigger = (await page.getByRole("button", { name: /Map filter:/ }).boundingBox())!;
  expect(trigger.y + trigger.height).toBeLessThanOrEqual(banner.y);
  await retry.click({ trial: true });
});

test("switching to tile fallback does not try to reframe a disposed map", { tag: "@map-failure" }, async ({ page }) => {
  const cameraWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Map cannot fit within canvas")) cameraWarnings.push(message.text());
  });
  await page.route(/openfreemap/, (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Destination list", exact: true })).toBeVisible();
  expect(cameraWarnings).toEqual([]);
});

test("an untouched map restores its core-Europe framing after rotation", { tag: "@smoke" }, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installDeterministicBasemap(page);
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto("/");
  await expect(map(page)).toHaveAttribute("data-marker-count", "6", { timeout: 15_000 });
  await page.addStyleTag({ content: '[class*="topChrome"], [class*="mapActions"], .maplibregl-control-container, nextjs-portal { visibility: hidden !important; }' });
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toHaveScreenshot("landscape-camera.png", { maxDiffPixelRatio: 0.001 });
  const camera = () => map(page).evaluate((element) => ({
    lng: Number(element.getAttribute("data-camera-lng")),
    lat: Number(element.getAttribute("data-camera-lat")),
    zoom: Number(element.getAttribute("data-camera-zoom")),
    padding: element.getAttribute("data-camera-padding"),
  }));
  const initialCamera = await camera();
  const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
  expect(await zoomOut.isDisabled()).toBe(initialCamera.zoom <= 1.81);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(canvas).toHaveCSS("width", "768px");
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(canvas).toHaveCSS("width", "667px");
  await expect(canvas).toHaveScreenshot("landscape-camera.png", { maxDiffPixelRatio: 0.001 });
  await expect.poll(camera).toEqual(initialCamera);
  expect(await zoomOut.isDisabled()).toBe((await camera()).zoom <= 1.81);
});

test("opens on core Europe and restores the prior camera after an outer-destination drill-down", async ({ page }, testInfo) => {
  await installDeterministicBasemap(page);
  if (testInfo.project.name === "mobile-webkit") await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(map(page)).toHaveAttribute("data-marker-count", "6", { timeout: 15_000 });
  await page.getByRole("button", { name: "Reset map to core Europe" }).click();
  await page.waitForTimeout(300);
  await expect(map(page)).toHaveAttribute("data-camera-mode", "core");
  const initialCamera = await map(page).evaluate((element) => ({
    lng: Number(element.getAttribute("data-camera-lng")),
    lat: Number(element.getAttribute("data-camera-lat")),
    zoom: Number(element.getAttribute("data-camera-zoom")),
    padding: element.getAttribute("data-camera-padding"),
  }));

  if (testInfo.project.name === "mobile-webkit") await page.emulateMedia({ reducedMotion: "reduce" });
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Santa Cruz das Flores");
  await page.getByRole("option", { name: /Santa Cruz das Flores/ }).click();
  await expect(page.getByRole("heading", { name: "Santa Cruz das Flores", exact: true })).toBeVisible();
  await expect(map(page)).toHaveAttribute("data-marker-count", "7");
  if (testInfo.project.name === "desktop-chromium") {
    await page.getByRole("button", { name: /Open destinations needing attention/ }).click();
    await page.getByRole("dialog", { name: "Destinations needing attention" }).getByRole("button", { name: /Klagenfurt/ }).click();
    await expect(page.getByRole("heading", { name: "Klagenfurt am Wörthersee", exact: true })).toBeVisible();
  } else {
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByRole("heading", { name: "Santa Cruz das Flores", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.getByRole("button", { name: "Close destination details" }).click();
  await expect(map(page)).toHaveAttribute("data-marker-count", "6");
  await expect.poll(async () => map(page).evaluate((element) => ({
    lng: Number(element.getAttribute("data-camera-lng")),
    lat: Number(element.getAttribute("data-camera-lat")),
    zoom: Number(element.getAttribute("data-camera-zoom")),
    padding: element.getAttribute("data-camera-padding"),
  }))).toEqual(initialCamera);
});

test("manual zoom remains authoritative across filters and resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Camera state is browser-independent; desktop covers the interaction.");
  await installDeterministicBasemap(page);
  await page.goto("/");
  await expect(map(page)).toHaveAttribute("data-locations-ready", "true", { timeout: 15_000 });
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
  for (let attempt = 0; attempt < 6 && !(await zoomOut.isDisabled()); attempt += 1) {
    await zoomOut.click();
    await page.waitForTimeout(240);
  }
  await expect(zoomOut).toBeDisabled();
  await filters(page).getByRole("button", { name: /High & Severe/ }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(zoomOut).toBeDisabled();
  await zoomIn.click();
  await expect(zoomOut).toBeEnabled();
  await zoomOut.click();
  await expect(zoomOut).toBeDisabled();
});

test("filters and empty-state actions fit narrow, tablet, desktop and landscape viewports", async ({ page }, testInfo) => {
  await loadSnapshot(page);
  for (const size of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(100);
    await chooseFilter(page, "High & Severe");
    await expect(map(page)).toHaveAttribute("data-marker-count", "0");
    const compactFilters = await page.getByRole("button", { name: /Map filter:/ }).count() > 0;
    const recovery = compactFilters
      ? page.getByRole("button", { name: "Show Be aware", exact: true })
      : page.getByRole("button", { name: "Show 108 Be aware destinations", exact: true });
    await expect(recovery).toBeInViewport();
    const filterControls = compactFilters
      ? [page.getByRole("button", { name: /Map filter:/ })]
      : await filters(page).getByRole("button").all();
    for (const button of filterControls) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`empty-filter-${size.width}.png`) });
    await recovery.click();
    await expect(map(page)).toHaveAttribute("data-marker-count", "108");
  }
});
