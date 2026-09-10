import type { IngestionStateV14 as IngestionState } from "@/lib/domain/catalog-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { ConcurrencyError, MemorySnapshotStore, MemoryStateStore, type SnapshotStore, type StateStore, type Versioned } from "@/lib/storage";
import { runIngestion, runMaintenance } from "@/lib/ingestion/orchestrator";
import { partitionExecutionStatus, sourceExecutionFailsSmoke, type SourceAdapter } from "@/lib/ingestion/types";
import { fetchWithRetry } from "@/lib/ingestion/fetch";
import { MAX_EVENTS_PER_SOURCE_RESULT } from "@/lib/ingestion/limits";
import { countryCodes, type NormalizedEvent, type Snapshot } from "@/lib/domain/schemas";
import { locations } from "@/lib/data";

function warning(now: Date): NormalizedEvent {
  const location = locations[0];
  return {
    id: "usgs:test", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Earthquake shaking may affect this area.", explanation: "Preliminary official information is available.",
    action: "Follow local emergency instructions.", affectedArea: location.name,
    geometry: { kind: "point", coordinates: location.centroid, radiusKm: 1 },
    startsAt: new Date(now.getTime() - 60_000).toISOString(), endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM",
  };
}

class ConflictOnceSnapshotStore implements SnapshotStore {
  private version = 1;
  private conflicts = true;
  constructor(private data: Snapshot, private concurrent: Snapshot) {}
  async readLatest() { return { data: structuredClone(this.data), etag: String(this.version) }; }
  async publish(snapshot: Snapshot, expected: Versioned<Snapshot>) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (this.conflicts) {
      this.conflicts = false;
      this.data = structuredClone(this.concurrent);
      this.version += 1;
      throw new ConcurrencyError("simulated overlap");
    }
    if (expected.etag !== String(this.version)) throw new ConcurrencyError("unexpected version");
    this.data = structuredClone(snapshot);
    this.version += 1;
    return { etag: String(this.version) };
  }
}

class ConflictTwiceSnapshotStore implements SnapshotStore {
  private version = 1;
  private conflicts = 2;
  constructor(private data: Snapshot) {}
  async readLatest() { return { data: structuredClone(this.data), etag: String(this.version) }; }
  async publish(snapshot: Snapshot, expected: Versioned<Snapshot>) {
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      this.data = { ...this.data, generatedAt: new Date(Date.parse(this.data.generatedAt) + 60_000).toISOString() };
      this.version += 1;
      throw new ConcurrencyError("simulated overlap");
    }
    if (expected.etag !== String(this.version)) throw new ConcurrencyError("unexpected version");
    this.data = structuredClone(snapshot);
    this.version += 1;
    return { etag: String(this.version) };
  }
}

class RebaseStateStore implements StateStore {
  private version = 1;
  private written = false;
  constructor(private data: IngestionState, private rebased: IngestionState) {}
  async read() {
    return { data: structuredClone(this.written ? this.rebased : this.data), etag: String(this.version) };
  }
  async write(state: IngestionState, expected: Versioned<IngestionState>) {
    if (expected.etag !== String(this.version)) throw new ConcurrencyError("unexpected state version");
    this.data = structuredClone(state);
    this.written = true;
    this.version += 1;
    return { etag: String(this.version) };
  }
}

