import { describe, expect, it } from "vitest";
import { initialSafetyDataState, safetyDataReducer, type SafetyDataAction } from "@/lib/safety-data-state";
import { parseCatalogSnapshot, PublicCatalogV3Schema } from "@/lib/domain/catalog-public";
import demo from "../../public/demo-snapshot.json";
import legacyLocations from "../../public/locations.json";
import candidates from "../../data/review-inputs/europe-expansion-catalog.json";
import release3 from "../../data/catalog-releases/3.json";

const receivedAt = Date.parse(demo.generatedAt);
const roster3 = PublicCatalogV3Schema.parse([...legacyLocations, ...candidates.locations]);
function snapshot(catalog: 2 | 3, generatedAt = demo.generatedAt) {
  const value = structuredClone(demo);
  if (catalog === 2) return parseCatalogSnapshot({ ...value, generatedAt });
  const countries = [...new Set(release3.locationIds.map((id) => id.slice(0, 2).toUpperCase()))];
  for (const id of ["meteoalarm", "eea-aqi", "national-civil-alerts"] as const) {
    Object.assign(value.providers[id], { partitions: Object.fromEntries(countries.map((country) => [country, value.providers[id].partitions.AT])) });
  }
  return parseCatalogSnapshot({ ...value, schemaVersion: 11, catalogVersion: 3, generatedAt,
    locations: Object.fromEntries(release3.locationIds.map((id) => [id, Reflect.get(value.locations, id)
      || { level: "UNKNOWN", coverage: "partial", coverageGaps: [], delayedHazards: [], hazards: [] }])) });
}
const key2 = "2:live:https://unit.public.blob.vercel-storage.com/latest.json";
const key3 = "3:live:https://unit.public.blob.vercel-storage.com/catalogs/3/latest.json";
const reset = (epoch: number, resourceKey: string): SafetyDataAction => ({ type: "reset", epoch, resourceKey });

function populated(epoch: number, catalog: 2 | 3) {
  let state = safetyDataReducer(initialSafetyDataState, reset(epoch, catalog === 2 ? key2 : key3));
  state = safetyDataReducer(state, { type: "start", epoch });
  state = safetyDataReducer(state, { type: "catalog-loading", epoch, request: 4 });
  state = safetyDataReducer(state, { type: "catalog-ready", epoch, request: 4, locations: catalog === 3 ? roster3 : roster3.filter(({ id }) => Reflect.has(demo.locations, id)) });
  state = safetyDataReducer(state, { type: "snapshot-loading", epoch, request: 9 });
  return safetyDataReducer(state, { type: "snapshot-ready", epoch, request: 9, snapshot: snapshot(catalog), receivedAt });
}

describe("safety reader release epochs", () => {
  it("fully resets previously loaded data, errors, counters and startup state on a new resource", () => {
    let before = populated(1, 3);
    before = safetyDataReducer(before, { type: "snapshot-failed", epoch: 1, request: 9 });
    before = safetyDataReducer(before, { type: "catalog-failed", epoch: 1, request: 4 });
    expect(before.snapshot).not.toBeNull(); expect(before.locations).toHaveLength(679);
    expect(before.snapshotError).not.toBeNull(); expect(before.catalogError).not.toBeNull();
    expect(safetyDataReducer(before, reset(2, key2))).toEqual({ ...initialSafetyDataState, epoch: 2, resourceKey: key2 });
  });

  it("ignores all old actions even when request numbers collide with the new resource", () => {
    const current = populated(2, 2);
    const actions: SafetyDataAction[] = [
      { type: "start", epoch: 1 }, { type: "catalog-loading", epoch: 1, request: 99 },
      { type: "catalog-ready", epoch: 1, request: 4, locations: roster3 }, { type: "catalog-failed", epoch: 1, request: 4 },
      { type: "snapshot-loading", epoch: 1, request: 99 }, { type: "snapshot-unconfigured", epoch: 1, request: 99 },
      { type: "snapshot-ready", epoch: 1, request: 9, snapshot: snapshot(3, "2026-08-25T12:05:00.000Z"), receivedAt },
      { type: "snapshot-failed", epoch: 1, request: 9 },
      // Untagged historical actions belong to epoch0 and cannot alter a live epoch.
      { type: "snapshot-failed", request: 9 },
      { type: "catalog-ready", request: 4, locations: roster3 },
    ];
    for (const action of actions) expect(safetyDataReducer(current, action)).toBe(current);
  });

  it("rejects stale and equal reset epochs, including an ABA return to the identical catalog3 resource", () => {
    const first = populated(1, 3);
    const second = safetyDataReducer(first, reset(2, key2));
    const third = safetyDataReducer(second, reset(3, key3));
    expect(third.resourceKey).toBe(first.resourceKey); expect(third.snapshot).toBeNull();
    for (const action of [reset(1, key3), reset(2, key2), reset(3, key2),
      { type: "snapshot-ready" as const, epoch: 1, request: 9, snapshot: snapshot(3), receivedAt },
      { type: "catalog-ready" as const, epoch: 1, request: 0, locations: roster3 }]) {
      expect(safetyDataReducer(third, action)).toBe(third);
    }
    expect(safetyDataReducer(third, { type: "snapshot-ready", epoch: 3, request: 1, snapshot: snapshot(3), receivedAt }).snapshot?.catalogVersion).toBe(3);
  });

  it("preserves timestamp ordering across out-of-order successes within the same epoch", () => {
    const current = populated(4, 3);
    const pending = safetyDataReducer(current, { type: "snapshot-loading", epoch: 4, request: 11 });
    const newest = safetyDataReducer(pending, { type: "snapshot-ready", epoch: 4, request: 10, snapshot: snapshot(3, "2026-08-25T12:04:00.000Z"), receivedAt });
    const lateOlder = safetyDataReducer(newest, { type: "snapshot-ready", epoch: 4, request: 11, snapshot: snapshot(3, "2026-08-25T12:02:00.000Z"), receivedAt });
    expect(lateOlder).toBe(newest);
    expect(lateOlder.snapshot?.generatedAt).toBe("2026-08-25T12:04:00.000Z");
    expect(safetyDataReducer(lateOlder, { type: "snapshot-failed", epoch: 4, request: 10 })).toBe(lateOlder);
  });
});
