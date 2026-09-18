import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectorCadenceMs, collectorOperations, SerialCollector } from "@/lib/collector";
import { IngestionStateV16Schema } from "@/lib/domain/catalog-state";
import { disabledLocalPolicy } from "@/lib/local-policy";
import { initializeLocalRuntime, LocalDatabase, LocalStateStore, readLocalPolicy } from "@/lib/local-storage";
import { readCollectorStatus, writeCollectorStatus } from "@/lib/local-status";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "travelcanary-sqlite-"));
  const path = join(directory, "travelcanary.db");
  return { directory, path, database: new LocalDatabase(path) };
}

describe("private local state", () => {
  it("initializes only private Catalog 3 V16 state", async () => {
    const { path, database } = temporaryDatabase();
    expect(initializeLocalRuntime(database)).toEqual({ initialized: true, catalogVersion: 3, destinations: 679 });
    const state = await new LocalStateStore(database).read();
    expect(IngestionStateV16Schema.parse(state.data)).toMatchObject({ schemaVersion: 16, collection: { catalogVersion: 3 } });
    expect(readLocalPolicy(database).policy).toEqual(disabledLocalPolicy());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const rows = new DatabaseSync(path).prepare("SELECT DISTINCT namespace FROM objects").all();
    expect(rows).toEqual([{ namespace: "private" }]);
    database.close();
  });

  it("enforces state CAS and increments the V16 revision", async () => {
    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const store = new LocalStateStore(database); const first = await store.read(); const stale = await store.read();
    await store.write({ ...first.data, updatedAt: new Date(Date.parse(first.data.updatedAt) + 1).toISOString() }, first);
    await expect(store.write(stale.data, stale)).rejects.toThrow(/changed/);
    expect((await store.read()).data.stateRevision).toBe(first.data.stateRevision + 1);
    database.close();
  });

  it("persists bounded collector status without exposing public data", () => {
    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const timestamp = "2026-09-10T12:00:00.000Z";
    writeCollectorStatus(database, { schemaVersion: 1, state: "idle", lastHeartbeat: timestamp, lastSuccess: timestamp,
      lastOperation: "fast", lastError: null, completedAt: { fast: timestamp } });
    expect(readCollectorStatus(database)?.completedAt).toEqual({ fast: timestamp });
    expect(() => database.read("public" as never, "snapshot.json")).toThrow();
    database.close();
  });

  it("rejects partial initialization", () => {
    const { database } = temporaryDatabase();
    database.compareAndSwap("private", "test/partial", "{}", null, 10);
    expect(() => initializeLocalRuntime(database)).toThrow(/partially initialized/);
    database.close();
  });
});

describe("collector serialization", () => {
  afterEach(() => vi.useRealTimers());

  it("runs overlapping work one at a time in enqueue order", async () => {
    const events: string[] = [];
    const collector = new SerialCollector(async (operation) => {
      events.push(`start:${operation}`); await Promise.resolve(); events.push(`end:${operation}`);
    });
    await Promise.all([collector.enqueue("fast"), collector.enqueue("conditions"), collector.enqueue("maintenance")]);
    await collector.stop();
    expect(events).toEqual(["start:fast", "end:fast", "start:conditions", "end:conditions", "start:maintenance", "end:maintenance"]);
  });

  it("queues all six cadences at startup and stops cleanly", async () => {
    vi.useFakeTimers(); const operations: string[] = [];
    const collector = new SerialCollector(async (operation) => { operations.push(operation); });
    await collector.start();
    expect(operations).toEqual(["fast", "slow", "conditions", "satellite", "daily", "maintenance"]);
    await collector.stop(); await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(operations).toHaveLength(6);
  });

  it("runs only due work after restart", async () => {
    vi.useFakeTimers(); const now = Date.parse("2026-09-10T12:00:00.000Z");
    const completedAt = Object.fromEntries(collectorOperations.map((operation) => [operation, new Date(now).toISOString()]));
    completedAt.maintenance = new Date(now - collectorCadenceMs.maintenance).toISOString();
    const operations: string[] = []; const collector = new SerialCollector(async (operation) => { operations.push(operation); });
    await collector.start(completedAt, now); expect(operations).toEqual(["maintenance"]); await collector.stop();
  });
});
