import { describe, expect, it } from "vitest";
import { runConditions } from "@/lib/conditions/worker";
import { conditionSourceIds } from "@/lib/domain/conditions";
import { acquireIngestionLease, assertIngestionLease } from "@/lib/ingestion-lease";
import { runIngestion } from "@/lib/ingestion/orchestrator";
import type { SourceAdapter } from "@/lib/ingestion/types";
import { publicOperationSummary } from "@/lib/operation-summary";
import { createEmptyState } from "@/lib/risk";
import { MemoryStateStore, type StateStore } from "@/lib/state-store";
import { MemoryPublicationStore } from "../helpers/publication";

const now = new Date("2026-09-18T06:00:00.000Z");
const later = new Date(now.getTime() + 31_000);
const publications = () => ({ publicationStore: new MemoryPublicationStore() });

describe("ingestion fencing and sanitized operation results", () => {
  it("discards completed source work without mutating state after a successor takes the lease", async () => {
    const stateStore = new MemoryStateStore(createEmptyState(now));
    const first = await acquireIngestionLease(stateStore, "writer-first", now, 30_000);
    if (!first) throw new Error("first lease unavailable");
    let unblock!: () => void; let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const adapter: SourceAdapter = { id: "usgs", cadence: "fast", async fetch() {
      started(); await blocked;
      return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null };
    } };
    const run = runIngestion({ cadence: "fast", adapters: [adapter], stateStore, catalogPublication: publications(), lease: first, now });
    await sourceStarted;
    const successor = await acquireIngestionLease(stateStore, "writer-second", later, 60_000);
    if (!successor) throw new Error("successor lease unavailable");
    const afterTakeover = await stateStore.read(); unblock();
    await expect(run).rejects.toThrow(/lease was lost/);
    expect(await stateStore.read()).toEqual(afterTakeover);
    await expect(assertIngestionLease(stateStore, successor, later)).resolves.toBeDefined();
  });

  it("rejects stale conditions work before reservation and after a mid-run takeover", async () => {
    const staleStore = new MemoryStateStore(createEmptyState(now));
    const stale = await acquireIngestionLease(staleStore, "conditions-stale", now, 30_000);
    if (!stale) throw new Error("stale lease unavailable");
    const current = await acquireIngestionLease(staleStore, "conditions-current", later, 60_000);
    if (!current) throw new Error("current lease unavailable");
    const before = await staleStore.read();
    await expect(runConditions({ stateStore: staleStore, catalogPublication: publications(), lease: stale, now: later,
      env: { CONDITIONS_DISABLED_SOURCES: conditionSourceIds.join(",") } })).rejects.toThrow(/lease was lost/);
    expect(await staleStore.read()).toEqual(before);

    const base = new MemoryStateStore(createEmptyState(now));
    const first = await acquireIngestionLease(base, "conditions-first", now, 30_000);
    if (!first) throw new Error("first lease unavailable");
    let afterTakeover: Awaited<ReturnType<StateStore["read"]>> | undefined;
    const stateStore: StateStore = {
      read: () => base.read(),
      async write(state, expected) {
        const result = await base.write(state, expected);
        if (!afterTakeover) {
          const successor = await acquireIngestionLease(base, "conditions-second", later, 60_000);
          if (!successor) throw new Error("successor lease unavailable");
          afterTakeover = await base.read();
        }
        return result;
      },
    };
    await expect(runConditions({ stateStore, catalogPublication: publications(), lease: first, now,
      env: { CONDITIONS_DISABLED_SOURCES: conditionSourceIds.join(",") } })).rejects.toThrow(/lease was lost/);
    expect(afterTakeover).toBeDefined();
    expect(await base.read()).toEqual(afterTakeover);
  });

  it("maps exception details to stable codes and counters", async () => {
    const sentinel = "https://provider.example/feed?token=provider-secret-sentinel";
    const stateStore = new MemoryStateStore(createEmptyState(now));
    const lease = await acquireIngestionLease(stateStore, "sanitized-source", now, 330_000);
    if (!lease) throw new Error("lease unavailable");
    const adapter: SourceAdapter = { id: "usgs", cadence: "fast", async fetch() { throw new Error(sentinel); } };
    const result = await runIngestion({ cadence: "fast", adapters: [adapter], stateStore,
      catalogPublication: publications(), lease, now });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.sources.usgs.error).toBe("source_failed");
    expect((await stateStore.read()).data.sources.usgs.error).toBe("transport_failed");
    const outward = publicOperationSummary({ ...result, internal: sentinel,
      sources: { ...result.sources, "awc-metar": { status: "disabled" }, "unreviewed-source": { status: "failed" } },
      publication: { ...result.publication, error: sentinel, published: 45 } });
    expect(outward).toMatchObject({ status: "ok", locations: 679, publication: { published: 45 },
      sourceSummary: { successful: 0, partial: 0, failed: 1, disabled: 1 }, degradedSourceIds: ["usgs"] });
    expect(JSON.stringify(outward)).not.toMatch(/provider-secret-sentinel|provider\.example/);
  });
});
