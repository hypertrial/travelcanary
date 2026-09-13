import { describe, expect, it, vi } from "vitest";
import { CatalogPartitionedSourceResultSchema, CollectionChangedError, parseCatalogState, type IngestionStateV15 } from "@/lib/domain/catalog-state";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";
import { runIngestion, runMaintenance } from "@/lib/ingestion/orchestrator";
import type { SourceAdapter } from "@/lib/ingestion/types";
import { ConcurrencyError, MemorySnapshotStore, MemoryStateStore, type Versioned } from "@/lib/storage";
import type { AggregateSourceResult, NormalizedEvent } from "@/lib/domain/schemas";
import { catalogV3CountryCodes } from "@/lib/domain/contract-identities";

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
  it("keeps polygon events owned by their catalog country across sequential partition replacement", () => {
    const state = initial(); state.collection = { catalogVersion: 3, revision: 1 };
    const event = (country: "AD" | "IS"): NormalizedEvent => ({ ...warning(`meteoalarm:${country}`), sourceId: "meteoalarm", providerId: "meteoalarm",
      type: "severe-weather", geometry: { kind: "polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, affectedArea: country,
      sourceName: "MeteoAlarm", sourceUrl: "https://meteoalarm.org/" });
    const failedPartitions = () => Object.fromEntries(catalogV3CountryCodes.map((code) => [code,
      { status: "failed", sourceUpdatedAt: null, events: [], error: "not collected in fixture" }]));
    const firstPartitions = failedPartitions(); Object.assign(firstPartitions, {
      AD: { status: "ok", sourceUpdatedAt: now.toISOString(), events: [event("AD")], error: null },
      IS: { status: "ok", sourceUpdatedAt: now.toISOString(), events: [event("IS")], error: null },
    });
    const first = CatalogPartitionedSourceResultSchema.parse({ sourceId: "meteoalarm", checkedAt: now.toISOString(), partitions: firstPartitions });
    const merged = mergeSourceResults(state, [first], now);
    expect(merged.events.map(({ id, partitionCountryCode }) => [id, partitionCountryCode]).sort()).toEqual([
      ["meteoalarm:AD", "AD"], ["meteoalarm:IS", "IS"],
    ]);
    const later = new Date(now.getTime() + 60_000);
    const secondPartitions = failedPartitions(); Object.assign(secondPartitions, {
      IS: { status: "ok", sourceUpdatedAt: later.toISOString(), events: [], error: null },
    });
    const second = CatalogPartitionedSourceResultSchema.parse({ sourceId: "meteoalarm", checkedAt: later.toISOString(), partitions: secondPartitions });
    expect(mergeSourceResults(merged, [second], later).events.map(({ id }) => id)).toEqual(["meteoalarm:AD"]);
  });

  it("retains migrated unowned polygons when a sibling country refresh succeeds", () => {
    const state = initial(); state.collection = { catalogVersion: 3, revision: 1 };
    state.events = [{ ...warning("meteoalarm:legacy-polygon"), sourceId: "meteoalarm", providerId: "meteoalarm",
      transportId: "meteoalarm-atom", type: "severe-weather", geometry: { kind: "polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      sourceName: "MeteoAlarm", sourceUrl: "https://meteoalarm.org/" }];
    const partitions = Object.fromEntries(catalogV3CountryCodes.map((code) => [code,
      { status: "failed", sourceUpdatedAt: null, events: [], error: "not collected in fixture" }]));
    Object.assign(partitions, { AD: { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null,
      transports: { "meteoalarm-atom": { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null } } } });
    const refresh = CatalogPartitionedSourceResultSchema.parse({ sourceId: "meteoalarm", checkedAt: now.toISOString(), partitions });

    expect(mergeSourceResults(state, [refresh], now).events.map(({ id }) => id)).toEqual(["meteoalarm:legacy-polygon"]);
  });

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
    let concurrent: IngestionStateV15 | undefined;
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
      override async write(state: IngestionStateV15, expected: Versioned<IngestionStateV15>) {
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
    expect(repaired.collection).toEqual(base.collection); expect(repaired.schemaVersion).toBe(15);
    expect(collect).toHaveBeenCalledOnce();
    expect((await snapshots.readLatest()).data.locations["at-vienna"].hazards.length).toBeGreaterThan(0);
  });
});
