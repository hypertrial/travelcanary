import { expect, test } from "../playwright-fixtures";

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

test("warm exact-name selection closes search, exposes the briefing, and permits the first map drag", async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#c6c2b8" } }] },
  }));
  await page.goto("/");
  const map = page.getByRole("region", { name: /^Interactive map/ });
  await expect(map).toHaveAttribute("data-locations-ready", "true", { timeout: 30_000 });
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  const briefing = page.getByRole("complementary", { name: "Paris risk details" });

  // Warm the briefing code before repeating selection through exact Enter.
  await search.fill("Paris");
  await page.getByRole("option", { name: /^Paris France/ }).click();
  await expect(briefing).toBeVisible();
  await briefing.getByRole("button", { name: "Close destination details" }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("destination"));
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");

  await search.fill("Paris");
  await expect(page.getByRole("option", { name: /^Paris France/ })).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL((url) => url.searchParams.get("destination") === "fr-paris");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(briefing).toBeVisible();
  await expect(briefing).toBeFocused();
  await expect(map).toHaveAttribute("data-camera-mode", "destination");

  const longitude = Number(await map.getAttribute("data-camera-lng"));
  const canvas = page.locator("canvas.maplibregl-canvas");
  const bounds = (await canvas.boundingBox())!;
  const start = { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.5 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, start)).toBe("CANVAS");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 150, start.y + 50, { steps: 15 });
  await page.mouse.up();
  await expect(map).toHaveAttribute("data-camera-mode", "manual");
  await expect.poll(async () => Math.abs(Number(await map.getAttribute("data-camera-lng")) - longitude)).toBeGreaterThan(0.1);
});
