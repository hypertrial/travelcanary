import { expect, test } from "../playwright-fixtures";
import AxeBuilder from "@axe-core/playwright";

test("conditions are lazy, isolated, and available for all five island destinations", { tag: "@smoke" }, async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (/\/conditions\/v2\//.test(request.url())) requests.push(request.url()); });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await expect(search).toBeEnabled(); expect(requests).toEqual([]);
  for (const name of ["Ponta Delgada", "Horta", "Santa Cruz das Flores", "Las Palmas", "Santa Cruz de Tenerife"]) {
    await search.fill(name);
    await page.getByRole("option", { name: new RegExp(name) }).click();
    const section = page.getByRole("region", { name: "Local conditions", exact: true });
    await expect(section.getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
    await expect(section.getByRole("heading", { name: "Modeled air quality", exact: true })).toBeVisible();
    const hourly = section.locator("summary").filter({ hasText: "Hourly forecast" });
    await hourly.focus(); await page.keyboard.press("Enter");
    await expect(section.locator("details").first()).toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Close destination details" }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("destination"));
    const isMobile = await page.evaluate(() => matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)").matches);
    await expect(isMobile ? page.getByRole("button", { name: "Show destination suggestions" }) : search).toBeFocused();
    await expect(search).toHaveValue("");
  }
  expect(requests).toHaveLength(2); // three Portuguese, two Spanish destinations share cached files
  await page.setViewportSize({ width: 320, height: 700 });
  await search.fill("Santa Cruz das Flores"); await page.getByRole("option", { name: /Santa Cruz das Flores/ }).click();
  await expect(page.getByRole("region", { name: "Local conditions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Flores conditions are accessible at the narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Santa Cruz das Flores");
  await page.getByRole("option", { name: /Santa Cruz das Flores/ }).click();
  const conditions = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(conditions.getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
  await expect(conditions.getByRole("heading", { name: "Modeled air quality", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("offline conditions leave the map and risk result working", async ({ page }) => {
  await page.route("**/conditions/v2/*.json", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  await expect(page.getByText("Local conditions are unavailable. Alert information is unaffected.")).toBeVisible();
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
  await expect(page.getByText("Current · updated just now")).toBeVisible();
});

test("infrastructure context stays in destination details and separates active, planned, and national advisories", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Helsinki"); await page.getByRole("option", { name: /Helsinki/ }).click();
  const helsinki = page.getByRole("region", { name: "Infrastructure disruptions" });
  await expect(helsinki.getByRole("heading", { name: "Active now" })).toBeVisible();
  await expect(helsinki.getByText(/Reported road closure/)).toBeVisible();
  await expect(helsinki.getByText("Nearby context only; this does not identify your route.")).toBeVisible();
  await expect(helsinki.getByRole("link", { name: "Fintraffic Digitraffic (opens in a new tab)" })).toHaveCount(1);
  await expect(helsinki.getByText(/Source updated.+Checked/)).toBeVisible();
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close destination details" }).click();

  await search.fill("Amsterdam"); await page.getByRole("option", { name: /Amsterdam/ }).click();
  const amsterdam = page.getByRole("region", { name: "Infrastructure disruptions" });
  await expect(amsterdam.getByRole("heading", { name: "Planned in the next 24 hours" })).toBeVisible();
  await expect(amsterdam.getByText(/Planned road closure/)).toBeVisible();
  await page.getByRole("button", { name: "Close destination details" }).click();

  await search.fill("Warsaw"); await page.getByRole("option", { name: /Warsaw/ }).click();
  const advisory = page.getByRole("region", { name: "National electricity system advisory" });
  await expect(advisory.getByText(/recommends reducing electricity use/)).toBeVisible();
  await expect(advisory.getByText("This describes Poland’s electricity system and does not indicate a local power outage.")).toBeVisible();
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
});

test("an infrastructure source failure is local and does not become an alert-health failure", async ({ page }) => {
  await page.route("**/conditions/v2/FI.json", async (route) => {
    const response = await route.fetch(); const conditions = await response.json();
    conditions.sourceHealth.digitraffic = { status: "failed", checkedAt: conditions.generatedAt, limitationCode: "source_unavailable" };
    conditions.locations["fi-helsinki"].infrastructureIncidents = [];
    await route.fulfill({ response, json: conditions });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Helsinki");
  await page.getByRole("option", { name: /Helsinki/ }).click();
  const infrastructure = page.getByRole("region", { name: "Infrastructure disruptions" });
  await expect(infrastructure.getByRole("status")).toContainText("Local infrastructure updates are incomplete");
  await expect(infrastructure.getByRole("link", { name: "Fintraffic Digitraffic (opens in a new tab)" })).toBeVisible();
  await expect(infrastructure.getByText(/Update failed/)).toBeVisible();
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
});

test("reviewed Rijkswaterstaat water levels remain labeled observations, not alerts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Rotterdam");
  await page.getByRole("option", { name: /Rotterdam/ }).click();
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(section.getByRole("heading", { name: "Observed at Rotterdam, Nieuwe Maas, Boerengat" })).toBeVisible();
  await expect(section.getByText(/Water level: -4 cm/)).toBeVisible();
  await expect(section.getByText(/Datum: NAP · Source quality: 00 \(provisional\)/)).toBeVisible();
  await expect(section.getByRole("link", { name: /Rijkswaterstaat Waterdata/ })).toHaveAttribute("href", "https://rijkswaterstaatdata.nl/waterdata/");
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
});

test("partial conditions name each missing expected forecast without relying on server limitations", async ({ page }) => {
  await page.route("**/conditions/v2/NL.json", async (route) => {
    const response = await route.fetch();
    const conditions = await response.json();
    delete conditions.locations["nl-rotterdam"].airQuality;
    delete conditions.locations["nl-rotterdam"].marine;
    conditions.locations["nl-rotterdam"].limitations = [];
    await route.fulfill({ response, json: conditions });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Rotterdam");
  await page.getByRole("option", { name: /Rotterdam/ }).click();
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(section.getByText("Current modeled air quality and nearby offshore forecast are unavailable. Other current local data is shown below.")).toBeVisible();
  await expect(section.getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Observed at Rotterdam, Nieuwe Maas, Boerengat" })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Modeled air quality", exact: true })).toHaveCount(0);
  await expect(section.getByRole("heading", { name: "Nearby offshore forecast", exact: true })).toHaveCount(0);
});

test("conditions can be retried locally without reloading alerts or leaving the briefing", async ({ page }, testInfo) => {
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const alertRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("demo-snapshot.json")) alertRequests.push(request.url()); });
  await page.route("**/conditions/v2/AT.json", async (route) => {
    attempts += 1;
    if (attempts === 1) return route.abort();
    await pending;
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  const retry = section.getByRole("button", { name: "Retry local conditions" });
  await expect(retry).toBeVisible();
  await retry.scrollIntoViewIfNeeded();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("conditions-retry.png") });
  const alertsBefore = alertRequests.length;
  await retry.focus(); await page.keyboard.press("Enter");
  await expect(retry).toBeDisabled();
  await expect(section.getByRole("status")).toHaveText("Loading local conditions…");
  release();
  await expect(section.getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(section.getByRole("heading", { name: "Local conditions", exact: true })).toBeFocused();
  expect(attempts).toBe(2);
  expect(alertRequests).toHaveLength(alertsBefore);
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
});

test("conditions recovery does not steal focus moved during a pending retry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The compact dialog intentionally traps focus.");
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/conditions/v2/AT.json", async (route) => {
    attempts += 1;
    if (attempts === 1) return route.abort();
    await pending;
    await route.continue();
  });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  await page.getByRole("button", { name: "Retry local conditions" }).click();
  await search.focus();
  release();
  await expect(page.getByRole("region", { name: "Local conditions", exact: true }).getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
  await expect(search).toBeFocused();
});

test("direct attention selection resets the briefing scroll and disclosure state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Compact modal blocks background selection; close/reopen already resets it.");
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Klagenfurt");
  await page.getByRole("option", { name: /Klagenfurt/ }).click();
  const attribution = page.getByRole("region", { name: "Local conditions", exact: true }).locator("summary").filter({ hasText: "Sources and attribution" });
  await attribution.click();
  await expect(attribution.locator("..")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: /Open destinations needing attention/ }).click();
  await page.getByRole("button", { name: "Graz Austria · Active now Consider changing plans" }).click();
  const drawer = page.getByRole("complementary", { name: "Graz risk details" });
  await expect(drawer).toBeFocused();
  await expect(drawer.getByRole("region", { name: "Suggested action" })).toBeInViewport();
  await expect(attribution.locator("..")).not.toHaveAttribute("open", "");
});

test("conditions recovery fits narrow screens with reduced motion and accessible focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce", ...(testInfo.project.name === "desktop-chromium" ? { forcedColors: "active" as const } : {}) });
  await page.route("**/conditions/v2/*.json", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Santa Cruz das Flores");
  await page.getByRole("option", { name: /Santa Cruz das Flores/ }).click();
  const retry = page.getByRole("button", { name: "Retry local conditions" });
  await retry.focus();
  await expect(retry).toBeInViewport();
  await expect(retry).toBeFocused();
  if (testInfo.project.name === "mobile-webkit") {
    await expect(page.getByRole("heading", { name: "Santa Cruz das Flores", exact: true }).locator("..")).toHaveCSS("background-color", "rgb(255, 253, 246)");
  }
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("conditions-recovery-320.png") });
});

