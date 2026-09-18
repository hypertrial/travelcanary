import { expect, test } from "../playwright-fixtures";
import { close, details, escapeRegex, location, prepareCatalog3Page, search } from "./helpers";

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
