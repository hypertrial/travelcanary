import { expect, test } from "../playwright-fixtures";

for (const selection of ["pointer", "keyboard", "exact Enter"] as const) {
  test(`opens the Paris briefing by ${selection} when deferred assets are unavailable`, async ({ page }) => {
    const conditionRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/conditions\/v2\//.test(request.url())) conditionRequests.push(request.url());
    });
    await page.goto("/");
    const search = page.getByRole("combobox", { name: "Where are you going?" });
    await search.fill("Paris");
    const option = page.getByRole("option", { name: /^Paris France/ });
    await expect(option).toBeVisible();
    expect(conditionRequests).toEqual([]);

    // Search is already interactive. A selection must not depend on another
    // application chunk arriving before it can show the destination briefing.
    await page.route(/\/_next\/static\/.*\.(?:js|css)(?:\?.*)?$/, (route) => route.abort());
    if (selection === "pointer") await option.click();
    else {
      if (selection === "keyboard") await search.press("ArrowDown");
      await search.press("Enter");
    }

    await expect(page).toHaveURL(/destination=fr-paris/);
    const briefing = page.getByRole("complementary", { name: "Paris risk details" })
      .or(page.getByRole("dialog", { name: "Paris risk details" }));
    await expect(briefing).toBeVisible({ timeout: 3000 });
    await expect(briefing.getByRole("heading", { name: "Paris", exact: true })).toBeVisible();
    await expect(briefing.getByRole("button", { name: "Close destination details" })).toBeVisible();
    await expect(briefing.getByRole("alert")).toHaveText("Monitoring details and local conditions could not load. Destination alerts are still available.");
    await expect(briefing.getByRole("button", { name: "Reload page to retry monitoring details and local conditions" })).toBeVisible();
    expect(conditionRequests).toEqual([]);
    if (selection === "keyboard") {
      await page.goBack();
      await expect(briefing).toBeHidden();
      await expect(page).not.toHaveURL(/destination=/);
      await page.goForward();
      await expect(briefing).toBeVisible({ timeout: 3000 });
    }
    await briefing.getByRole("button", { name: "Close destination details" }).click();
    await expect(briefing).toBeHidden();
    await expect(page).not.toHaveURL(/destination=/);
  });
}

test("keeps the briefing usable while optional conditions code is delayed, then displays the conditions", async ({ page }) => {
  const conditionRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/conditions\/v2\//.test(request.url())) conditionRequests.push(request.url());
  });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Paris");
  const option = page.getByRole("option", { name: /^Paris France/ });
  await expect(option).toBeVisible();
  let release = () => {};
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/_next\/static\/.*\.(?:js|css)(?:\?.*)?$/, async (route) => {
    await delayed;
    await route.continue();
  });
  try {
    await option.click();
    const briefing = page.getByRole("complementary", { name: "Paris risk details" })
      .or(page.getByRole("dialog", { name: "Paris risk details" }));
    await expect(briefing).toBeVisible({ timeout: 3000 });
    await expect(briefing.getByRole("heading", { name: "Paris", exact: true })).toBeVisible();
    await expect(briefing.getByRole("button", { name: "Close destination details" })).toBeVisible();
    await expect(briefing.getByRole("status").filter({ hasText: "Loading monitoring details and local conditions…" })).toBeVisible();
    expect(conditionRequests).toEqual([]);
    release();
    const conditions = briefing.getByRole("region", { name: "Local conditions", exact: true });
    await expect(conditions.getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
    expect(conditionRequests).toHaveLength(1);
    expect(new URL(conditionRequests[0]).pathname).toMatch(/\/conditions\/v2\/FR\.json$/);
    await briefing.getByRole("button", { name: "Close destination details" }).click();
    await expect(briefing).toBeHidden();
  } finally { release(); }
});

test("keeps destination hazard guidance and evidence available when optional context code fails", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Klagenfurt");
  const option = page.getByRole("option", { name: /Klagenfurt/ });
  await expect(option).toBeVisible();
  await page.route(/\/_next\/static\/.*\.(?:js|css)(?:\?.*)?$/, (route) => route.abort());
  await option.click();
  const briefing = page.getByRole("complementary", { name: /Klagenfurt.*risk details/ })
    .or(page.getByRole("dialog", { name: /Klagenfurt.*risk details/ }));
  await expect(briefing).toBeVisible({ timeout: 3000 });
  await expect(briefing.getByRole("heading", { name: "Flooding is affecting Klagenfurt am Wörthersee." })).toBeVisible();
  await expect(briefing.getByRole("region", { name: "Suggested action" })).toBeVisible();
  await expect(briefing.getByRole("link", { name: /opens in a new tab/ }).first()).toBeVisible();
  await expect(briefing.getByRole("alert")).toHaveText("Monitoring details and local conditions could not load. Destination alerts are still available.");
  await briefing.getByRole("button", { name: "Close destination details" }).click();
  await expect(briefing).toBeHidden();
});
