import { describe, expect, it } from "vitest";
import { createEmptyState, mergeExpandedSourceReceipt, mergeSourceResults } from "@/lib/risk-state";
import { CatalogPartitionedSourceResultSchema, EA_FLOOD_GEOMETRY_CACHE_LIMIT, IngestionStateV15Schema } from "@/lib/domain/catalog-state";
import type { AggregateSourceResult } from "@/lib/domain/schemas";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
import { catalogV3CountryCodes } from "@/lib/domain/contract-identities";

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
    expect(IngestionStateV15Schema.safeParse(value).success).toBe(true);
  });

  it("records exact partial cohort checks without mutating the adapter result", () => {
    const value = state(); const input = result("partial", 37); const before = structuredClone(input);
    mergeExpandedSourceReceipt(value, input);
    expect(value.expandedSourceHealth.usgs).toMatchObject({ checkedLocationIds: ids.slice(0, 37).sort(), unavailableLocationIds: ids.slice(37).sort(),
      health: { status: "partial", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(), itemCount: 0 } });
    expect(input).toEqual(before); expect(IngestionStateV15Schema.safeParse(value).success).toBe(true);
  });

  it("retains last known successful source freshness after a newer failed attempt", () => {
    const value = state(); mergeExpandedSourceReceipt(value, result("ok", 176)); const success = structuredClone(value.expandedSourceHealth.usgs!);
    const failure = result("failed", 0, 1); failure.sourceUpdatedAt = null; mergeExpandedSourceReceipt(value, failure);
    expect(value.expandedSourceHealth.usgs!.health).toMatchObject({ lastAttempt: failure.checkedAt, lastSuccess: success.health.lastSuccess,
      sourceUpdatedAt: success.health.sourceUpdatedAt, consecutiveFailures: 1 });
    expect(value.expandedSourceHealth.usgs!.checkedLocationIds).toEqual([]);
    expect(IngestionStateV15Schema.safeParse(value).success).toBe(true);
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

  it("excludes disabled country scope from a catalog receipt aggregate", () => {
    const value = state();
    const partitions = Object.fromEntries(catalogV3CountryCodes.map((code) => [code, { status: "disabled", sourceUpdatedAt: null,
      events: [], error: null, limitationCode: "mapping_not_verified", checkedLocationIds: [], unavailableLocationIds: [] }]));
    Object.assign(partitions, {
      AD: { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null,
        checkedLocationIds: ["ad-andorra-la-vella"], unavailableLocationIds: [] },
      BA: { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "mapping_not_verified",
        checkedLocationIds: [], unavailableLocationIds: ["ba-sarajevo"] },
    });
    const input = CatalogPartitionedSourceResultSchema.parse({ sourceId: "meteoalarm", checkedAt: now.toISOString(), partitions });
    const merged = mergeSourceResults(value, [input], now);
    expect(merged.collectionReceipts[3].meteoalarm).toMatchObject({ status: "ok", checkedLocationIds: ["ad-andorra-la-vella"], unavailableLocationIds: [] });
    expect(IngestionStateV15Schema.safeParse(merged).success).toBe(true);
  });

  it("persists validated Environment Agency geometry independently of active events", () => {
    const value = state();
    const partitions = Object.fromEntries(catalogV3CountryCodes.map((code) => [code, { status: "disabled", sourceUpdatedAt: null,
      events: [], error: null, limitationCode: "not_supported", checkedLocationIds: [], unavailableLocationIds: [] }]));
    Object.assign(partitions, { GB: { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null,
      checkedLocationIds: ["gb-london"], unavailableLocationIds: [], transports: { "ea-flood": { status: "ok",
        sourceUpdatedAt: now.toISOString(), events: [], error: null, checkedLocationIds: ["gb-london"], unavailableLocationIds: [],
        frozenEaFloodAreaGeometries: { area1: [{ kind: "polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }] } } } } });
    const input = CatalogPartitionedSourceResultSchema.parse({ sourceId: "national-civil-alerts", checkedAt: now.toISOString(), partitions });
    const merged = mergeSourceResults(value, [input], now);

    expect(merged.frozenEaFloodAreaGeometries.area1).toHaveLength(1);
    expect(merged.events).toEqual([]);
    expect(IngestionStateV15Schema.safeParse(merged).success).toBe(true);
  });

  it("evicts frozen flood geometry deterministically before it can exceed private-state capacity", () => {
    const value = state();
    const largeRing = Array.from({ length: 5_000 }, (_, index) => [index / 10_000, index % 2] as [number, number]);
    largeRing[largeRing.length - 1] = largeRing[0];
    const geometries = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`area-${index}`,
      [{ kind: "polygon" as const, coordinates: [largeRing] }]]));
    const partitions = Object.fromEntries(catalogV3CountryCodes.map((code) => [code, { status: "disabled", sourceUpdatedAt: null,
      events: [], error: null, limitationCode: "not_supported", checkedLocationIds: [], unavailableLocationIds: [] }]));
    Object.assign(partitions, { GB: { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null,
      transports: { "ea-flood": { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null,
        frozenEaFloodAreaGeometries: geometries } } } });
    const input = CatalogPartitionedSourceResultSchema.parse({ sourceId: "national-civil-alerts", checkedAt: now.toISOString(), partitions });
    const merged = mergeSourceResults(value, [input], now);
    const reversed = structuredClone(input);
    reversed.partitions.GB.transports!["ea-flood"].frozenEaFloodAreaGeometries = Object.fromEntries(Object.entries(geometries).reverse());
    const reversedMerged = mergeSourceResults(value, [reversed], now);

    expect(Buffer.byteLength(JSON.stringify(merged.frozenEaFloodAreaGeometries))).toBeLessThanOrEqual(EA_FLOOD_GEOMETRY_CACHE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(merged))).toBeLessThan(5_000_000);
    expect(reversedMerged.frozenEaFloodAreaGeometries).toEqual(merged.frozenEaFloodAreaGeometries);
    expect(IngestionStateV15Schema.safeParse(merged).success).toBe(true);
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
