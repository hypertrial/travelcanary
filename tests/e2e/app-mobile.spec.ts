import { type Locator } from "@playwright/test";
import { expect, test } from "../playwright-fixtures";
import { destinationSearch, selectDestination } from "./helpers";

test("closes full-screen mobile search with Escape", { tag: "@webkit-only" }, async ({ page }) => {
  await page.goto("/");
  const search = destinationSearch(page);
  await search.focus();
  await search.fill("Vien");
  await expect(page.getByText("Find a destination", { exact: true })).toBeVisible();
  await search.press("Escape");
  await expect(page.getByText("Find a destination", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Show destination suggestions" })).toBeFocused();
});

test("keeps mobile navigation behind full-screen search", { tag: "@webkit-only" }, async ({ page }) => {
  await page.goto("/");
  const search = destinationSearch(page);
  await search.fill("Santa");
  await expect(page.getByRole("listbox", { name: "Destination results" })).toBeVisible();

  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
  const navigation = page.locator('nav[aria-label="Primary navigation"]');
  const box = await navigation.boundingBox();
  expect(box).toBeTruthy();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('nav[aria-label="Primary navigation"]') !== null, {
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  })).toBe(false);
});

test("uses a dismissible focus-trapped sheet on compact screens", { tag: "@webkit-only" }, async ({ page }) => {
  await page.goto("/");
  await selectDestination(page, "Klagenfurt", /Klagenfurt/);
  const dialog = page.getByRole("dialog", { name: /Klagenfurt/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Flooding is affecting Klagenfurt am Wörthersee.");
  for (let step = 0; step < 5; step += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /^Show destination suggestions/ })).toBeFocused();

  await selectDestination(page, "Klagenfurt", /Klagenfurt/);
  await page.mouse.click(195, 96);
  await expect(page.getByRole("dialog", { name: /Klagenfurt/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Show destination suggestions/ })).toBeFocused();
});

test("tracks mobile sheet drags and snaps between peek, expanded, and closed", { tag: "@webkit-only" }, async ({ page }) => {
  const waitForStableSheet = async (sheet: Locator) => {
    let previousHeight = -1;
    let stableSamples = 0;
    await expect.poll(async () => {
      const height = (await sheet.boundingBox())?.height ?? 0;
      stableSamples = Math.abs(height - previousHeight) < 0.5 ? stableSamples + 1 : 0;
      previousHeight = height;
      return stableSamples;
    }, { intervals: [50, 50, 50, 50, 50, 50], timeout: 2_000 }).toBeGreaterThanOrEqual(2);
    return sheet.boundingBox();
  };
  await page.goto("/");
  await selectDestination(page, "Klagenfurt", /Klagenfurt/);

  const dialog = page.getByRole("dialog", { name: /Klagenfurt/ });
  const sheet = dialog.locator("..");
  const dragHandle = page.getByRole("button", { name: "Expand destination details" }).locator("..");
  const initial = await sheet.boundingBox();
  const handleBox = await dragHandle.boundingBox();
  expect(initial && handleBox).toBeTruthy();

  const x = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
  const y = (handleBox?.y ?? 0) + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 96, { steps: 4 });
  const tracking = await sheet.boundingBox();
  expect((tracking?.height ?? 0) - (initial?.height ?? 0)).toBeGreaterThan(60);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Collapse destination details" })).toBeVisible();
  const expanded = await waitForStableSheet(sheet);
  expect((expanded?.height ?? 0) - (initial?.height ?? 0)).toBeGreaterThan(120);

  const expandedHandle = await page.getByRole("button", { name: "Collapse destination details" }).locator("..").boundingBox();
  expect(expandedHandle).toBeTruthy();
  const expandedY = (expandedHandle?.y ?? 0) + 8;
  await page.mouse.move(x, expandedY);
  await page.mouse.down();
  await page.mouse.move(x, expandedY + 96, { steps: 4 });
  const collapsing = await sheet.boundingBox();
  expect((expanded?.height ?? 0) - (collapsing?.height ?? 0)).toBeGreaterThan(60);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Expand destination details" })).toBeVisible();
  const collapsed = await waitForStableSheet(sheet);
  expect((expanded?.height ?? 0) - (collapsed?.height ?? 0)).toBeGreaterThan(80);

  const peekHandle = await page.getByRole("button", { name: "Expand destination details" }).locator("..").boundingBox();
  expect(peekHandle).toBeTruthy();
  const peekY = (peekHandle?.y ?? 0) + 8;
  await page.mouse.move(x, peekY);
  await page.mouse.down();
  await page.mouse.move(x, peekY + 112, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeHidden();
});

test("keeps primary compact controls at least 44 by 44 pixels", { tag: "@webkit-only" }, async ({ page }) => {
  await page.goto("/");
  await expect(destinationSearch(page)).toBeEnabled();
  const controls = [
    page.getByRole("button", { name: "Show destination suggestions" }),
    page.getByRole("button", { name: /Map filter:/ }),
    page.getByRole("button", { name: "Open app menu" }),
    page.getByRole("button", { name: "Zoom in" }),
    page.getByRole("button", { name: "Zoom out" }),
    page.locator(".maplibregl-ctrl-attrib-button"),
  ];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

