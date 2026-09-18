import { describe, expect, it } from "vitest";
import { publishCommittedCatalog } from "@/lib/catalog-publication";
import { acquireIngestionLease, assertIngestionLease } from "@/lib/ingestion-lease";
import { publicationPointerPath } from "@/lib/domain/publication";
import { createEmptyState } from "@/lib/risk-state";
import { readCurrentPublication, type PublicationStore } from "@/lib/publication-store";
import { MemoryStateStore } from "@/lib/state-store";
import { MemoryPublicationStore } from "../helpers/publication";

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
    expect(await store.list("catalogs/3/objects/sha256/", 100)).toHaveLength(46);
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
});
