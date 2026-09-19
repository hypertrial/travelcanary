import { describe, expect, it } from "vitest";
import { prunePublications, publishCommittedCatalog } from "@/lib/catalog-publication";
import { acquireIngestionLease, assertIngestionLease } from "@/lib/ingestion-lease";
import { publicationPointerPath } from "@/lib/domain/publication";
import { createEmptyState } from "@/lib/risk-state";
import { FilePublicationStore, publicationSha256, readCurrentPublication, type PublicationStore } from "@/lib/publication-store";
import { MemoryStateStore } from "@/lib/state-store";
import { MemoryPublicationStore } from "../helpers/publication";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const now = new Date("2026-09-18T06:00:00.000Z");

class FailingPublicationStore implements PublicationStore {
  calls = 0;
  constructor(private readonly target: MemoryPublicationStore, private readonly failAt: number) {}
  private fail() { this.calls += 1; if (this.calls === this.failAt) throw new Error("injected publication failure"); }
  read(...args: Parameters<PublicationStore["read"]>) { return this.target.read(...args); }
  async putImmutable(...args: Parameters<PublicationStore["putImmutable"]>) { this.fail(); return this.target.putImmutable(...args); }
  async replacePointer(...args: Parameters<PublicationStore["replacePointer"]>) { this.fail(); return this.target.replacePointer(...args); }
  list(...args: Parameters<PublicationStore["list"]>) { return this.target.list(...args); }
  deleteMany(...args: Parameters<PublicationStore["deleteMany"]>) { return this.target.deleteMany(...args); }
}

async function writer(store: PublicationStore) {
  const stateStore = new MemoryStateStore(createEmptyState(now));
  const lease = await acquireIngestionLease(stateStore, "atomic-publication-test", now, 330_000);
  if (!lease) throw new Error("lease unavailable");
  return { stateStore, lease, publish: () => publishCommittedCatalog({ stateStore, stores: { publicationStore: store },
    collection: { catalogVersion: 3, revision: 1 }, lease, now, family: "all", env: { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) } }) };
}