test("late conditions from an obsolete destination do not replace the selected country", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/conditions/v2/PT.json", async (route) => { await delayed; await route.continue(); });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Horta"); await page.getByRole("option", { name: /Horta/ }).click();
  await expect(page.getByText("Loading local conditions…")).toBeVisible();
  await page.getByRole("button", { name: "Close destination details" }).click();
  await search.fill("Vienna"); await page.getByRole("option", { name: /Vienna/ }).click();
  release();
  await expect(page.getByRole("region", { name: "Local conditions", exact: true }).getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
});

test("shows a cached planned closure whose start has passed as active", async ({ page }) => {
  await page.route("**/conditions/v2/DE.json", async (route) => {
    const response = await route.fetch();
    const conditions = await response.json();
    const now = Date.parse(conditions.generatedAt);
    conditions.locations["de-berlin"].infrastructureIncidents = [{
      id: "autobahn:A100:scheduled", sourceId: "autobahn-traffic", status: "planned", kind: "road-closure",
      scope: "destination", scopeLabel: "A100 near Berlin", sourceUpdatedAt: null,
      checkedAt: new Date(now - 30 * 60000).toISOString(), startsAt: new Date(now - 15 * 60000).toISOString(),
      endsAt: new Date(now + 3600000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
      estimatedRestorationAt: null, sourceUrl: "https://www.autobahn.de/verkehr",
    }];
    await route.fulfill({ response, json: conditions });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Berlin");
  await page.getByRole("option", { name: /^Berlin Germany/ }).click();
  const infrastructure = page.getByRole("region", { name: "Infrastructure disruptions" });
  await expect(infrastructure.getByRole("heading", { name: "Active now" })).toBeVisible();
  await expect(infrastructure.getByRole("heading", { name: "Planned in the next 24 hours" })).toHaveCount(0);
  await expect(infrastructure.getByText("A100 near Berlin", { exact: false })).toBeVisible();
});
