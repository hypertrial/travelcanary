import { describe, expect, it, vi } from "vitest";
import { CollectionChangedError, parseCatalogState, type IngestionStateV14 } from "@/lib/domain/catalog-state";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { runIngestion, runMaintenance } from "@/lib/ingestion/orchestrator";
import type { SourceAdapter } from "@/lib/ingestion/types";
import { ConcurrencyError, MemorySnapshotStore, MemoryStateStore, type Versioned } from "@/lib/storage";
import type { AggregateSourceResult, NormalizedEvent } from "@/lib/domain/schemas";

const now = new Date("2026-08-31T17:45:00Z");
function warning(id = "usgs:collected"): NormalizedEvent {
  return { id, sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Earthquake reported nearby.", explanation: "Preliminary earthquake evidence.", action: "Check official advice.", affectedArea: "Vienna",
    geometry: { kind: "locations", ids: ["at-vienna"] }, startsAt: now.toISOString(), endsAt: "2026-08-31T19:45:00Z",
    checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), expiresAt: "2026-08-31T19:45:00Z", sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM" };
}
const result = (): AggregateSourceResult => ({ sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [warning()], status: "ok", error: null });
const initial = () => parseCatalogState(createEmptyState(now));

describe("canonical collection fences", () => {
  it.each(["ingestion", "maintenance"] as const)("rejects catalog3 before %s mutations or publication", async (operation) => {
    const base = initial();
    const snapshots = new MemorySnapshotStore(buildSnapshot(base, now));
    base.collection.catalogVersion = 3;
    const store = new MemoryStateStore(base);
    const write = vi.spyOn(store, "write"); const publish = vi.spyOn(snapshots, "publish");
    const collect = vi.fn<SourceAdapter["fetch"]>().mockResolvedValue(result());
    const promise = operation === "ingestion"
      ? runIngestion({ stateStore: store, snapshotStore: snapshots, now, cadence: "fast", adapters: [{ id: "usgs", cadence: "fast", fetch: collect }] })
      : runMaintenance({ stateStore: store, snapshotStore: snapshots, now });
    await expect(promise).rejects.toBeInstanceOf(CollectionChangedError);
    expect(collect).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect((await store.read()).data).toEqual(base);
  });

  it.each(["revision", "catalog"] as const)("discards collected source results after a concurrent %s change", async (change) => {
    const base = initial(); const store = new MemoryStateStore(base); const snapshots = new MemorySnapshotStore(buildSnapshot(base, now));
    let concurrent: IngestionStateV14 | undefined;
    const collect = vi.fn<SourceAdapter["fetch"]>().mockImplementation(async () => {
      const latest = await store.read(); latest.data.collection.revision += 1;
      if (change === "catalog") {
        latest.data.collection.catalogVersion = 3;
        latest.data.publicationTransition = { from: 2, to: 3, revision: latest.data.collection.revision, dualStartedAt: null, dualUntil: null };
      }
      latest.data.events = [warning("usgs:concurrent")];
      latest.data.fingerprints.concurrent = now.toISOString();
      concurrent = structuredClone(latest.data); await store.write(latest.data, latest);
      return result();
    });
    const publish = vi.spyOn(snapshots, "publish");
    await expect(runIngestion({ stateStore: store, snapshotStore: snapshots, now, cadence: "fast", adapters: [{ id: "usgs", cadence: "fast", fetch: collect }] })).rejects.toBeInstanceOf(CollectionChangedError);
    expect((await store.read()).data).toEqual(concurrent);
    expect(collect).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled();
  });

  it("rechecks the captured control after a private CAS conflict instead of rebasing stale results", async () => {
    class CutoverOnWrite extends MemoryStateStore {
      attempts = 0;
      override async write(state: IngestionStateV14, expected: Versioned<IngestionStateV14>) {
        this.attempts += 1;
        if (this.attempts === 1) {
          const latest = await super.read(); latest.data.collection.revision += 1; latest.data.events = [warning("usgs:concurrent")];
          await super.write(latest.data, latest);
          throw new ConcurrencyError("cutover won CAS");
        }
        return super.write(state, expected);
      }
    }
    const base = initial(); const store = new CutoverOnWrite(base); const snapshots = new MemorySnapshotStore(buildSnapshot(base, now));
    const publish = vi.spyOn(snapshots, "publish"); const collect = vi.fn<SourceAdapter["fetch"]>().mockResolvedValue(result());
    await expect(runIngestion({ stateStore: store, snapshotStore: snapshots, now, cadence: "fast", adapters: [{ id: "usgs", cadence: "fast", fetch: collect }] })).rejects.toBeInstanceOf(CollectionChangedError);
    expect((await store.read()).data.events.map(({ id }) => id)).toEqual(["usgs:concurrent"]);
    expect(store.attempts).toBe(1); expect(publish).not.toHaveBeenCalled(); expect(collect).toHaveBeenCalledOnce();
  });

  it("does not publish stale-control state when a public conflict requires repair", async () => {
    const base = initial(); const store = new MemoryStateStore(base); const snapshots = new MemorySnapshotStore(buildSnapshot(base, now));
    const publish = vi.spyOn(snapshots, "publish").mockImplementation(async () => {
      const latest = await store.read(); latest.data.collection.revision += 1; await store.write(latest.data, latest);
      throw new ConcurrencyError("publication raced control");
    });
    const collect = vi.fn<SourceAdapter["fetch"]>().mockResolvedValue(result());
    await expect(runIngestion({ stateStore: store, snapshotStore: snapshots, now, cadence: "fast", adapters: [{ id: "usgs", cadence: "fast", fetch: collect }] })).rejects.toBeInstanceOf(CollectionChangedError);
    expect(publish).toHaveBeenCalledOnce(); expect(collect).toHaveBeenCalledOnce();
    expect((await store.read()).data.collection.revision).toBe(1);
  });

  it("repairs a failed publication from committed canonical state without recollecting or replaying results", async () => {
    const base = initial(); base.collection.revision = 7;
    base.conditions.reservations = [{ at: now.toISOString(), weight: 25 }];
    const store = new MemoryStateStore(base); const snapshots = new MemorySnapshotStore(buildSnapshot(base, now));
    const originalPublish = snapshots.publish.bind(snapshots);
    vi.spyOn(snapshots, "publish").mockRejectedValueOnce(new Error("public write unavailable")).mockImplementation(originalPublish);
    const collect = vi.fn<SourceAdapter["fetch"]>().mockResolvedValue(result());
    await expect(runIngestion({ stateStore: store, snapshotStore: snapshots, now, cadence: "fast", adapters: [{ id: "usgs", cadence: "fast", fetch: collect }] })).rejects.toThrow("public write unavailable");
    const committed = (await store.read()).data;
    expect(committed.events).toEqual([warning()]); expect(committed.collection).toEqual(base.collection);
    await runMaintenance({ stateStore: store, snapshotStore: snapshots, now });
    const repaired = (await store.read()).data;
    expect(repaired.events).toEqual(committed.events); expect(repaired.conditions.reservations).toEqual(base.conditions.reservations);
    expect(repaired.collection).toEqual(base.collection); expect(repaired.schemaVersion).toBe(14);
    expect(collect).toHaveBeenCalledOnce();
    expect((await snapshots.readLatest()).data.locations["at-vienna"].hazards.length).toBeGreaterThan(0);
  });
});
