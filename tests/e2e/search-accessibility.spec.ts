import { expect, test } from "../playwright-fixtures";

for (const query of ["", "Vienna"]) {
  test(`mobile search exposes a working Close button with ${query ? "nonempty suggestions" : "an empty query"}`, { tag: "@webkit-only" }, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
      json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
    }));
    await page.goto("/");
    await expect(page.locator('[data-locations-ready]')).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
    const search = page.getByRole("combobox", { name: "Where are you going?" });
    const trigger = page.getByRole("button", { name: /^Show destination suggestions/ });
    await trigger.click();
    await expect(search).toBeFocused();
    if (query) {
      await search.fill(query);
      await expect(page.getByRole("option", { name: /Vienna/ })).toBeVisible();
    }
    const close = page.getByRole("button", { name: "Close destination search" });
    await expect(close).toBeVisible();
    await close.focus();
    await close.press("Enter");
    await expect(close).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(search).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.elementFromPoint(290, 450)?.tagName)).toBe("CANVAS");

    await trigger.press("Enter");
    await expect(search).toBeFocused();
    await search.fill("Vienna");
    await expect(close).toBeVisible();
    const option = page.getByRole("option", { name: /Vienna/ });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.getByRole("dialog", { name: "Vienna risk details" })).toBeVisible();
    await expect(close).toBeHidden();
  });
}

test("mobile search Close stays hittable while suggestions scroll at narrow and landscape sizes", { tag: "@smoke" }, async ({ page }, testInfo) => {
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
  }));
  for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator('[data-locations-ready]')).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
    const search = page.getByRole("combobox", { name: "Where are you going?" });
    await search.fill("Paris");
    await expect(page.getByRole("option", { name: /^Paris France/ })).toBeVisible();
    // Desktop devices retain the desktop search at this landscape width.
    if (viewport.width === 844 && testInfo.project.name === "desktop-chromium") continue;
    const listbox = page.getByRole("listbox");
    const scrollOffset = await listbox.evaluate((element) => {
      let scrollable: Element | null = element;
      while (scrollable && scrollable.scrollHeight <= scrollable.clientHeight) scrollable = scrollable.parentElement;
      if (!scrollable) return 0;
      scrollable.scrollTop = scrollable.scrollHeight;
      return scrollable.scrollTop;
    });
    if (viewport.height <= 700) expect(scrollOffset).toBeGreaterThan(0);
    const close = page.getByRole("button", { name: "Close destination search" });
    await expect(close).toBeVisible();
    const box = (await close.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await close.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await page.screenshot({ path: `/tmp/travelcanary-search-close-${testInfo.project.name}-${viewport.width}.png` });
    await close.click();
    await expect(close).toBeHidden();
    await expect(search).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName,
      { x: Math.round(viewport.width * 0.75), y: viewport.height > 500 ? 450 : 250 })).toBe("CANVAS");
  }
});
