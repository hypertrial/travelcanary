import { type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expect } from "../playwright-fixtures";

export const catalog = JSON.parse(readFileSync("public/catalogs/3/locations.json", "utf8")) as Array<{ id: string; name: string; countryCode: string; country: string }>;
export const legacy = JSON.parse(readFileSync("public/demo-snapshot.json", "utf8"));
export const representatives = ["al-tirana", "ad-andorra-la-vella", "by-minsk", "ba-sarajevo", "is-reykjavik", "xk-pristina", "li-malbun", "md-chisinau", "mc-monaco", "me-podgorica", "mk-skopje", "no-oslo", "sm-san-marino", "rs-belgrade", "gb-london", "va-vatican-city", "tr-istanbul", "tr-van", "gb-cardiff", "gb-belfast", "gb-edinburgh", "gb-shetland-islands", "no-lofoten"];
export const smokeRepresentatives = new Set(["gb-london", "va-vatican-city", "tr-istanbul"]);
export const search = (page: Page) => page.getByRole("combobox", { name: "Where are you going?" });
export const details = (page: Page) => page.getByRole("complementary", { name: /risk details$/ }).or(page.getByRole("dialog", { name: /risk details$/ }));
export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function prepareCatalog3Page(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
}

export function location(id: string) {
  const value = catalog.find((entry) => entry.id === id);
  if (!value) throw new Error(`Missing reviewed representative ${id}`);
  return value;
}

export async function select(page: Page, id: string, query = location(id).name) {
  await search(page).fill(query);
  await page.getByRole("option", { name: new RegExp(`^${escapeRegex(location(id).name)} `) }).click();
  await expect(page).toHaveURL(new RegExp(`destination=${id}(?:&|$)`));
  await expect(details(page).getByRole("heading", { name: location(id).name, exact: true })).toBeVisible({ timeout: 3000 });
}

export async function close(page: Page) {
  await details(page).getByRole("button", { name: "Close destination details" }).click();
  await expect(details(page)).toBeHidden();
  await expect(page).not.toHaveURL(/destination=/);
  if (await page.evaluate(() => matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)").matches)) {
    await expect(page.getByRole("button", { name: /^Show destination suggestions/ })).toBeFocused();
    await expect(page.getByRole("button", { name: "Close destination search" })).toBeHidden();
  } else await expect(search(page)).toBeFocused();
}