describe("atomic public generations", () => {
  it("never exposes a pointer when any object, manifest, or pointer write fails", async () => {
    for (let failAt = 1; failAt <= 48; failAt += 1) {
      const target = new MemoryPublicationStore(); const failing = new FailingPublicationStore(target, failAt); const run = await writer(failing);
      await expect(run.publish()).rejects.toThrow("injected publication failure");
      expect(await target.read(publicationPointerPath, 64_000), `write ${failAt}`).toBeNull();
    }
  }, 30_000);

  it("commits one complete pointer only after all46 payloads and the manifest exist", async () => {
    const store = new MemoryPublicationStore(); const run = await writer(store); const result = await run.publish();
    const current = await readCurrentPublication(store);
    expect(current?.pointer.manifestSha256).toBe(result.pointer.manifestSha256);
    expect(current?.manifest.conditions).toHaveLength(45);
    expect(current?.manifest.status.codes).not.toContain("source/cems/failed");
    expect(await store.list("catalogs/3/objects/sha256/", 100)).toHaveLength(46);
  });

  it("uses an explicit wrapper release identity ahead of Vercel's public-submodule identity", async () => {
    const store = new MemoryPublicationStore();
    const stateStore = new MemoryStateStore(createEmptyState(now));
    const lease = await acquireIngestionLease(stateStore, "wrapper-release-test", now, 330_000);
    if (!lease) throw new Error("lease unavailable");
    const wrapperSha = "b".repeat(40);
    await publishCommittedCatalog({ stateStore, stores: { publicationStore: store },
      collection: { catalogVersion: 3, revision: 1 }, lease, now, family: "all",
      env: { VERCEL_GIT_COMMIT_SHA: "a".repeat(40), TRAVELCANARY_RELEASE_SHA: wrapperSha } });
    const current = await readCurrentPublication(store);
    expect(current?.pointer.producerCommitSha).toBe(wrapperSha);
    expect(current?.manifest.producerCommitSha).toBe(wrapperSha);
  });

  it("fences overlapping, expired, and stale writers", async () => {
    const stateStore = new MemoryStateStore(createEmptyState(now));
    const first = await acquireIngestionLease(stateStore, "writer-first", now, 60_000);
    expect(first).not.toBeNull();
    expect(await acquireIngestionLease(stateStore, "writer-second", new Date(now.getTime() + 30_000), 60_000)).toBeNull();
    const second = await acquireIngestionLease(stateStore, "writer-second", new Date(now.getTime() + 61_000), 60_000);
    expect(second?.fence).toBe(first!.fence + 1);
    await expect(assertIngestionLease(stateStore, first!, new Date(now.getTime() + 61_000))).rejects.toThrow(/lost/);
    await expect(assertIngestionLease(stateStore, second!, new Date(now.getTime() + 61_001))).resolves.toBeDefined();
  });

  it("retains the newest valid rollback when newer manifests are malformed, incomplete, or violate release contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "travelcanary-prune-"));
    cpSync("public/catalogs/3", join(root, "catalogs/3"), { recursive: true });
    const pointer = JSON.parse(readFileSync(join(root, publicationPointerPath), "utf8")) as { manifestPath: string };
    const currentManifest = JSON.parse(readFileSync(join(root, pointer.manifestPath), "utf8")) as Record<string, unknown>;
    currentManifest.generatedAt = now.toISOString();
    const manifest = JSON.stringify(currentManifest); const rollbackSha = publicationSha256(manifest);
    const currentGeneration = pointer.manifestPath.split("/")[3];
    for (const generation of readdirSync(join(root, "catalogs/3/generations"))) {
      if (generation !== currentGeneration) rmSync(join(root, "catalogs/3/generations", generation), { recursive: true });
    }
    const rollback = `catalogs/3/generations/${rollbackSha}/manifest.json`;
    const incompleteManifest = structuredClone(currentManifest) as Record<string, unknown> & { snapshot: Record<string, unknown> };
    incompleteManifest.generatedAt = new Date(now.getTime() + 60_000).toISOString();
    incompleteManifest.snapshot = { ...incompleteManifest.snapshot, path: `catalogs/3/objects/sha256/${"f".repeat(64)}.json`,
      sha256: "f".repeat(64), bytes: 2 };
    const incompleteBody = JSON.stringify(incompleteManifest);
    const incomplete = `catalogs/3/generations/${publicationSha256(incompleteBody)}/manifest.json`;
    const incompatibleManifest = { ...currentManifest, generatedAt: new Date(now.getTime() + 120_000).toISOString(),
      coverageContractHash: "0".repeat(64) };
    const incompatibleBody = JSON.stringify(incompatibleManifest);
    const incompatible = `catalogs/3/generations/${publicationSha256(incompatibleBody)}/manifest.json`;
    const freshnessMismatchManifest = structuredClone(currentManifest) as Record<string, unknown> & { snapshot: Record<string, unknown> };
    freshnessMismatchManifest.generatedAt = new Date(now.getTime() + 180_000).toISOString();
    freshnessMismatchManifest.snapshot = { ...freshnessMismatchManifest.snapshot,
      generatedAt: new Date(Date.parse(String(freshnessMismatchManifest.snapshot.generatedAt)) - 60_000).toISOString() };
    const freshnessMismatchBody = JSON.stringify(freshnessMismatchManifest);
    const freshnessMismatch = `catalogs/3/generations/${publicationSha256(freshnessMismatchBody)}/manifest.json`;
    const conditionMismatchManifest = structuredClone(currentManifest) as Record<string, unknown> & {
      conditions: Array<Record<string, unknown>>;
    };
    conditionMismatchManifest.generatedAt = new Date(now.getTime() + 240_000).toISOString();
    conditionMismatchManifest.conditions[0] = { ...conditionMismatchManifest.conditions[0],
      generatedAt: new Date(Date.parse(String(conditionMismatchManifest.conditions[0].generatedAt)) - 60_000).toISOString() };
    const conditionMismatchBody = JSON.stringify(conditionMismatchManifest);
    const conditionMismatch = `catalogs/3/generations/${publicationSha256(conditionMismatchBody)}/manifest.json`;
    const malformed = `catalogs/3/generations/${"b".repeat(64)}/manifest.json`;
    for (const pathname of [rollback, incomplete, incompatible, freshnessMismatch, conditionMismatch, malformed]) {
      mkdirSync(dirname(join(root, pathname)), { recursive: true });
    }
    writeFileSync(join(root, rollback), manifest); writeFileSync(join(root, incomplete), incompleteBody);
    writeFileSync(join(root, incompatible), incompatibleBody); writeFileSync(join(root, freshnessMismatch), freshnessMismatchBody);
    writeFileSync(join(root, conditionMismatch), conditionMismatchBody);
    writeFileSync(join(root, malformed), "not-json");
    utimesSync(join(root, rollback), new Date(now.getTime() - 72 * 60 * 60_000), new Date(now.getTime() - 72 * 60 * 60_000));
    utimesSync(join(root, incomplete), new Date(now.getTime() - 69 * 60 * 60_000), new Date(now.getTime() - 69 * 60 * 60_000));
    utimesSync(join(root, incompatible), new Date(now.getTime() - 68 * 60 * 60_000), new Date(now.getTime() - 68 * 60 * 60_000));
    utimesSync(join(root, freshnessMismatch), new Date(now.getTime() - 67 * 60 * 60_000), new Date(now.getTime() - 67 * 60 * 60_000));
    utimesSync(join(root, conditionMismatch), new Date(now.getTime() - 66 * 60 * 60_000), new Date(now.getTime() - 66 * 60 * 60_000));
    utimesSync(join(root, malformed), new Date(now.getTime() - 70 * 60 * 60_000), new Date(now.getTime() - 70 * 60 * 60_000));
    await prunePublications(new FilePublicationStore(root, true), pointer, now);
    expect(existsSync(join(root, rollback))).toBe(true);
    expect(existsSync(join(root, incomplete))).toBe(false);
    expect(existsSync(join(root, incompatible))).toBe(false);
    expect(existsSync(join(root, freshnessMismatch))).toBe(false);
    expect(existsSync(join(root, conditionMismatch))).toBe(false);
    expect(existsSync(join(root, malformed))).toBe(false);
  });
});
