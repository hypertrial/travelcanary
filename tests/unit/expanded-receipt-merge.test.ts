import { describe, expect, it } from "vitest";
import { createEmptyState, mergeExpandedSourceReceipt } from "@/lib/risk-state";
import { IngestionStateV14Schema } from "@/lib/domain/catalog-state";
import type { AggregateSourceResult } from "@/lib/domain/schemas";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";

const now = new Date("2026-09-08T12:00:00Z");
const ids = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
function state() { const value = createEmptyState(now); value.collection = { catalogVersion: 3, revision: 1 }; return value; }
function result(status: "ok" | "partial" | "failed", checkedCount: number, minutes = 0): AggregateSourceResult {
  return { sourceId: "usgs", checkedAt: new Date(now.getTime() + minutes * 60000).toISOString(), sourceUpdatedAt: now.toISOString(),
    status, events: [], error: status === "ok" ? null : "Some destinations unavailable", checkedLocationIds: ids.slice(0, checkedCount), unavailableLocationIds: ids.slice(checkedCount) };
}

describe("expanded source receipt merging", () => {
  it("records a first failure without fabricating a successful check", () => {
    const value = state(); mergeExpandedSourceReceipt(value, result("failed", 0));
    expect(value.expandedSourceHealth.usgs).toMatchObject({ checkedLocationIds: [], unavailableLocationIds: [...ids].sort(),
      health: { status: "failed", lastAttempt: now.toISOString(), lastSuccess: null, sourceUpdatedAt: null, consecutiveFailures: 1 } });
    expect(IngestionStateV14Schema.safeParse(value).success).toBe(true);
  });

  it("records exact partial cohort checks without mutating the adapter result", () => {
    const value = state(); const input = result("partial", 37); const before = structuredClone(input);
    mergeExpandedSourceReceipt(value, input);
    expect(value.expandedSourceHealth.usgs).toMatchObject({ checkedLocationIds: ids.slice(0, 37).sort(), unavailableLocationIds: ids.slice(37).sort(),
      health: { status: "partial", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(), itemCount: 0 } });
    expect(input).toEqual(before); expect(IngestionStateV14Schema.safeParse(value).success).toBe(true);
  });

  it("retains last known successful source freshness after a newer failed attempt", () => {
    const value = state(); mergeExpandedSourceReceipt(value, result("ok", 176)); const success = structuredClone(value.expandedSourceHealth.usgs!);
    const failure = result("failed", 0, 1); failure.sourceUpdatedAt = null; mergeExpandedSourceReceipt(value, failure);
    expect(value.expandedSourceHealth.usgs!.health).toMatchObject({ lastAttempt: failure.checkedAt, lastSuccess: success.health.lastSuccess,
      sourceUpdatedAt: success.health.sourceUpdatedAt, consecutiveFailures: 1 });
    expect(value.expandedSourceHealth.usgs!.checkedLocationIds).toEqual([]);
    expect(IngestionStateV14Schema.safeParse(value).success).toBe(true);
  });

  it("ignores stale and same-time replays, including a contradictory replayed result", () => {
    const value = state(); mergeExpandedSourceReceipt(value, result("ok", 176, 2)); const before = structuredClone(value);
    for (const input of [result("failed", 0, 1), result("failed", 0, 2), result("ok", 176, 2)]) {
      mergeExpandedSourceReceipt(value, input); expect(value).toEqual(before);
    }
  });

  it("does not refresh or remove expanded receipts during legacy collection", () => {
    const value = state(); mergeExpandedSourceReceipt(value, result("ok", 176)); value.collection = { catalogVersion: 2, revision: 2 };
    const before = structuredClone(value); mergeExpandedSourceReceipt(value, result("failed", 0, 1)); expect(value).toEqual(before);
  });

  it.each(["missing", "duplicate", "overlap", "failed checked"])("rejects incomplete or contradictory cohort scope %s without changing state", (mode) => {
    const value = state(); const input = result("partial", 37); const before = structuredClone(value);
    if (mode === "missing") input.unavailableLocationIds!.pop();
    if (mode === "duplicate") input.checkedLocationIds![0] = input.checkedLocationIds![1];
    if (mode === "overlap") input.unavailableLocationIds![0] = input.checkedLocationIds![0];
    if (mode === "failed checked") input.status = "failed";
    expect(() => mergeExpandedSourceReceipt(value, input)).toThrow(); expect(value).toEqual(before);
  });
});
