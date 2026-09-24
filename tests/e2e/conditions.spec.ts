import { expect, test } from "../playwright-fixtures";
import AxeBuilder from "@axe-core/playwright";
import { demoPublication, demoPublicationWithConditions, installDemoPublicationObjects, isDemoConditionsRequest, mutateDemoConditions, routeAllDemoConditions, routeDemoConditions } from "./helpers";

function viennaPublication(temperature: number) {
  return demoPublicationWithConditions("AT", (conditions) => {
    const weather = conditions.locations["at-vienna"].weather!;
    weather.temperature = weather.temperature.map(() => temperature);
  });
}

test("an open destination uses the accepted publication and switches conditions on refresh", async ({ page }) => {
  const first = viennaPublication(11); const second = viennaPublication(22);
  await installDemoPublicationObjects(page, first);
  await installDemoPublicationObjects(page, second);
  let current = first; let failRefresh = false;
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/data(?:\?|$)|\/catalogs\/3\/generations\/.*\/manifest\.json$/.test(request.url())) requests.push(request.url());
  });
  await page.route(/\/api\/v1\/data(?:\?.*)?$/, (route) => failRefresh ? route.abort() : route.fulfill({ json: current.pointer }));
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(section.getByText(/Temperature 11 °C–11 °C/)).toBeVisible();
  expect(requests.filter((url) => url.includes("/api/v1/data"))).toHaveLength(1);
  expect(requests.filter((url) => url.includes("/manifest.json"))).toHaveLength(1);

  current = second;
  await page.locator('[data-ui="data-health-banner"]').getByRole("button", { name: "Retry" }).click();
  await expect(section.getByText(/Temperature 22 °C–22 °C/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
  expect(requests.filter((url) => url.includes("/api/v1/data"))).toHaveLength(2);
  expect(requests.filter((url) => url.includes("/manifest.json"))).toHaveLength(2);

  failRefresh = true;
  await page.locator('[data-ui="data-health-banner"]').getByRole("button", { name: "Retry" }).click();
  await expect(section.getByText(/Temperature 22 °C–22 °C/)).toBeVisible();
  await expect(page.getByText("Previously loaded alerts remain visible while the latest update is retried.")).toBeVisible();
});

test("a late condition response from the previous generation cannot replace the new one", async ({ page }) => {
  const first = viennaPublication(11); const second = viennaPublication(22);
  await installDemoPublicationObjects(page, first);
  await installDemoPublicationObjects(page, second);
  let current = first;
  let release!: () => void; let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const firstRequest = new Promise<void>((resolve) => { started = resolve; });
  const oldObject = first.conditionObjects![0];
  await page.route(`**/${oldObject.path}`, async (route) => {
    started(); await pending;
    await route.fulfill({ body: oldObject.body, contentType: "application/json" });
  });
  await page.route(/\/api\/v1\/data(?:\?.*)?$/, (route) => route.fulfill({ json: current.pointer }));
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  await firstRequest;
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(section.getByText("Loading local conditions…")).toBeVisible();
  current = second;
  await page.locator('[data-ui="data-health-banner"]').getByRole("button", { name: "Retry" }).click();
  await expect(section.getByText(/Temperature 22 °C–22 °C/)).toBeVisible();
  const oldResponse = page.waitForResponse((response) => response.url().endsWith(oldObject.path));
  release();
  const response = await oldResponse;
  await response.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(section.getByText(/Temperature 11 °C–11 °C/)).toHaveCount(0);
  await expect(section.getByText(/Temperature 22 °C–22 °C/)).toBeVisible();
});

