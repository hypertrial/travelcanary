import { expect, test } from "../playwright-fixtures";
import { close, details, escapeRegex, legacy, location, prepareCatalog3Page, search, select } from "./helpers";

test.beforeEach(async ({ page }) => {
  await prepareCatalog3Page(page);
});

test("country aliases, exact Enter after close, deep links and browser history retain destination identity", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/?destination=gb-london");
  await expect(details(page).getByRole("heading", { name: "London", exact: true })).toBeVisible(); await close(page);
  for (const [query, id] of [["UK", "gb-london"], ["Turkey", "tr-istanbul"], ["Kosova", "xk-pristina"]]) {
    // Country results use a bounded suggestion list. Pick a displayed member of
    // the expected country, then separately verify exact destination Enter.
    await search(page).fill(query); const code = id.slice(0, 2).toUpperCase();
    const country = location(id).country;
    const option = page.getByRole("option").filter({ hasText: country }).first(); await expect(option).toBeVisible(); await option.click();
    await expect(page).toHaveURL(new RegExp(`destination=${code.toLowerCase()}-`)); await expect(details(page)).toBeVisible(); await close(page);
  }
  await search(page).fill(location("xk-pristina").name); await expect(page.getByRole("option", { name: new RegExp(`^${escapeRegex(location("xk-pristina").name)} `) })).toBeVisible();
  await search(page).press("Enter"); await expect(page).toHaveURL(/destination=xk-pristina/);
  await expect(details(page).getByRole("heading", { name: location("xk-pristina").name, exact: true })).toBeVisible();
  await page.goBack(); await expect(details(page)).toBeHidden(); await expect(page).not.toHaveURL(/destination=/);
  await page.goForward(); await expect(page).toHaveURL(/destination=xk-pristina/); await expect(details(page)).toBeVisible();
});

test("a valid legacy V2 snapshot keeps newly listed destinations UNKNOWN and update pending", { tag: "@smoke" }, async ({ page }) => {
  await page.route("**/catalogs/3/demo-snapshot.json", (route) => route.fulfill({ json: legacy }));
  await page.goto("/?destination=gb-london");
  for (const id of ["gb-london", "va-vatican-city"]) {
    const briefing = details(page);
    await expect(briefing.getByRole("heading", { name: location(id).name, exact: true })).toBeVisible();
    // Wait for the lazy context so this cannot pass before coverage is rendered.
    await expect(briefing.getByRole("heading", { name: `Detailed monitoring information for ${location(id).name}`, exact: true })).toBeAttached();
    const header = briefing.locator("header[data-level]");
    await expect(header).toHaveAttribute("data-level", "UNKNOWN");
    await expect(header.getByRole("status").filter({ hasText: "Monitoring update pending for this destination." })).toBeVisible();
    await expect(header.locator('span[data-level="UNKNOWN"]')).toBeVisible();
    await expect(header.locator('span[data-level="UNKNOWN"]')).toContainText("Updates unavailable");
    await expect(header.getByText(/No active alerts/)).toHaveCount(0);
    const coverage = briefing.getByRole("region", { name: `What TravelCanary checks for ${location(id).name}`, exact: true });
    await expect(coverage.locator("p[data-status]")).toHaveAttribute("data-status", "unavailable");
    await expect(coverage.locator("p[data-status]")).toContainText("Source updates unavailable. Last update time unavailable.");
    await expect(coverage.getByText(/^Monitoring coverage: 0 fully checked, 0 partly checked,/)).toHaveCount(1);
    // A glossary may define Fully checked; no actual checked-category section is allowed.
    await expect(briefing.locator("summary").filter({ hasText: /^Fully checked \(/ })).toHaveCount(0);
    if (id === "gb-london") { await close(page); await select(page, "va-vatican-city"); }
  }
});

