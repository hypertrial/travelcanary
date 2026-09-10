import { expect, test } from "../playwright-fixtures";
import { close, prepareCatalog3Page, select } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await prepareCatalog3Page(page);
});

test("the first map drag enters manual camera mode and selection close preserves it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await page.goto("/");
  const map = page.getByRole("region", { name: /^Interactive map/ });
  await expect(map).toHaveAttribute("data-locations-ready", "true", { timeout: 30000 });
  const original = Number(await map.getAttribute("data-camera-lng"));
  expect(await page.evaluate(() => document.elementFromPoint(700, 450)?.tagName)).toBe("CANVAS");
  await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(900, 500, { steps: 20 }); await page.mouse.up();
  await expect(map).toHaveAttribute("data-camera-mode", "manual");
  await expect.poll(async () => Math.abs(Number(await map.getAttribute("data-camera-lng")) - original)).toBeGreaterThan(0.5);
  await select(page, "gb-london"); await close(page); await expect(map).toHaveAttribute("data-camera-mode", "manual");
});