describe("ingestion orchestration", () => {
  afterEach(() => vi.useRealTimers());
  it("backs off GDELT after repeated failure and resets after a successful retry", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    try {
      const now = new Date("2026-08-31T12:00:00Z"); const state = createEmptyState(now);
      state.sources.gdelt = { ...state.sources.gdelt, lastAttempt: now.toISOString(), consecutiveFailures: 2 };
      const stateStore = new MemoryStateStore(state); const snapshotStore = new MemorySnapshotStore(buildSnapshot(state, now));
      const fetch = vi.fn(async (context: { now: Date }) => ({ sourceId: "gdelt" as const, checkedAt: context.now.toISOString(), sourceUpdatedAt: context.now.toISOString(), status: "ok" as const, events: [], error: null }));
      const adapter: SourceAdapter = { id: "gdelt", cadence: "slow", fetch };
      await runIngestion({ cadence: "slow", adapters: [adapter], stateStore, snapshotStore, now: new Date(now.getTime() + 3600000) });
      expect(fetch).not.toHaveBeenCalled();
      await runIngestion({ cadence: "slow", adapters: [adapter], stateStore, snapshotStore, now: new Date(now.getTime() + 7200000) });
      expect(fetch).toHaveBeenCalledOnce();
      expect((await stateStore.read()).data.sources.gdelt.consecutiveFailures).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it("reports failure when every enabled partition failed", () => {
    expect(partitionExecutionStatus([
      ...Array.from({ length: 24 }, () => ({ status: "disabled" as const })),
      ...Array.from({ length: 4 }, () => ({ status: "failed" as const })),
    ])).toBe("failed");
  });

  it("fails smoke checks only for unavailable enabled partitions", () => {
    expect(sourceExecutionFailsSmoke("partial", [
      ...Array.from({ length: 24 }, () => ({ status: "disabled" as const })),
      ...Array.from({ length: 4 }, () => ({ status: "ok" as const })),
    ])).toBe(false);
    expect(sourceExecutionFailsSmoke("disabled", [{ status: "disabled" }])).toBe(false);
    expect(sourceExecutionFailsSmoke("partial", [{ status: "ok" }, { status: "partial" }])).toBe(true);
    expect(sourceExecutionFailsSmoke("failed", [{ status: "failed" }, { status: "disabled" }])).toBe(true);
    expect(sourceExecutionFailsSmoke("partial")).toBe(true);
  });

  it("publishes a complete validated snapshot", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const snapshotStore = new MemorySnapshotStore(buildSnapshot(state, now));
    const adapter: SourceAdapter = { id: "usgs", cadence: "fast", async fetch() { return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null }; } };
    const summary = await runIngestion({ cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state), snapshotStore, now });
    expect(summary.locations).toBe(503);
    expect(summary.sources.usgs.status).toBe("ok");
    expect(summary.timings).toEqual(expect.objectContaining({
      sourcesMs: expect.any(Number), readMs: expect.any(Number), mergeAndBuildMs: expect.any(Number),
      publishMs: expect.any(Number), totalMs: expect.any(Number),
    }));
  });

  it("isolates an unexpected adapter exception from healthy sources in the same cadence", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const healthy: SourceAdapter = { id: "usgs", cadence: "fast", async fetch() { return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null }; } };
    const throwing: SourceAdapter = { id: "emsc", cadence: "fast", async fetch() { throw new Error("malformed source"); } };
    const summary = await runIngestion({ cadence: "fast", adapters: [healthy, throwing], stateStore: new MemoryStateStore(state), snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now });
    expect(summary.sources.usgs.status).toBe("ok");
    expect(summary.sources.emsc).toMatchObject({ status: "failed", error: "malformed source" });
  });

  it("converts an unexpected partitioned-adapter exception into country failures", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const throwing: SourceAdapter = { id: "meteoalarm", cadence: "fast", async fetch() { throw new Error("partition source failed"); } };
    const summary = await runIngestion({ cadence: "fast", adapters: [throwing], stateStore: new MemoryStateStore(state), snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now });
    expect(summary.sources.meteoalarm).toMatchObject({ status: "failed", partitions: { failed: countryCodes.length, failedIds: countryCodes } });
  });

  it("publishes private per-source resource diagnostics", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch(context) {
        await fetchWithRetry(context.fetch, "https://example.test/source", {}, 1, 100, undefined, 5_000, "feed");
        context.diagnostics!.recordsExamined += 3;
        return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null };
      },
    };
    const summary = await runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
      fetch: async () => new Response("abc"),
    });
    expect(summary.sources.usgs.diagnostics).toEqual({
      requests: 1, retries: 0, responseBytes: 3, recordsExamined: 3,
      targetsScheduled: 0, targetsCompleted: 0, matchedLocations: 0,
      overflowCodes: [], outcomeCodes: [], responseBytesByCategory: { feed: 3 },
    });
  });

  it("fails closed before an oversized source result can mutate state", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const stateStore = new MemoryStateStore(state);
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch() {
        return {
          sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
          events: Array.from({ length: MAX_EVENTS_PER_SOURCE_RESULT + 1 }, (_, index) => ({ ...warning(now), id: `overflow-${index}` })),
          status: "ok", error: null,
        };
      },
    };
    await expect(runIngestion({
      cadence: "fast", adapters: [adapter], stateStore,
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
    })).rejects.toThrow(/source-result limit/);
    expect((await stateStore.read()).data.events).toEqual([]);
  });

  it("rebases publication after an overlapping public snapshot write", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const stateStore = new MemoryStateStore(state);
    const concurrent = buildSnapshot(state, new Date("2026-08-25T12:02:00Z"));
    const snapshotStore = new ConflictOnceSnapshotStore(buildSnapshot(state, new Date("2026-08-25T11:58:00Z")), concurrent);
    const event = warning(now);
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch() { return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [event], status: "ok", error: null }; },
    };

    const summary = await runIngestion({ cadence: "fast", adapters: [adapter], stateStore, snapshotStore, now });
    const published = (await snapshotStore.readLatest()).data;
    expect(published.generatedAt).toBe(concurrent.generatedAt);
    expect(published.locations[locations[0].id].level).toBe("ELEVATED");
    expect(summary.timings.publishMs).toBeGreaterThanOrEqual(2);
    expect(summary.timings.totalMs).toBeGreaterThanOrEqual(summary.timings.publishMs);
  });

  it("applies source results only once across repeated snapshot conflicts", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const stateStore = new MemoryStateStore(state);
    const adapter: SourceAdapter = {
      id: "usgs",
      cadence: "fast",
      async fetch() {
        return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" };
      },
    };

    const summary = await runIngestion({
      cadence: "fast",
      adapters: [adapter],
      stateStore,
      snapshotStore: new ConflictTwiceSnapshotStore(buildSnapshot(state, now)),
      now,
    });

    expect((await stateStore.read()).data.sources.usgs).toMatchObject({ status: "failed", consecutiveFailures: 1 });
    expect(summary.generatedAt).toBe("2026-08-25T12:02:00.000Z");
  });

  it("rebuilds from private state when the public snapshot starts newer than the run", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const snapshotStore = new MemorySnapshotStore(buildSnapshot(state, new Date("2026-08-25T12:03:00Z")));
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch() { return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [warning(now)], status: "ok", error: null }; },
    };

    const summary = await runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state), snapshotStore, now,
    });

    const published = (await snapshotStore.readLatest()).data;
    expect(summary.generatedAt).toBe("2026-08-25T12:03:00.000Z");
    expect(published.locations[locations[0].id].level).toBe("ELEVATED");
  });

  it("recovers from an implausibly future-dated public snapshot", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const snapshotStore = new MemorySnapshotStore(buildSnapshot(state, new Date("2099-01-01T00:00:00Z")));
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch() { return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [warning(now)], status: "ok", error: null }; },
    };

    const summary = await runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state), snapshotStore, now,
    });

    expect(summary.generatedAt).toBe(now.toISOString());
    expect((await snapshotStore.readLatest()).data.locations[locations[0].id].level).toBe("ELEVATED");
  });

  it("revalidates the snapshot size after a conflict rebase", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const rebased = createEmptyState(now);
    rebased.events = Array.from({ length: 20 }, (_, index) => ({
      ...warning(now), id: `large-${index}`, geometry: { kind: "locations" as const, ids: locations.map(({ id }) => id) },
    }));
    const concurrent = buildSnapshot(state, new Date("2026-08-25T11:59:00Z"));
    const snapshotStore = new ConflictOnceSnapshotStore(buildSnapshot(state, new Date("2026-08-25T11:58:00Z")), concurrent);
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch() { return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null }; },
    };

    await expect(runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new RebaseStateStore(state, rebased), snapshotStore, now,
    })).rejects.toThrow(/500 KB hard limit/);
    expect((await snapshotStore.readLatest()).data.generatedAt).toBe(concurrent.generatedAt);
  });

  it("maintenance prunes expired events without fetching a source", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    state.events = [{ ...warning(new Date("2026-08-25T10:00:00Z")), endsAt: "2026-08-25T11:00:00Z", expiresAt: "2026-08-25T11:00:00Z" }];
    const stateStore = new MemoryStateStore(state);
    const snapshotStore = new MemorySnapshotStore(buildSnapshot(state, now));

    const summary = await runMaintenance({ stateStore, snapshotStore, now });
    expect(summary.operation).toBe("maintenance");
    expect((await stateStore.read()).data.events).toHaveLength(0);
  });

  it("summarizes partitioned source results without exposing payloads", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const adapter: SourceAdapter = {
      id: "meteoalarm", cadence: "fast",
      async fetch() {
        return {
          sourceId: "meteoalarm" as const, checkedAt: now.toISOString(),
          partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
            status: countryCode === "CH" ? "failed" as const : "ok" as const,
            sourceUpdatedAt: countryCode === "CH" ? null : now.toISOString(), events: [],
            error: countryCode === "CH" ? "timeout" : null,
          }])) as Record<typeof countryCodes[number], { status: "ok" | "failed"; sourceUpdatedAt: string | null; events: []; error: string | null }>,
        };
      },
    };
    const summary = await runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
    });
    expect(summary.sources.meteoalarm).toMatchObject({
      status: "partial", events: 0, partitions: { total: 28, succeeded: 27, partial: 0, failed: 1, disabled: 0, partialIds: [], failedIds: ["CH"] },
    });
    expect(JSON.stringify(summary)).not.toMatch(/fingerprint|Bearer|source text/i);
  });

  it("reports partial partitions as partial instead of successful", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const adapter: SourceAdapter = {
      id: "eea", cadence: "slow",
      async fetch() {
        return {
          sourceId: "eea" as const, checkedAt: now.toISOString(),
          partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
            status: countryCode === "HU" ? "partial" as const : "ok" as const,
            sourceUpdatedAt: now.toISOString(), events: [],
            error: countryCode === "HU" ? "one sample unavailable" : null,
          }])) as Record<typeof countryCodes[number], { status: "ok" | "partial"; sourceUpdatedAt: string; events: []; error: string | null }>,
        };
      },
    };
    const summary = await runIngestion({
      cadence: "slow", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
    });
    expect(summary.sources.eea).toMatchObject({
      status: "partial", partitions: { total: 28, succeeded: 27, partial: 1, failed: 0, disabled: 0, partialIds: ["HU"], failedIds: [] },
      error: "1 of 28 partitions partially unavailable",
    });
  });

  it("reports readiness-gated partitions as disabled rather than healthy", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const adapter: SourceAdapter = {
      id: "national-civil-alerts", cadence: "fast",
      async fetch() {
        return {
          sourceId: "national-civil-alerts" as const, checkedAt: now.toISOString(),
          partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
            status: "disabled" as const, sourceUpdatedAt: null, events: [], error: null,
            limitationCode: "no_approved_machine_feed",
          }])) as Record<typeof countryCodes[number], { status: "disabled"; sourceUpdatedAt: null; events: []; error: null; limitationCode: string }>,
        };
      },
    };
    const summary = await runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
    });
    expect(summary.sources["national-civil-alerts"]).toMatchObject({
      status: "disabled", events: 0,
      partitions: { total: 28, succeeded: 0, partial: 0, failed: 0, disabled: 28, partialIds: [], failedIds: [] },
      error: "28 of 28 partitions readiness-gated",
    });
  });

  it("reports timing fields for slow ingestion", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const adapter: SourceAdapter = {
      id: "effis", cadence: "slow",
      async fetch() { return { sourceId: "effis", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null }; },
    };
    const summary = await runIngestion({
      cadence: "slow", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
    });
    expect(summary.operation).toBe("slow");
    expect(summary.sources.effis.status).toBe("ok");
    expect(Object.keys(summary.timings)).toEqual(["sourcesMs", "readMs", "mergeAndBuildMs", "publishMs", "totalMs"]);
  });

  it("reports partial aggregate source execution", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const adapter: SourceAdapter = {
      id: "cems", cadence: "fast",
      async fetch() {
        return {
          sourceId: "cems", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [],
          status: "partial", error: "1 of 2 activation details unavailable",
        };
      },
    };
    const summary = await runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now,
    });
    expect(summary.sources.cems).toMatchObject({ status: "partial", events: 0, error: "1 of 2 activation details unavailable" });
  });

  it("aborts upstream work at the shared source deadline and still publishes", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-25T12:00:00Z");
    const state = createEmptyState(now);
    const upstream = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    const adapter: SourceAdapter = {
      id: "usgs", cadence: "fast",
      async fetch(context) {
        try {
          await context.fetch("https://example.test/hangs");
          throw new Error("unexpected response");
        } catch {
          return { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "deadline reached" };
        }
      },
    };
    const request = runIngestion({
      cadence: "fast", adapters: [adapter], stateStore: new MemoryStateStore(state),
      snapshotStore: new MemorySnapshotStore(buildSnapshot(state, now)), now, fetch: upstream,
    });

    await vi.advanceTimersByTimeAsync(45_000);
    const summary = await request;
    expect(summary.sources.usgs.status).toBe("failed");
    expect(summary.generatedAt).toBe(now.toISOString());
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
