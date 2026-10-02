import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { SnapshotV11Schema } from "@/lib/domain/catalog-public";
import { publicationManifestPath, publicationObjectPath, publicationPointerPath } from "@/lib/domain/publication";
import { publishedPluginSummary } from "@/lib/local-status";
import { FilePublicationStore, publicationSha256, readCurrentPublication, readPublishedObject } from "@/lib/publication-store";
import { applySnapshotStaleness } from "@/lib/snapshot-health";
import { MemoryPublicationStore } from "../helpers/publication";

const fixtures = new FilePublicationStore(resolve("public"), false);
class FixtureStore extends MemoryPublicationStore {
  override async read(path: string, bytes: number) {
    const value = await super.read(path, bytes) || await fixtures.read(path, bytes);
    return value ? { ...value, updatedAt: value.updatedAt || new Date(0) } : null;
  }
}

async function generation(expireWarning = false, codes: string[] = []) {
  const current = (await readCurrentPublication(fixtures))!; const store = new FixtureStore();
  const snapshot = SnapshotV11Schema.parse(JSON.parse(await readPublishedObject(fixtures, current.manifest.snapshot)));
  const generated = Date.parse(snapshot.generatedAt);
  if (expireWarning) for (const hazard of snapshot.locations["at-klagenfurt-am-woerthersee"].hazards) {
    hazard.startsAt = new Date(generated - 3_600_000).toISOString();
    hazard.endsAt = hazard.expiresAt = new Date(generated + 5 * 60_000).toISOString(); hazard.timing = "ACTIVE";
  }
  const body = JSON.stringify(SnapshotV11Schema.parse(snapshot)); const sha256 = publicationSha256(body);
  const manifest = { ...current.manifest, snapshot: { ...current.manifest.snapshot,
    path: publicationObjectPath(sha256), sha256, bytes: Buffer.byteLength(body) },
    status: { ...current.manifest.status, state: "complete" as const, codes } };
  const manifestBody = JSON.stringify(manifest); const manifestSha256 = publicationSha256(manifestBody);
  store.replaceForTest(manifest.snapshot.path, body);
  store.replaceForTest(publicationManifestPath(manifestSha256), manifestBody);
  store.replaceForTest(publicationPointerPath, JSON.stringify({ ...current.pointer,
    manifestSha256, manifestPath: publicationManifestPath(manifestSha256) }));
  return { store, snapshot, manifest };
}

describe("public plugin summary", () => {
  it.each([1, 10, 181])("uses browser warning-expiry and snapshot-staleness rules at age %i minutes", async (minutes) => {
    const { store, snapshot } = await generation(true);
    const now = new Date(Date.parse(snapshot.generatedAt) + minutes * 60_000);
    const browser = applySnapshotStaleness(snapshot, now, catalogLocationsV3);
    const counts = { NORMAL: 0, ELEVATED: 0, HIGH: 0, SEVERE: 0, UNKNOWN: 0 };
    for (const state of Object.values(browser.locations)) counts[state.level] += 1;
    const summary = await publishedPluginSummary(store, now);
    expect(summary.counts).toMatchObject(counts);
    if (minutes === 10) expect(summary.destinations.some(({ id }) => id === "at-klagenfurt-am-woerthersee")).toBe(false);
  });

  it("discloses restricted records in an older public generation and fails closed on unreadable conditions", async () => {
    const { store, snapshot, manifest } = await generation();
    const summary = await publishedPluginSummary(store, new Date(Date.parse(snapshot.generatedAt) + 60_000));
    expect(summary.restrictedSources).toMatchObject({ active: true, disclosure: expect.any(String) });
    expect(JSON.stringify(summary)).not.toMatch(/acceptedManifestDigest|luAlertCursor|ingestion/);
    store.replaceForTest(manifest.conditions[0].path, "{}");
    await expect(publishedPluginSummary(store, new Date(snapshot.generatedAt))).rejects.toThrow();
  });

  it("reads explicit public activation without opening private state", async () => {
    const { store, snapshot } = await generation(false, ["policy/restricted_sources_active"]);
    const summary = await publishedPluginSummary(store, new Date(Date.parse(snapshot.generatedAt) + 181 * 60_000));
    expect(summary.restrictedSources.active).toBe(true);
    expect(summary.restrictedSources.disclosure).toBeTruthy();
  });
});
