import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appMenu = readFileSync(resolve(root, "src/components/AppMenu.tsx"), "utf8");
const a11ySmoke = readFileSync(resolve(root, "tests/e2e/app.spec.ts"), "utf8")
  .split('test("has no serious automated accessibility violations"')[1]?.split("\n\ntest(")[0] ?? "";

function sectionBody(section: string) {
  const marker = `if (section === "${section}") return <div className={styles.detail}>`;
  const start = appMenu.indexOf(marker);
  expect(start, `${section} detail`).toBeGreaterThan(-1);
  const from = start + marker.length;
  return appMenu.slice(from, appMenu.indexOf("</div>;", from));
}

describe("compact app-menu dismiss contract", () => {
  it("keeps Done on the menu root and only Back on Map key and other details", () => {
    for (const section of ["key", "install", "about", "instance"] as const) {
      const body = sectionBody(section);
      expect(body).toContain("‹ Back");
      expect(body).toContain('setSection("menu")');
      expect(body).not.toContain("Done");
      expect(body).not.toContain('slot="close"');
    }

    const rootStart = appMenu.indexOf("return <div className={styles.menuBody}>");
    const root = appMenu.slice(rootStart, appMenu.indexOf("</div>;\n}", rootStart));
    expect(root).toContain('{onClose && <Button slot="close"');
    expect(root).toContain(">Done</Button>");
    expect(root).not.toContain("‹ Back");
    expect(appMenu.split('slot="close"')).toHaveLength(2);
  });

  it("closes the compact overlay through React Aria close, not a detail-level Done", () => {
    expect(appMenu).toContain("<ModalOverlay isOpen={mobileOpen} onOpenChange={setMobileOpen} isDismissable");
    expect(appMenu).toContain("<MenuBody {...body} onClose={close} />");
    expect(appMenu).toMatch(/<Popover isNonModal[\s\S]*<MenuBody \{\.\.\.body\} \/>/);
    expect(appMenu).not.toMatch(/<Popover[\s\S]*onClose=\{close\}/);
  });

  it("keeps the a11y smoke close path from leaving the overlay open before the second search", () => {
    expect(a11ySmoke).toContain('getByRole("button", { name: /Map key/ })');
    const mapKey = a11ySmoke.slice(a11ySmoke.indexOf('getByRole("button", { name: /Map key/ })'));
    const mobileClose = mapKey.slice(mapKey.indexOf('if (testInfo.project.name === "mobile-webkit")'), mapKey.indexOf("} else {"));
    expect(mobileClose.indexOf('name: /Back/')).toBeGreaterThan(-1);
    expect(mobileClose.indexOf('name: /Back/')).toBeLessThan(mobileClose.indexOf('name: "Done"'));
    expect(mobileClose).toContain(".click()");
    expect(mapKey).toContain('await page.keyboard.press("Escape")');
    expect(mapKey.indexOf("await expect(mapKey).toBeHidden()"))
      .toBeLessThan(mapKey.indexOf('await search.fill("Austrian Alps")'));
    expect(mapKey.indexOf('await expect(page.getByRole("option", { name: /Austrian Alps/ })).toBeVisible()'))
      .toBeLessThan(mapKey.indexOf('await page.getByRole("option", { name: /Austrian Alps/ }).click()'));
  });

  it("does not loosen a11y assertions around Map key or the follow-up destination search", () => {
    expect(a11ySmoke.match(/openSearchViolations\.filter/g)).toHaveLength(1);
    expect(a11ySmoke).toContain('!["aria-hidden-focus", "page-has-heading-one"].includes(id)');
    expect(a11ySmoke.match(/\.violations\)\.toEqual\(\[\]\)/g)).toHaveLength(5);
    const afterMapKey = a11ySmoke.slice(a11ySmoke.indexOf('getByRole("button", { name: /Map key/ })'));
    expect(afterMapKey.match(/openSearchViolations\.filter|\.filter\(\(\{ id \}\)/g)).toBeNull();
    expect(afterMapKey.match(/\.violations\)\.toEqual\(\[\]\)/g)).toHaveLength(3);
  });
});
