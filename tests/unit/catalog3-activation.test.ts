import { describe, expect, it, vi } from "vitest";
import { activateCatalog3 } from "../../scripts/activate-catalog3";
import { createEmptyState } from "@/lib/risk-state";
import { ConcurrencyError, MemoryStateStore } from "@/lib/storage";

const now = new Date("2026-09-09T00:00:00Z");
describe("explicit drained catalog3 control transition", () => {
  it("advances revision once, preserves prior evidence and quota, and remains idempotent", async () => {
    const state = createEmptyState(now); state.collection.revision = 7;
    state.fingerprints.retained = now.toISOString(); state.conditions.reservations = [{ at: now.toISOString(), weight: 400 }];
    const store = new MemoryStateStore(state); const write = vi.spyOn(store, "write");
    expect(await activateCatalog3(store, now)).toMatchObject({ status: "activated", collection: { catalogVersion: 3, revision: 8 } });
    const after = (await store.read()).data;
    expect(after.publicationTransition).toEqual({ from: 2, to: 3, revision: 8, dualStartedAt: null, dualUntil: null });
    expect({ ...after, collection: state.collection, publicationTransition: state.publicationTransition }).toEqual(state);
    expect(await activateCatalog3(store, now)).toMatchObject({ status: "unchanged", collection: { catalogVersion: 3, revision: 8 } });
    expect(write).toHaveBeenCalledOnce(); expect((await store.read()).data).toEqual(after);
  });

  it.each([[-1, "rejected"], [0, "activated"]] as const)("enforces the live lease boundary at offset%s", async (offset, outcome) => {
    const state = createEmptyState(now); state.conditions.lease = { id: "00000000-0000-4000-8000-000000000001", expiresAt: new Date(now.getTime() - offset).toISOString() };
    const store = new MemoryStateStore(state); const write = vi.spyOn(store, "write");
    if (outcome === "rejected") { await expect(activateCatalog3(store, now)).rejects.toThrow(/lease/); expect(write).not.toHaveBeenCalled(); expect((await store.read()).data).toEqual(state); }
    else expect(await activateCatalog3(store, now)).toMatchObject({ status: "activated" });
  });

  it("does not retry a stale activation CAS or overwrite a concurrent control/evidence update", async () => {
    const state = createEmptyState(now); const store = new MemoryStateStore(state); const write = store.write.bind(store);
    vi.spyOn(store, "write").mockImplementationOnce(async (candidate, expected) => {
      const concurrent = await store.read(); concurrent.data.collection.revision = 1; concurrent.data.fingerprints.concurrent = now.toISOString();
      await write(concurrent.data, concurrent); return write(candidate, expected);
    });
    await expect(activateCatalog3(store, now)).rejects.toBeInstanceOf(ConcurrencyError);
    const after = (await store.read()).data; expect(after.collection).toEqual({ catalogVersion: 2, revision: 1 });
    expect(after.publicationTransition).toBeNull(); expect(after.fingerprints.concurrent).toBe(now.toISOString());
  });
});
