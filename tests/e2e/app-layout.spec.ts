import { expect, test } from "../playwright-fixtures";
import { destinationSearch, selectDestination, gotoAfterViewportChange } from "./helpers";

for (const viewport of [
  { width: 320, height: 700 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1024, height: 600 },
  { width: 1024, height: 800 },
  { width: 1280, height: 720 },
  { width: 1360, height: 768 },
  { width: 1440, height: 900 },
]) test(`has no responsive overlap or horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in Chromium across all responsive widths.");
  test.setTimeout(90_000);
  const cameraWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Map cannot fit within canvas")) cameraWarnings.push(message.text());
  });
    await page.setViewportSize(viewport);
    await gotoAfterViewportChange(page);
    await expect(destinationSearch(page)).toBeVisible();
    await expect(page.getByRole("status", { name: /Demo data\. Not live\./ })).toBeVisible();
    await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
    const appMenu = await page.getByRole("button", { name: "Open app menu" }).boundingBox();
    expect(appMenu && appMenu.y >= 0 && appMenu.y + appMenu.height <= viewport.height).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    if (viewport.width <= 640) {
      const [cardBox, labelBox] = await Promise.all([
        page.locator('[data-ui="destination-search"]').boundingBox(),
        page.locator('[data-ui="destination-search"] label').boundingBox(),
      ]);
      expect(cardBox && labelBox).toBeTruthy();
      expect(labelBox?.y ?? 0).toBeGreaterThanOrEqual(cardBox?.y ?? 0);
    }
    if (viewport.width >= 1024) {
      const rail = page.getByLabel("TravelCanary controls");
      expect(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const expectedRailWidth = viewport.width >= 1360 ? 368 : 344;
      expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBe(expectedRailWidth);
      for (const button of await rail.locator('[data-ui="map-filters"] [role="group"] button').all()) {
        expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
    }
    await selectDestination(page, "Klagenfurt", /Klagenfurt/);
    if (viewport.width >= 1024) {
      const expectedRailWidth = viewport.width >= 1360 ? 368 : 344;
      expect(Math.round((await page.getByLabel("TravelCanary controls").boundingBox())?.width ?? 0)).toBe(expectedRailWidth);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("button", { name: "Close destination details" }).click();
  expect(cameraWarnings).toEqual([]);
});

test("keeps desktop status and rail controls on intentional lines", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop rail wrapping only needs one browser engine.");
  for (const viewport of [{ width: 1024, height: 600 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await gotoAfterViewportChange(page);

    const status = page.getByRole("status", { name: /Demo data\. Not live\./ });
    const visibleStatus = status.getByText("Demo · not live", { exact: true });
    await expect(visibleStatus).toBeVisible();
    expect(await visibleStatus.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    expect(await visibleStatus.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await visibleStatus.evaluate((element) => element.getClientRects().length)).toBe(1);

    const rail = page.getByLabel("TravelCanary controls");
    const brand = page.getByRole("link", { name: /TravelCanary, current Europe location risk/ });
    const menu = page.getByRole("button", { name: "Open app menu" });
    await expect(brand).toBeVisible();
    await expect(menu).toBeVisible();
    expect(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const attention = page.getByRole("button", { name: /Open destinations needing attention/ });
    await attention.scrollIntoViewIfNeeded();
    await expect(attention).toContainText("7 need attention");
    await expect(attention).toContainText("1 emergency");
    expect(await attention.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test("keeps attention rows readable at the 320px minimum width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The minimum-width layout only needs one browser engine here.");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page.getByRole("button", { name: /Alerts/ }).click();
  const alerts = page.getByRole("region", { name: "Current alerts" });
  const rows = alerts.locator("li button");
  await expect(rows).toHaveCount(6);
  for (const row of await rows.all()) {
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }

  const firstRow = rows.first();
  const place = firstRow.locator("span").nth(1);
  const name = place.locator("strong");
  expect(await name.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
  expect(await place.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const metadataPart of await firstRow.locator("small > span").all()) {
    expect(await metadataPart.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test("keeps search results bounded with a single visible focus treatment", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Responsive layout styles only need one browser engine here.");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");

  const search = destinationSearch(page);
  await search.fill("a");
  const results = page.getByRole("listbox", { name: "Destination results" });
  await expect(results).toBeVisible();
  const popover = results.locator("..");
  expect((await popover.boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(412);
  expect(await search.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  expect(await search.locator("..").evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
});

test("keeps full-catalog and attention navigation available on tablets", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Responsive tablet controls only need one browser engine here.");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");

  const allDestinations = page.getByRole("button", { name: /Show all 503 destinations/ });
  const attention = page.getByRole("button", { name: /Open destinations needing attention/ });
  await expect(allDestinations).toBeVisible();
  await expect(attention).toBeVisible();
  await expect(allDestinations).toBeInViewport();
  await expect(attention).toBeInViewport();

  await attention.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Destinations needing attention" })).toBeVisible();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(attention).toBeFocused();
});

test("starts compact attribution collapsed without repeating its icon", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The narrow control layout only needs one browser engine here.");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });

  const attribution = page.locator("details.maplibregl-ctrl-attrib");
  const toggle = attribution.locator("summary");
  await expect(attribution).not.toHaveAttribute("open", "");
  await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);
  expect(await toggle.evaluate((element) => getComputedStyle(element).backgroundRepeat)).toBe("no-repeat");
  await toggle.click();
  await expect(attribution).toHaveClass(/maplibregl-compact-show/);
  await expect(attribution.getByRole("link", { name: "OpenFreeMap" })).toBeVisible();
});

test("does not draw a focus ring around programmatically focused dialogs", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Global focus styles only need one browser engine here.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Map filter:/ })).toBeVisible();
  await page.getByRole("button", { name: "Open app menu" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeFocused();
  expect(await dialog.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
});

test("keeps narrow map controls clear of bottom navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The 320px collision boundary only needs one browser engine.");
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
  }));
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });

  const allCoverage = page.getByRole("button", { name: /^All 503/ });
  const camera = page.getByLabel("Map camera controls");
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const [allCoverageBox, cameraBox, navigationBox] = await Promise.all([
    allCoverage.boundingBox(),
    camera.boundingBox(),
    navigation.boundingBox(),
  ]);
  expect(allCoverageBox && cameraBox && navigationBox).toBeTruthy();
  expect((allCoverageBox?.y ?? 0) + (allCoverageBox?.height ?? 0)).toBeLessThanOrEqual(navigationBox?.y ?? 0);
  expect((cameraBox?.y ?? 0) + (cameraBox?.height ?? 0)).toBeLessThanOrEqual(navigationBox?.y ?? 0);
});

