import { type Page } from "@playwright/test";
import { expect } from "../playwright-fixtures";

export const destinationSearch = (page: Page) => page.getByRole("combobox", { name: "Where are you going?" });
export const destinationDetails = (page: Page) => page.getByRole("complementary").or(page.getByRole("dialog", { name: /risk details/ }));

export type MutableDemoSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  locations: Record<string, { level: string; coverage: string; coverageGaps: string[]; delayedHazards: string[]; hazards: unknown[] }>;
  providers: {
    meteoalarm: {
      status: string;
      partitions?: Record<string, { status: string }>;
    };
    "eea-aqi": { partitions?: Record<string, { status: string }> };
    "national-civil-alerts"?: unknown;
  };
};

export async function selectDestination(page: Page, query: string, option: RegExp) {
  const search = destinationSearch(page);
  await search.fill(query);
  await page.getByRole("option", { name: option }).click();
  await expect(destinationDetails(page)).toBeVisible();
}

export async function gotoAfterViewportChange(page: Page) {
  try {
    await page.goto("/");
  } catch (error) {
    if (!String(error).includes("ERR_ABORTED")) throw error;
    await page.goto("/");
  }
}

export async function mutateDemoSnapshot(page: Page, mutate: (snapshot: MutableDemoSnapshot) => void) {
  await page.route("**/demo-snapshot.json", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as MutableDemoSnapshot;
    mutate(snapshot);
    await route.fulfill({ response, json: snapshot });
  });
}
