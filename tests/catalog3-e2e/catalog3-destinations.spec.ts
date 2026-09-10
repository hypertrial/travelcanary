import { expect, test } from "../playwright-fixtures";
import { close, details, location, prepareCatalog3Page, representatives, select, smokeRepresentatives } from "./helpers";

test.beforeEach(async ({ page }) => {
  await prepareCatalog3Page(page);
});

for (const id of representatives) {
  test(`selects reviewed ${location(id).countryCode} destination ${location(id).name} and restores search focus`, smokeRepresentatives.has(id) ? { tag: "@smoke" } : {}, async ({ page }) => {
  await page.goto("/"); await select(page, id);
  const scopedLinks: Record<string, string[]> = {
    "gb-london": ["England National Highways travel updates", "Scotland trunk-road traffic updates", "Wales traffic information", "Northern Ireland traffic information", "Great Britain electricity operator directory", "Northern Ireland electricity outages — NIE Networks"],
    "no-oslo": ["Norway road traffic information", "Elvia electricity outages — Elvia service area only"],
    "is-reykjavik": ["Iceland road conditions", "Veitur utility outages — Veitur service networks only"],
    "al-tirana": ["Hydrological and meteorological bulletins — check issue dates", "Albanian Road Authority notices — check issue dates"],
    "ba-sarajevo": ["Republika Srpska hydrological information"],
    "me-podgorica": ["Montenegro warning bulletin archive — check issue dates", "Montenegro emergency management information"],
    "mk-skopje": ["North Macedonia crisis bulletins — check issue dates"],
    "ad-andorra-la-vella": ["Andorra seasonal avalanche bulletins — check validity"],
    "li-malbun": ["Liechtenstein natural hazard information"],
    "mc-monaco": ["Monaco official journal — check notice dates and later updates"],
    "md-chisinau": ["Moldova emergency publications — check issue dates"],
  };
  if (scopedLinks[id]) {
    // Expand the mobile preview before reading its detailed official-source list.
    const expand = details(page).getByRole("button", { name: "Expand destination details", exact: true });
    if (await expand.isVisible()) await expand.click();
    await details(page).getByText(`Official information for ${location(id).country}`, { exact: true }).click();
    await expect(details(page).getByText(/These links do not mean TravelCanary automatically monitors their information/)).toBeVisible();
    for (const label of scopedLinks[id]) {
      const link = details(page).getByRole("link", { name: `${label} (opens in a new tab)`, exact: true });
      await expect(link).toBeVisible(); await expect(link).toHaveAttribute("target", "_blank");
    }
  }
  await close(page);
});
}

