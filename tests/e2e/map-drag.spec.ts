import { expect, test } from "../playwright-fixtures";

test.describe.configure({ mode: "serial" });

test("mouse dragging pans the map, filters preserve the manual camera, and reset restores Europe", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
  }));
  await page.goto("/");
  const map = page.getByRole("region", { name: /^Interactive map/ });
  await expect(map).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
  await expect(map).toHaveAttribute("data-camera-mode", "core");
  const originalLongitude = Number(await map.getAttribute("data-camera-lng"));
  expect(await page.evaluate(() => document.elementFromPoint(700, 450)?.tagName)).toBe("CANVAS");
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(900, 500, { steps: 20 });
  await page.mouse.up();
  await expect(map).toHaveAttribute("data-camera-mode", "manual");
  await expect.poll(async () => Math.abs(Number(await map.getAttribute("data-camera-lng")) - originalLongitude)).toBeGreaterThan(0.5);
  // Let inertia finish before comparing the subsequent filter update.
  await expect.poll(async () => {
    const longitude = await map.getAttribute("data-camera-lng");
    await page.waitForTimeout(100);
    return longitude === await map.getAttribute("data-camera-lng");
  }).toBe(true);
  const pannedLongitude = await map.getAttribute("data-camera-lng");
  await page.getByRole("group", { name: "Map filters" }).getByRole("button", { name: /^High & Severe/ }).click();
  await expect(map).toHaveAttribute("data-camera-mode", "manual");
  await expect(map).toHaveAttribute("data-camera-lng", pannedLongitude!);
  await page.getByRole("button", { name: /Reset.*map|Reset.*Europe/i }).click();
  await expect(map).toHaveAttribute("data-camera-mode", "core");
  await expect.poll(async () => Math.abs(Number(await map.getAttribute("data-camera-lng")) - originalLongitude)).toBeLessThan(0.01);
});

test("a single-finger swipe pans the mobile map", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Chromium CDP provides trusted multi-step touch input.");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
      json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
    }));
    await page.goto(String(testInfo.project.use.baseURL));
    const map = page.getByRole("region", { name: /^Interactive map/ });
    await expect(map).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
    const originalLongitude = Number(await map.getAttribute("data-camera-lng"));
    expect(await page.evaluate(() => document.elementFromPoint(100, 450)?.tagName)).toBe("CANVAS");
    const session = await context.newCDPSession(page);
    const swipe = async () => {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 100, y: 450 }] });
      for (let step = 1; step <= 20; step += 1) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100 + step * 8, y: 450 + step * 2 }] });
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await swipe();
    await expect(map).toHaveAttribute("data-camera-mode", "manual");
    await expect.poll(async () => Math.abs(Number(await map.getAttribute("data-camera-lng")) - originalLongitude)).toBeGreaterThan(0.5);
    await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
    await page.getByRole("option", { name: /Vienna/ }).click();
    const details = page.getByRole("dialog", { name: "Vienna risk details" });
    await expect(details).toBeVisible();
    await details.getByRole("button", { name: "Close destination details" }).click();
    await expect(details).toBeHidden();
    await expect(page.getByRole("button", { name: "Close destination search" })).toBeHidden();
    await expect(map).toHaveAttribute("data-camera-mode", "manual");
    await expect.poll(() => page.evaluate(() => document.elementFromPoint(100, 450)?.tagName)).toBe("CANVAS");
    const restoredLongitude = Number(await map.getAttribute("data-camera-lng"));
    await swipe();
    await expect.poll(async () => Math.abs(Number(await map.getAttribute("data-camera-lng")) - restoredLongitude)).toBeGreaterThan(0.5);
  } finally { await context.close(); }
});

for (const entry of ["search", "direct link"] as const) test(`closing mobile destination details from ${entry} restores collapsed search focus and leaves the map uncovered`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
  }));
  await page.goto(entry === "direct link" ? "/?destination=at-vienna" : "/");
  await expect(page.locator('[data-locations-ready]')).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
  if (entry === "search") {
    await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
    await page.getByRole("option", { name: /Vienna/ }).click();
  }
  const details = page.getByRole("dialog", { name: "Vienna risk details" });
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Close destination details" }).click();
  await expect(details).toBeHidden();
  await expect(page.getByRole("button", { name: "Close destination search" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Show destination suggestions/ })).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(100, 450)?.tagName)).toBe("CANVAS");
  await page.getByRole("button", { name: /^Show destination suggestions/ }).press("Enter");
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await expect(search).toBeFocused();
  await search.fill("Vienna");
  const option = page.getByRole("option", { name: /Vienna/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(details).toBeVisible();
});
