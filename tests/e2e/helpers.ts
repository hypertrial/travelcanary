import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Page, type Route } from "@playwright/test";
import type { z } from "zod";
import { expect } from "../playwright-fixtures";

export const destinationSearch = (page: Page) => page.getByRole("combobox", { name: "Where are you going?" });
export const destinationDetails = (page: Page) => page.getByRole("complementary").or(page.getByRole("dialog", { name: /risk details/ }));

/** Pixel snapshots are Darwin-authoritative. Linux CI keeps functional e2e and skips screenshot compare. */
export const DARWIN_VISUAL_SNAPSHOTS = process.platform === "darwin";

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

type DemoPointer = { manifestPath: string; manifestSha256: string } & Record<string, unknown>;
type DemoManifest = { snapshot: { path: string; sha256: string; bytes: number }; conditions: Array<{ countryCode: string; path: string }> } & Record<string, unknown>;
export type DemoPublication = { pointer: DemoPointer; manifest: DemoManifest; snapshot: MutableDemoSnapshot };
type DemoConditions = z.infer<typeof import("../../src/lib/domain/catalog-public").ConditionsV3Schema>;

const publicRoot = resolve(process.cwd(), "public");
const basePointer = JSON.parse(readFileSync(resolve(publicRoot, "catalogs/3/publication/latest.json"), "utf8")) as DemoPointer;
const baseManifest = JSON.parse(readFileSync(resolve(publicRoot, basePointer.manifestPath), "utf8")) as DemoManifest;
const baseSnapshot = JSON.parse(readFileSync(resolve(publicRoot, baseManifest.snapshot.path), "utf8")) as MutableDemoSnapshot;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

export function demoPublication(mutate: (snapshot: MutableDemoSnapshot) => void = () => {}) {
  const snapshot = structuredClone(baseSnapshot); mutate(snapshot);
  const snapshotBody = JSON.stringify(snapshot); const snapshotSha = digest(snapshotBody);
  const manifest = structuredClone(baseManifest);
  manifest.snapshot = { ...manifest.snapshot, path: `catalogs/3/objects/sha256/${snapshotSha}.json`,
    sha256: snapshotSha, bytes: Buffer.byteLength(snapshotBody) };
  const manifestBody = JSON.stringify(manifest); const manifestSha = digest(manifestBody);
  const pointer = { ...structuredClone(basePointer), manifestPath: `catalogs/3/generations/${manifestSha}/manifest.json`, manifestSha256: manifestSha };
  return { pointer, manifest, snapshot };
}

export async function installDemoPublicationObjects(page: Page, fixture: DemoPublication) {
  await page.route(`**/${fixture.pointer.manifestPath}`, (route) => route.fulfill({ json: fixture.manifest }));
  await page.route(`**/${fixture.manifest.snapshot.path}`, (route) => route.fulfill({ json: fixture.snapshot }));
}

export const demoSnapshotPath = () => baseManifest.snapshot.path;
export const demoConditionsPath = (countryCode: string) => baseManifest.conditions.find((item) => item.countryCode === countryCode)!.path;
const conditionPaths = new Set(baseManifest.conditions.map(({ path }) => `/${path}`));
export const isDemoConditionsRequest = (url: string) => conditionPaths.has(new URL(url).pathname);

export async function routeDemoConditions(page: Page, countryCode: string, handler: (route: Route) => unknown) {
  await page.route(`**/${demoConditionsPath(countryCode)}`, handler);
}

export async function routeAllDemoConditions(page: Page, handler: (route: Route) => unknown) {
  await Promise.all(baseManifest.conditions.map(({ path }) => page.route(`**/${path}`, handler)));
}

export async function abortDemoSnapshot(page: Page) {
  await page.route(/\/api\/v1\/data$/, (route) => route.abort());
}

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
  const fixture = demoPublication(mutate);
  await installDemoPublicationObjects(page, fixture);
  await page.route(/\/api\/v1\/data(?:\?.*)?$/, (route) => route.fulfill({ json: fixture.pointer }));
}

export async function mutateDemoConditions(page: Page, countryCode: string, mutate: (conditions: DemoConditions) => void) {
  const manifest = structuredClone(baseManifest);
  const reference = manifest.conditions.find((item) => item.countryCode === countryCode)!;
  const conditions = JSON.parse(readFileSync(resolve(publicRoot, reference.path), "utf8")) as DemoConditions;
  mutate(conditions);
  const body = JSON.stringify(conditions); const sha = digest(body);
  reference.path = `catalogs/3/objects/sha256/${sha}.json`;
  Object.assign(reference, { sha256: sha, bytes: Buffer.byteLength(body) });
  const manifestBody = JSON.stringify(manifest); const manifestSha = digest(manifestBody);
  const pointer = { ...structuredClone(basePointer), manifestPath: `catalogs/3/generations/${manifestSha}/manifest.json`, manifestSha256: manifestSha };
  await page.route(`**/${pointer.manifestPath}`, (route) => route.fulfill({ json: manifest }));
  await page.route(`**/${reference.path}`, (route) => route.fulfill({ json: conditions }));
  await page.route(/\/api\/v1\/data(?:\?.*)?$/, (route) => route.fulfill({ json: pointer }));
}