test("local retry restores a missing shared publication", async ({ page }) => {
  const fixture = demoPublication();
  await installDemoPublicationObjects(page, fixture);
  let unavailable = true; let pointerRequests = 0;
  await page.route(/\/api\/v1\/data(?:\?.*)?$/, (route) => {
    pointerRequests += 1;
    return unavailable ? route.abort() : route.fulfill({ json: fixture.pointer });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(section.getByText("Local conditions unavailable. Alert information is unaffected.")).toBeVisible();
  expect(pointerRequests).toBe(1);
  unavailable = false;
  await section.getByRole("button", { name: "Retry local conditions" }).click();
  await expect(section.getByRole("heading", { name: "Forecast", exact: true })).toBeVisible();
  expect(pointerRequests).toBe(2);
});

test("conditions are lazy, isolated, and available for all five island destinations", { tag: "@smoke" }, async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (isDemoConditionsRequest(request.url())) requests.push(request.url()); });
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
  await routeAllDemoConditions(page, (route) => route.abort());
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  await expect(page.getByText("Local conditions unavailable. Alert information is unaffected.")).toBeVisible();
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
  await expect(page.getByText("Current · updated just now")).toBeVisible();
});

test("a completed empty conditions publication distinguishes a failed source from unsupported data", async ({ page }) => {
  await mutateDemoConditions(page, "AT", (conditions) => {
    const vienna = conditions.locations["at-vienna"];
    delete vienna.weather; delete vienna.airQuality; delete vienna.marine;
    vienna.observations = []; vienna.rivers = []; vienna.earthquakes = [];
    vienna.infrastructureIncidents = []; vienna.systemConditions = [];
    vienna.limitations = ["update-pending"];
    conditions.sourceHealth["awc-metar"] = { status: "failed", checkedAt: conditions.generatedAt, limitationCode: "source_unavailable" };
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Vienna");
  await page.getByRole("option", { name: /Vienna/ }).click();
  const section = page.getByRole("region", { name: "Local conditions", exact: true });
  await expect(section.getByRole("status")).toHaveText("Local conditions unavailable. Alert information is unaffected.");
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
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
  await mutateDemoConditions(page, "FI", (conditions) => {
    conditions.sourceHealth.digitraffic = { status: "failed", checkedAt: conditions.generatedAt, limitationCode: "source_unavailable" };
    conditions.locations["fi-helsinki"].infrastructureIncidents = [];
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
  await mutateDemoConditions(page, "NL", (conditions) => {
    delete conditions.locations["nl-rotterdam"].airQuality;
    delete conditions.locations["nl-rotterdam"].marine;
    conditions.locations["nl-rotterdam"].limitations = [];
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
  const pageErrors: Error[] = []; page.on("pageerror", (error) => pageErrors.push(error));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const alertRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/catalogs/3/publication/latest.json")) alertRequests.push(request.url()); });
  await routeDemoConditions(page, "AT", async (route) => {
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
  expect(pageErrors).toEqual([]);
  expect(alertRequests).toHaveLength(alertsBefore);
  await expect(page.getByText("No major alert found in checked sources", { exact: true })).toBeVisible();
});

test("conditions recovery does not steal focus moved during a pending retry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The compact dialog intentionally traps focus.");
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await routeDemoConditions(page, "AT", async (route) => {
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
  await routeAllDemoConditions(page, (route) => route.abort());
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
  await routeDemoConditions(page, "PT", async (route) => { await delayed; await route.continue(); });
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
  await mutateDemoConditions(page, "DE", (conditions) => {
    const now = Date.parse(conditions.generatedAt);
    conditions.locations["de-berlin"].infrastructureIncidents = [{
      id: "autobahn:A100:scheduled", sourceId: "autobahn-traffic", status: "planned", kind: "road-closure",
      scope: "destination", scopeLabel: "A100 near Berlin", sourceUpdatedAt: null,
      checkedAt: new Date(now - 30 * 60000).toISOString(), startsAt: new Date(now - 15 * 60000).toISOString(),
      endsAt: new Date(now + 3600000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
      estimatedRestorationAt: null, sourceUrl: "https://www.autobahn.de/verkehr",
    }];
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Where are you going?" }).fill("Berlin");
  await page.getByRole("option", { name: /^Berlin Germany/ }).click();
  const infrastructure = page.getByRole("region", { name: "Infrastructure disruptions" });
  await expect(infrastructure.getByRole("heading", { name: "Active now" })).toBeVisible();
  await expect(infrastructure.getByRole("heading", { name: "Planned in the next 24 hours" })).toHaveCount(0);
  await expect(infrastructure.getByText("A100 near Berlin", { exact: false })).toBeVisible();
});
