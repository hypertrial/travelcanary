import { test as base, expect, type Page } from "@playwright/test";

export { expect };

export const DETERMINISTIC_BASEMAP = {
  version: 8,
  sources: {
    openfreemap: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution: '<a href="https://openfreemap.org">OpenFreeMap</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#c6c2b8" } },
    { id: "openfreemap-attrib", type: "fill", source: "openfreemap", paint: { "fill-opacity": 0 } },
  ],
} as const;

export async function installDeterministicBasemap(page: Page) {
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({ json: DETERMINISTIC_BASEMAP }));
}

export const test = base.extend({
  page: async ({ page }, provide, testInfo) => {
    if (!testInfo.tags.includes("@map-failure") && !testInfo.tags.includes("@live-map")) {
      await installDeterministicBasemap(page);
    }
    await provide(page);
  },
});
