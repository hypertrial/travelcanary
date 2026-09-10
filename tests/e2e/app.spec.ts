import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "../playwright-fixtures";
import { destinationSearch, destinationDetails, selectDestination, mutateDemoSnapshot } from "./helpers";

test("uses the TravelCanary brand and canonical identity", { tag: "@smoke" }, async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("TravelCanary — Europe location risk");
  await expect(page.getByRole("link", { name: "TravelCanary, current Europe location risk. Alpha preview", exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile-webkit") await expect(page.getByText("ALPHA · PREVIEW", { exact: true })).toBeHidden();
  else await expect(page.getByText("ALPHA · PREVIEW", { exact: true })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://travelcanary.org");
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
});

test("publishes installable metadata without registering a service worker", async ({ page, request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  expect(await response.json()).toMatchObject({
    id: "/",
    scope: "/",
    start_url: "/",
    display: "standalone",
    theme_color: "#012f62",
    background_color: "#f1eee4",
  });
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  expect(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length || 0)).toBe(0);
});

test("restores validated destination, view, and filter state through the URL", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "History behavior is browser-independent and covered once.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?destination=pt-horta&view=alerts&filter=high");
  await expect(page.getByRole("button", { name: /Alerts/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: /Map filter: High & Severe/ })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Horta risk details/ })).toBeVisible();
  await page.getByRole("button", { name: "Close destination details" }).click();
  await expect(page).toHaveURL(/view=alerts&filter=high/);
  expect(new URL(page.url()).searchParams.has("destination")).toBe(false);
  await page.goto("/?destination=not-in-catalog&view=globe&filter=quiet");
  await expect(page).toHaveURL(/\/$/);
});

test("preserves pushed destination history for Back and Forward", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "History behavior is browser-independent and covered once.");
  await page.goto("/");
  await selectDestination(page, "Vienna", /Vienna/);
  await expect(page).toHaveURL(/destination=at-vienna/);
  await page.getByRole("button", { name: "Close destination details" }).click();
  await expect(page).not.toHaveURL(/destination=/);
  await expect(page.getByRole("complementary", { name: /Vienna/ })).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/destination=at-vienna/);
  await expect(page.locator("main")).toHaveAttribute("data-selected-id", "at-vienna");
  await expect(page.getByRole("complementary", { name: /Vienna/ })).toBeVisible();
});

test("unknown routes offer an accessible return to destination search", async ({ page }) => {
  const response = await page.goto("/ui-audit-missing-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  const home = page.getByRole("link", { name: "Return to the map", exact: true });
  await home.focus();
  await expect(home).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(destinationSearch(page)).toBeEnabled();
});

test("the coverage legend does not equate monitoring completeness with freshness", async ({ page }) => {
  await page.goto("/");
  await selectDestination(page, "Vienna", /Vienna/);
  await destinationDetails(page).locator("summary").filter({ hasText: "What these labels mean" }).click();
  await expect(destinationDetails(page).getByText("Approved sources monitor this check. See Source updates for freshness.", { exact: true })).toBeVisible();
});

test("searches and explains a destination", { tag: "@smoke" }, async ({ page }) => {
  const upstreamRequests: string[] = [];
  page.on("request", (request) => {
    if (/meteoalarm|earthquake\.usgs|effis\.emergency|rapidmapping\.emergency/.test(request.url())) upstreamRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Demo data. Not live." })).toBeVisible();
  await destinationSearch(page).fill("Austrian Alps");
  await expect(page.getByRole("option", { name: /Austrian Alps/ }).getByText("Be aware")).toBeVisible();
  await page.getByRole("option", { name: /Austrian Alps/ }).click();
  await expect(destinationDetails(page)).toBeVisible();
  const panel = destinationDetails(page);
  await expect(panel.getByRole("heading", { name: "Austrian Alps", exact: true })).toBeVisible();
  await expect(panel.getByText("Be aware")).toBeVisible();
  await expect(panel.getByText("What to do")).toBeVisible();
  await expect(panel.getByText("Source updated")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Fire danger is affecting Austrian Alps.", exact: true })).toHaveCount(1);
  await expect(panel.getByText("Evidence · 2 sources", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: /source: EFFIS/i })).toBeVisible();
  await expect(panel.getByRole("link", { name: /source: Copernicus wildfire context/i })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "What TravelCanary checks for Austrian Alps" })).toBeVisible();
  const actionPrecedesCoverage = await panel.getByText("What to do").evaluate((action, coverageHeading) => (
    Boolean(action.compareDocumentPosition(coverageHeading as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
  ), await panel.getByRole("heading", { name: "What TravelCanary checks for Austrian Alps" }).elementHandle());
  expect(actionPrecedesCoverage).toBe(true);
  expect(upstreamRequests).toEqual([]);
});

test("supports keyboard-only search and selection", { tag: "@smoke" }, async ({ page }, testInfo) => {
  await page.goto("/");
  const search = destinationSearch(page);
  await expect(search).toBeEnabled();
  if (testInfo.project.name === "desktop-chromium") {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "TravelCanary, current Europe location risk. Alpha preview", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Open app menu" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(search).toBeFocused();
  } else {
    await search.focus();
  }
  await expect(page.getByRole("listbox", { name: "Destination results" })).toHaveCount(0);
  await search.fill("Vienna");
  const viennaOption = page.getByRole("option", { name: /Vienna/ });
  await expect(viennaOption).toBeVisible();
  await expect(viennaOption.getByText("No major alert found")).toBeVisible();
  await expect(viennaOption).toHaveAccessibleName(/No major alert found in checked sources/);
  await expect(viennaOption.locator('[data-level="NORMAL"] svg')).toHaveCount(1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(destinationDetails(page).getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
  const panel = destinationDetails(page);
  await expect(panel.getByText("No major alert found in checked sources", { exact: true })).toHaveCount(1);
  await expect(panel.getByText("No major alert found in checked sources", { exact: true }).locator("svg")).toHaveCount(1);
  await expect(panel.getByText("Review source freshness and monitoring gaps for Vienna below.")).toHaveCount(1);
  await expect(panel.getByText("Current · updated just now")).toBeVisible();
  await expect(panel.getByText("3 fully checked · 3 partly checked · 2 not checked")).toBeVisible();
});

test("commits an exact destination search with Enter before moving through suggestions", async ({ page }) => {
  await page.goto("/");
  const search = destinationSearch(page);
  await search.fill("Vienna");
  await expect(page.getByRole("option", { name: /Vienna/ })).toBeVisible();
  await search.press("Enter");
  await expect(destinationDetails(page).getByRole("heading", { name: "Vienna", exact: true })).toBeVisible();
});

test("loads the MapLibre worker and renders location markers", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  const workerResponse = await page.request.get("/maplibre-gl-worker.mjs");
  expect(workerResponse.status()).toBe(200);
  expect(await workerResponse.text()).toContain("maplibre-gl-shared.mjs");
  expect((await page.request.get("/maplibre-gl-shared.mjs")).status()).toBe(200);
});

test("starts safety-data requests before initializing MapLibre", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await expect(page.locator('[data-locations-ready="true"]')).toBeVisible({ timeout: 15_000 });
  const catalog = requests.findIndex((url) => url.endsWith("/locations.json"));
  const snapshot = requests.findIndex((url) => url.includes("/demo-snapshot.json"));
  const map = requests.findIndex((url) => url.includes("openfreemap.org") || url.includes("maplibre-gl-worker.mjs"));
  expect(catalog).toBeGreaterThan(-1);
  expect(snapshot).toBeGreaterThan(-1);
  expect(map).toBeGreaterThan(-1);
  expect(catalog).toBeLessThan(map);
  expect(snapshot).toBeLessThan(map);
});

test("starts map-first and opens the ranked attention experience", { tag: "@smoke" }, async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  const surface = testInfo.project.name === "mobile-webkit"
    ? page.getByRole("region", { name: "Current alerts" })
    : page.getByRole("dialog", { name: "Destinations needing attention" });
  if (testInfo.project.name === "mobile-webkit") await page.getByRole("button", { name: /Alerts/ }).click();
  else {
    const trigger = page.getByRole("button", { name: /Open destinations needing attention/ });
    await expect(trigger).toContainText("7 need attention");
    await expect(trigger).toContainText("1 emergency");
    await trigger.click();
  }
  await expect(surface.getByRole("heading", { name: "Emergency conditions" })).toBeVisible();
  await expect(surface.getByRole("heading", { name: "Consider changing plans" })).toBeVisible();
  await expect(surface.getByRole("heading", { name: "Be aware" })).toBeVisible();
  if (testInfo.project.name === "mobile-webkit") {
    await expect(page.getByRole("heading", { name: "Current alerts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Alerts, 6 alert destinations" })).toHaveAttribute("aria-current", "page");
  }
  const rows = surface.locator("li button");
  await expect(rows).toHaveCount(testInfo.project.name === "mobile-webkit" ? 6 : 7);
  await expect(rows.first()).toContainText("Klagenfurt am Wörthersee");
  await expect(rows.first()).toHaveAccessibleName(/Emergency conditions/);
  await rows.first().click();
  await expect(destinationDetails(page).getByRole("heading", { name: "Klagenfurt am Wörthersee", exact: true })).toBeVisible();
});

test("keeps a large desktop attention list scrollable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The desktop popover is not used on mobile.");
  await mutateDemoSnapshot(page, (snapshot) => {
    const elevated = snapshot.locations["at-austrian-alps"];
    const normal = snapshot.locations["at-vienna"];
    Object.keys(snapshot.locations).forEach((id, index) => {
      snapshot.locations[id] = structuredClone(index < 100 ? elevated : normal);
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Open destinations needing attention/ }).click();

  const dialog = page.getByRole("dialog", { name: "Destinations needing attention" });
  const groups = dialog.locator("section").first().locator("..");
  const rows = dialog.locator("li button");
  expect(await rows.count()).toBe(100);
  expect(await groups.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await groups.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeVisible();
});

test("clears search and closes destination details", async ({ page }, testInfo) => {
  await page.goto("/");
  await selectDestination(page, "Vienna", /Vienna/);
  const compactDialog = page.getByRole("dialog", { name: /Vienna/ });
  if (await compactDialog.count()) {
    await page.getByRole("button", { name: "Close destination details" }).click();
    await expect(compactDialog).toBeHidden();
  }
  if (testInfo.project.name === "desktop-chromium") await page.getByRole("button", { name: "Clear destination search" }).click();
  await expect(destinationSearch(page)).toHaveValue("");
  await expect(destinationDetails(page)).toHaveCount(0);
});

test("distinguishes initial loading from a real data failure", async ({ page }, testInfo) => {
  await page.route("**/demo-snapshot.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Loading updates." })).toBeVisible();
  if (testInfo.project.name === "desktop-chromium") await expect(page.getByRole("button", { name: "Checking destinations for current alerts." })).toBeDisabled();
  await expect(page.getByText("No destinations flagged")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading updates." })).toHaveCount(0);
  await expect(destinationSearch(page)).toBeEnabled();
});

test("shows upcoming timing and location-specific coverage in plain language", async ({ page }) => {
  await page.goto("/");
  await selectDestination(page, "Innsbruck", /Innsbruck/);
  const panel = destinationDetails(page);
  await expect(panel.getByText(/Starts today/).first()).toBeVisible();
  await expect(panel.getByRole("heading", { name: "What TravelCanary checks for Innsbruck" })).toBeVisible();
  await expect(panel.getByText("These checks describe the sources TravelCanary monitors. They are separate from the risk result above.")).toBeVisible();
});

test("labels non-covering hazard evidence as context only", async ({ page }) => {
  await page.goto("/");
  await selectDestination(page, "Salzburg", /Salzburg/);
  const panel = destinationDetails(page);
  await expect(panel.getByRole("link", { name: "Context only: NASA EONET" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Volcanic activity is affecting Salzburg." })).toBeVisible();
});

test("shows issue-first coverage for Budapest and reveals successful checks", async ({ page }) => {
  await page.goto("/");
  await selectDestination(page, "Budapest", /Budapest/);
  const panel = destinationDetails(page);
  await expect(panel.getByRole("heading", { name: "What TravelCanary checks for Budapest" })).toBeVisible();
  await expect(panel.getByText("Current · updated just now")).toBeVisible();
  await expect(panel.getByText("3 fully checked · 3 partly checked · 2 not checked")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Monitoring gaps" })).toBeVisible();
  await expect(panel.getByText("Flooding", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Weather", { exact: true }).first()).toBeHidden();
  await expect(panel.getByText("Air quality", { exact: true }).first()).toBeHidden();
  await expect(panel.getByText("Earthquakes", { exact: true })).toBeHidden();
  await expect(panel.getByText("Additional context sources (7)")).toBeVisible();
  await expect(panel.getByText("Copernicus Global Flood Monitoring", { exact: true })).toBeHidden();
  const issueCopySize = await panel.getByText(/Official flood warnings and Copernicus-mapped emergencies/)
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(issueCopySize).toBeGreaterThanOrEqual(12);
  await panel.getByText("Fully checked (3)").click();
  await expect(panel.getByText("Weather", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Air quality", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Earthquakes", { exact: true })).toBeVisible();
  const earthquakeChecks = panel.getByLabel("Earthquakes checks");
  await expect(earthquakeChecks).toContainText("Earthquake activityFully checked");
  await expect(earthquakeChecks).not.toContainText("Volcanic activity");
  await panel.getByText("Air quality", { exact: true }).first().click();
  await expect(panel.getByText("European Environment Agency", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: /Official provider site/ }).first()).toBeVisible();
  await panel.getByText(/Additional context sources/).click();
  await expect(panel.getByText("These sources may add useful evidence, but they cannot make monitoring complete.")).toBeVisible();
  await expect(panel.getByText("Copernicus Global Flood Monitoring", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: /Official provider site/ }).last()).toHaveAttribute("target", "_blank");
  await panel.getByText("Fully checked (3)").click();
  await expect(panel.getByText("Weather", { exact: true }).first()).toBeHidden();
});

test("partial weather delivery preserves monitoring counts and exposes the provider limitation", async ({ page }) => {
  await mutateDemoSnapshot(page, (snapshot) => {
    snapshot.providers.meteoalarm.partitions!.HU.status = "partial";
  });
  await page.goto("/");
  await selectDestination(page, "Budapest", /Budapest/);
  const panel = destinationDetails(page);
  await expect(panel.getByText("Monitoring coverage:", { exact: true }).locator("..")).toContainText("3 fully checked · 3 partly checked · 2 not checked");
  await expect(panel.getByRole("heading", { name: "Update problems" })).toHaveCount(0);
  await panel.getByText("Fully checked (3)").click();
  await panel.getByText("Weather", { exact: true }).click();
  const weather = panel.locator('details[data-status="available"]').filter({ has: page.getByText("Weather", { exact: true }) });
  await expect(weather.getByText("MeteoAlarm", { exact: true })).toBeVisible();
  await expect(weather.getByText("Partly checked", { exact: true })).toBeVisible();
});

test("scopes delayed MeteoAlarm coverage to the affected destination country", async ({ page }) => {
  await mutateDemoSnapshot(page, (snapshot) => {
    snapshot.providers.meteoalarm.partitions!.HU.status = "failed";
  });
  await page.goto("/");
  await selectDestination(page, "Budapest", /Budapest/);
  const budapest = destinationDetails(page);
  await expect(budapest.getByText("Weather", { exact: true })).toBeVisible();
  await expect(budapest.getByRole("heading", { name: "Update problems" })).toBeVisible();
  await expect(budapest.getByText("Update delayed", { exact: true }).first()).toBeVisible();
  await expect(budapest.getByText(/Some updates delayed/)).toBeVisible();
  await expect(budapest.getByText("This source is normally checked, but its latest Budapest update is late.").first()).toBeVisible();
  await page.getByRole("button", { name: "Close destination details" }).click();

  await selectDestination(page, "Vienna", /Vienna/);
  const vienna = destinationDetails(page);
  await expect(vienna.getByText("This source is normally checked, but its latest Vienna update is late.")).toHaveCount(0);
  await expect(vienna.getByRole("heading", { name: "Update problems" })).toHaveCount(0);
});

test("renders an older Snapshot V2 conservatively without country partitions", async ({ page }) => {
  await mutateDemoSnapshot(page, (snapshot) => {
    snapshot.schemaVersion = 2;
    for (const id of ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"]) delete snapshot.locations[id];
    delete snapshot.providers.meteoalarm.partitions;
    delete snapshot.providers["eea-aqi"].partitions;
    delete snapshot.providers["national-civil-alerts"];
    delete (snapshot.providers as Record<string, unknown>)["vigicrues"];
    delete (snapshot.providers as Record<string, unknown>)["foen-flood"];
    delete (snapshot.providers as Record<string, unknown>)["ehyd-flood"];
    snapshot.providers.meteoalarm.status = "partial";
  });
  await page.goto("/");
  await selectDestination(page, "Budapest", /Budapest/);
  const panel = destinationDetails(page);
  await expect(panel.getByRole("heading", { name: "What TravelCanary checks for Budapest" })).toBeVisible();
  await expect(panel.getByLabel("Update problems").getByText("Weather", { exact: true })).toBeVisible();
  await expect(panel.getByText("Update delayed", { exact: true }).first()).toBeVisible();
});

test("uses the dedicated desktop briefing column for normal and active-alert destinations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop surface sizing is covered once in Chromium.");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await selectDestination(page, "Vienna", /Vienna/);
  const normal = page.getByRole("complementary", { name: /Vienna/ });
  const normalBox = await normal.boundingBox();
  expect(normalBox?.height).toBeGreaterThan(850);
  await expect(normal).toBeFocused();
  await expect(normal.getByRole("heading", { name: "What TravelCanary checks for Vienna", exact: true })).toBeVisible();
  const coverageSummary = normal.getByText("Monitoring coverage:", { exact: true }).locator("..");
  await expect(coverageSummary).toBeVisible();
  await expect(coverageSummary).toContainText("3 fully checked · 3 partly checked · 2 not checked");
  expect(await normal.evaluate((root) => {
    const summary = root.querySelector("#location-coverage-heading");
    const localConditions = [...root.querySelectorAll("h3")].find((heading) => heading.textContent === "Local conditions");
    const monitoringDetails = root.querySelector("#monitoring-details-heading");
    return Boolean(summary && localConditions && monitoringDetails
      && (summary.compareDocumentPosition(localConditions) & Node.DOCUMENT_POSITION_FOLLOWING)
      && (localConditions.compareDocumentPosition(monitoringDetails) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  await page.getByRole("button", { name: "Close destination details" }).click();

  await selectDestination(page, "Klagenfurt", /Klagenfurt/);
  const alert = page.getByRole("complementary", { name: /Klagenfurt/ });
  const alertBox = await alert.boundingBox();
  expect(alertBox?.height).toBeGreaterThan(850);
  await expect(alert).toBeFocused();
  await expect(alert.getByRole("heading", { name: "Flooding is affecting Klagenfurt am Wörthersee." })).toBeVisible();
  await expect(alert.getByText("Klagenfurt am Wörthersee and nearby areas")).toBeVisible();
});

test("explains unavailable data once without a duplicate empty-state card", async ({ page }) => {
  await page.goto("/");
  await selectDestination(page, "Linz", /Linz/);
  const panel = destinationDetails(page);
  await expect(panel.getByText(/Updates unavailable$/)).toHaveCount(1);
  await expect(panel.getByText("Check official local sources before relying on this result.")).toHaveCount(1);
  await expect(panel.getByText(/Current information could not be confirmed/i)).toHaveCount(0);
  await expect(panel.getByText("This can happen when a monitored source is delayed, incomplete, or unavailable.")).toHaveCount(0);
  await expect(panel.getByText(/official local sources/i)).toHaveCount(1);
});

test("keeps destination details open until close history traversal completes before accepting a new search", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await selectDestination(page, "Paris", /^Paris France /);
  await expect(page).toHaveURL(/destination=fr-paris/);
  // Hold the browser traversal itself; no synthetic popstate or arbitrary delay.
  await page.evaluate(() => {
    const back = history.back.bind(history);
    history.back = () => {
      const root = document.documentElement;
      root.dataset.closeTraversalRequests = String(Number(root.dataset.closeTraversalRequests || 0) + 1);
    };
    window.addEventListener("release-close-traversal", () => { history.back = back; back(); }, { once: true });
  });
  await destinationDetails(page).getByRole("button", { name: "Close destination details" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-close-traversal-requests", "1");
  // The mobile modal intentionally hides background controls from accessibility.
  await expect(page.locator('input[role="combobox"]')).toBeDisabled();
  await expect(page.locator('button[aria-label="Clear destination search"]')).toBeDisabled();
  await expect(page).toHaveURL(/destination=fr-paris/);
  await expect(destinationDetails(page)).toBeVisible();
  await expect(destinationDetails(page).getByRole("heading", { name: "Paris", exact: true })).toBeVisible();
  await destinationDetails(page).getByRole("button", { name: "Close destination details" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-close-traversal-requests", "1");
  await expect(destinationDetails(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("release-close-traversal")));
  await expect(page).not.toHaveURL(/destination=/);
  await expect(destinationDetails(page)).toBeHidden();
  const search = destinationSearch(page);
  await expect(search).toBeEnabled();
  if (await page.evaluate(() => matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)").matches)) {
    await expect(page.getByRole("button", { name: /^Show destination suggestions/ })).toBeFocused();
  } else await expect(search).toBeFocused();
  await search.fill("Budapest");
  await expect(search).toHaveValue("Budapest");
  await expect(page.locator('button[aria-label="Clear destination search"]')).toBeEnabled();
  await page.getByRole("option", { name: /^Budapest / }).click();
  await expect(page).toHaveURL(/destination=hu-budapest/);
  await expect(destinationDetails(page).getByRole("heading", { name: "Budapest", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/destination=/);
  await expect(destinationDetails(page)).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/destination=hu-budapest/);
  await expect(destinationDetails(page).getByRole("heading", { name: "Budapest", exact: true })).toBeVisible();
});

test("has no serious automated accessibility violations", { tag: "@smoke" }, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const search = destinationSearch(page);
  await expect(search).toBeVisible();
  expect((await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations).toEqual([]);
  await search.fill("Austrian Alps");
  await expect(page.getByRole("option", { name: /Austrian Alps/ })).toBeVisible();
  const openSearchViolations = (await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations;
  // React Aria intentionally hides everything except the input and listbox while a
  // combobox is open on Apple platforms. Tab closes the listbox before focus moves,
  // so these transient Axe findings do not expose hidden focusable controls.
  expect(openSearchViolations.filter(({ id }) => !["aria-hidden-focus", "page-has-heading-one"].includes(id))).toEqual([]);
  await search.fill("");
  await expect(page.getByRole("listbox", { name: "Destination results" })).toHaveCount(0);
  if (testInfo.project.name === "mobile-webkit") await page.getByRole("button", { name: "Close destination search" }).click();

  const attentionSurface = page.getByRole("dialog", { name: "Destinations needing attention" }).or(page.getByRole("region", { name: "Current alerts" }));
  if (testInfo.project.name === "mobile-webkit") await page.getByRole("button", { name: /Alerts/ }).click();
  else await page.getByRole("button", { name: /Open destinations needing attention/ }).click();
  await expect(attentionSurface).toBeVisible();
  expect((await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations).toEqual([]);
  if (testInfo.project.name === "mobile-webkit") await page.getByRole("button", { name: "Map", exact: true }).click();
  else await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open app menu" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Map key/ }).click();
  const mapKey = page.getByRole("dialog");
  await expect(mapKey).toBeVisible();
  await expect(mapKey).toContainText("Counts are destinations, not incidents.");
  await expect(mapKey).toContainText("Search and Alerts still reach every supported place.");
  expect((await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");

  await search.fill("Austrian Alps");
  await page.getByRole("option", { name: /Austrian Alps/ }).click();
  await expect(destinationDetails(page).getByRole("heading", { name: "Austrian Alps", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Close destination details" }).click();
  await expect(page).not.toHaveURL(/destination=/);
  await expect(destinationDetails(page)).toBeHidden();
  if (await page.evaluate(() => matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)").matches)) {
    await expect(page.getByRole("button", { name: /^Show destination suggestions/ })).toBeFocused();
  } else await expect(search).toBeFocused();
  await selectDestination(page, "Budapest", /Budapest/);
  const coverage = destinationDetails(page);
  await coverage.getByText("Fully checked (3)").click();
  await coverage.getByText("Air quality", { exact: true }).first().click();
  expect((await new AxeBuilder({ page }).exclude(".maplibregl-canvas").analyze()).violations).toEqual([]);
});

test("searches all three Azores island-group destinations", async ({ page }) => {
  await page.goto("/");
  for (const name of ["Ponta Delgada", "Horta", "Santa Cruz das Flores"]) {
    const search = destinationSearch(page);
    await search.fill(name);
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    await search.fill("");
  }
});

test("keeps alias, native-script, and location-type searches visible", async ({ page }) => {
  await page.goto("/");
  const search = destinationSearch(page);
  await search.fill("Woerthersee");
  await expect(page.getByRole("option", { name: /Klagenfurt am Wörthersee/ })).toBeVisible();
  await search.fill("Αιγάλεω");
  await expect(page.getByRole("option", { name: /Aigáleo/ })).toBeVisible();
  await search.fill("Mountain region");
  await expect(page.getByRole("option", { name: /Austrian Alps/ })).toBeVisible();
});

test("edits a selected destination directly and keeps search focus and history usable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await selectDestination(page, "Vienna", /Vienna/);
  await expect(page).toHaveURL(/destination=at-vienna/);
  const search = destinationSearch(page);
  await search.fill("Par");
  await expect(search).toHaveValue("Par");
  await expect(search).toBeFocused();
  await search.pressSequentially("is");
  await expect(search).toHaveValue("Paris");
  const paris = page.getByRole("option", { name: /^Paris France/ });
  await expect(paris).toBeVisible();
  await paris.click();
  await expect(page).toHaveURL(/destination=fr-paris/);
  await expect(destinationDetails(page).getByRole("heading", { name: "Paris", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close destination details" }).click();
  await expect(page).not.toHaveURL(/destination=/);
  await page.goForward();
  await expect(page).toHaveURL(/destination=fr-paris/);
});

