import { describe, expect, it } from "vitest";
import { createEmptyState } from "@/lib/risk-state";
import { applySnapshotStaleness } from "@/lib/snapshot-health";
import { projectCatalog2Snapshot } from "@/lib/risk-snapshot";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { expandedHazardCoverage } from "@/lib/expanded-coverage";
import { locationCoveragePresentation } from "@/lib/coverage-presentation";
import { SnapshotV11Schema, catalogLocationState } from "@/lib/domain/catalog-public";
import { HazardTypeSchema, type NormalizedEvent } from "@/lib/domain/schemas";
import type { IngestionStateV14 } from "@/lib/domain/catalog-state";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";

const now = new Date("2026-09-08T12:00:00Z");
const added = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
const scopes = { usgs: added, emsc: added, "slf-avalanche": ["li-malbun"], "fcdo-travel-advice": added.filter((id) => !id.startsWith("gb-") && !id.startsWith("va-")) };
function state() { const value = createEmptyState(now); value.collection = { catalogVersion: 3, revision: 1 }; return value; }
function receipt(value: IngestionStateV14, source: keyof typeof scopes, checked = scopes[source]) {
  value.expandedSourceHealth[source] = { health: { ...value.sources[source], status: checked.length === scopes[source].length ? "ok" : checked.length ? "partial" : "failed",
    lastAttempt: now.toISOString(), lastSuccess: checked.length ? now.toISOString() : null, sourceUpdatedAt: checked.length ? now.toISOString() : null,
    nextExpectedUpdate: "2026-09-08T12:10:00Z", error: checked.length === scopes[source].length ? null : "private adapter failure detail" },
    checkedLocationIds: [...checked], unavailableLocationIds: scopes[source].filter((id) => !checked.includes(id)) };
}
function advice(ids: string[]): NormalizedEvent {
  return { id: `fcdo:${ids[0].slice(0, 2).toUpperCase()}`, sourceId: "fcdo-travel-advice", providerId: "fcdo-travel-advice", type: "security", level: "ELEVATED", timing: "ACTIVE",
    geometry: { kind: "locations", ids }, headline: "FCDO advises against all travel.", explanation: "Official travel context.", action: "Read official travel advice.", affectedArea: "Country",
    startsAt: now.toISOString(), endsAt: "2026-09-08T14:00:00Z", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), expiresAt: "2026-09-08T14:00:00Z",
    sourceName: "FCDO", sourceUrl: "https://www.gov.uk/foreign-travel-advice/belarus", confidence: "MEDIUM" };
}
function view(snapshot: ReturnType<typeof buildCatalog3Snapshot>, id: string, at = now) {
  return locationCoveragePresentation({ snapshot, state: catalogLocationState(snapshot, id).state, location: catalogLocationsV3.find((location) => location.id === id)!, now: at });
}

describe("reviewed expanded monitoring coverage", () => {
  it("leaves all20 hazard capabilities unmonitored except reviewed earthquakes and Malbun avalanche", () => {
    expect(HazardTypeSchema.options).toHaveLength(20);
    for (const location of catalogLocationsV3.filter(({ id }) => added.includes(id))) {
      const coverage = expandedHazardCoverage(location); expect(Object.keys(coverage).sort()).toEqual([...HazardTypeSchema.options].sort());
      for (const hazard of HazardTypeSchema.options) {
        if (hazard === "earthquake" || (location.id === "li-malbun" && hazard === "avalanche")) expect(coverage[hazard].status).toBe("monitored");
        else expect(coverage[hazard]).toEqual({ status: "not_monitored", providerIds: [] });
      }
    }
  });

  it("shows first active FCDO advice without claiming monitoring freshness from that context", () => {
    const value = state(); const byIds = added.filter((id) => id.startsWith("by-"));
    receipt(value, "fcdo-travel-advice"); value.events = [advice(byIds)];
    const snapshot = buildCatalog3Snapshot(value, now);
    expect(snapshot.locations["by-minsk"].hazards.map(({ providerId }) => providerId)).toEqual(["fcdo-travel-advice"]);
    expect(view(snapshot, "by-minsk").freshness.status).toBe("unavailable");
    expect(snapshot.locations["gb-london"].hazards).toEqual([]);
    expect(snapshot.locations["al-tirana"].hazards).toEqual([]);
  });

  it("keeps monitoring pending with no receipt, unavailable after failure, and recovers on a healthy empty USGS check", () => {
    const value = state();
    const missing = buildCatalog3Snapshot(value, now); expect(missing.locations["gb-london"].level).toBe("UNKNOWN");
    expect(view(missing, "gb-london").freshness.status).toBe("unavailable");
    receipt(value, "usgs", []); const failed = buildCatalog3Snapshot(value, now);
    expect(failed.locations["gb-london"].level).toBe("UNKNOWN"); expect(view(failed, "gb-london").freshness.status).not.toBe("current");
    receipt(value, "usgs"); const recovered = buildCatalog3Snapshot(value, now);
    expect(recovered.locations["gb-london"].level).toBe("NORMAL"); expect(recovered.locations["gb-london"].hazards).toEqual([]);
    expect(view(recovered, "gb-london").freshness.status).toBe("current");
  });

  it.each(["quake only", "avalanche only"] as const)("keeps independent Malbun provider coverage: %s", (mode) => {
    const value = state(); receipt(value, mode === "quake only" ? "usgs" : "slf-avalanche");
    const snapshot = buildCatalog3Snapshot(value, now); const presentation = view(snapshot, "li-malbun");
    const subchecks = presentation.categories.flatMap(({ subchecks }) => subchecks);
    expect(subchecks.find(({ hazard }) => hazard === "earthquake")!.freshnessStatus).toBe(mode === "quake only" ? "current" : "delayed");
    expect(subchecks.find(({ hazard }) => hazard === "avalanche")!.freshnessStatus).toBe(mode === "avalanche only" ? "current" : "delayed");
  });

  it("classifies partial FCDO country coverage independently and never schedules GB or VA", () => {
    const value = state(); const checked = scopes["fcdo-travel-advice"].filter((id) => !id.startsWith("tr-")); receipt(value, "fcdo-travel-advice", checked);
    const snapshot = buildCatalog3Snapshot(value, now); const receiptPublic = snapshot.providers["fcdo-travel-advice"].expandedCoverage!;
    expect(receiptPublic.checkedLocationIds).toEqual([...checked].sort());
    expect(receiptPublic.unavailableLocationIds).toEqual(scopes["fcdo-travel-advice"].filter((id) => id.startsWith("tr-")).sort());
    expect([...receiptPublic.checkedLocationIds, ...receiptPublic.unavailableLocationIds].some((id) => id.startsWith("gb-") || id.startsWith("va-"))).toBe(false);
    expect(JSON.stringify(receiptPublic)).not.toContain("private adapter failure"); expect(receiptPublic).not.toHaveProperty("sourceUpdatedAt");
  });

  it("does not borrow a successful neighboring destination check from the same partial USGS receipt", () => {
    const value = state(); receipt(value, "usgs", scopes.usgs.filter((id) => id !== "gb-london"));
    const snapshot = buildCatalog3Snapshot(value, now);
    expect(snapshot.locations["gb-london"].level).toBe("UNKNOWN");
    expect(view(snapshot, "gb-london").freshness.status).toBe("unavailable");
    const checkedId = scopes.usgs.find((id) => id !== "gb-london" && id !== "li-malbun")!;
    expect(snapshot.locations[checkedId].level).toBe("NORMAL");
    expect(view(snapshot, checkedId).freshness.status).toBe("current");
  });

  it("expires the same public USGS receipt immediately after its twenty-minute cadence window", () => {
    const value = state(); receipt(value, "usgs"); const snapshot = buildCatalog3Snapshot(value, now);
    for (const [offset, expected] of [[20 * 60_000, "current"], [20 * 60_000 + 1, "delayed"]] as const) {
      const presentation = view(snapshot, "gb-london", new Date(now.getTime() + offset));
      expect(presentation.categories.flatMap(({ subchecks }) => subchecks).find(({ hazard }) => hazard === "earthquake")!.freshnessStatus).toBe(expected);
      expect(presentation.freshness.status).toBe(expected);
    }
  });

  it.each([20 * 60_000, 20 * 60_000 + 1, 2 * 3600_000 + 1])("reassesses scoped monitoring without inventing unsupported delayed hazards at age %s", (age) => {
    const value = state(); receipt(value, "usgs"); const snapshot = buildCatalog3Snapshot(value, now); const before = structuredClone(snapshot);
    const aged = applySnapshotStaleness(snapshot, new Date(now.getTime() + age), catalogLocationsV3);
    expect(aged.locations["gb-london"]).toMatchObject({ level: age === 20 * 60_000 ? "NORMAL" : "UNKNOWN", hazards: [], delayedHazards: age === 20 * 60_000 ? [] : ["earthquake"] });
    expect(aged.locations["gb-london"].coverageGaps).toEqual(snapshot.locations["gb-london"].coverageGaps);
    expect(aged.locations["li-malbun"].delayedHazards.slice().sort()).toEqual(age === 20 * 60_000 ? ["avalanche"] : ["avalanche", "earthquake"]);
    expect(snapshot).toEqual(before);
  });

  it("preserves missing-receipt pending states when reassessing an old V11 snapshot", () => {
    const snapshot = buildCatalog3Snapshot(state(), now);
    const aged = applySnapshotStaleness(snapshot, new Date(now.getTime() + 2 * 3600_000 + 1), catalogLocationsV3);
    for (const id of added) {
      expect(aged.locations[id]).toEqual(snapshot.locations[id]);
      expect(catalogLocationState(aged, id).updatePending).toBe(true);
    }
  });

  it("does not grant primary earthquake monitoring from a healthy EMSC fallback alone", () => {
    const value = state(); receipt(value, "emsc"); const snapshot = buildCatalog3Snapshot(value, now);
    expect(snapshot.locations["gb-london"].level).toBe("UNKNOWN");
    expect(snapshot.locations["gb-london"].delayedHazards).toContain("earthquake");
    expect(view(snapshot, "gb-london").freshness.status).not.toBe("current");
  });

  it("ignores unsupported source events, broad geometry, and ineligible FCDO country evidence", () => {
    const value = state(); receipt(value, "usgs");
    value.events = [
      { ...advice(["gb-london"]), id: "eonet:fire", sourceId: "eonet", providerId: "eonet", type: "wildfire" },
      { ...advice(["gb-london"]), id: "usgs:broad", sourceId: "usgs", providerId: "usgs", type: "earthquake", geometry: { kind: "regions", countryCode: "GB", codes: ["GB"] } },
      advice(["gb-london"]), advice(["va-vatican-city"]),
    ];
    const snapshot = buildCatalog3Snapshot(value, now);
    for (const id of added) expect(snapshot.locations[id].hazards).toEqual([]);
    expect(snapshot.locations["gb-london"].level).toBe("NORMAL");
  });

  it("preserves old503 location and provider presentations byte-for-byte and does not mutate private state", () => {
    const value = state(); receipt(value, "usgs"); receipt(value, "slf-avalanche", []); const before = structuredClone(value);
    const old = projectCatalog2Snapshot(value, now); const current = buildCatalog3Snapshot(value, now);
    for (const id of release2.locationIds) {
      expect(current.locations[id]).toEqual(old.locations[id]);
      const location = catalogLocationsV3.find((location) => location.id === id)!;
      expect(view(current, id)).toEqual(locationCoveragePresentation({ snapshot: old, state: old.locations[id], location, now }));
    }
    expect(value).toEqual(before);
  });

  it.each(["missing ID", "duplicate", "legacy ID", "unapproved provider", "private error", "source time", "future check", "ok unavailable"])("rejects malformed public coverage: %s", (mode) => {
    const value = state(); receipt(value, "usgs"); const snapshot = buildCatalog3Snapshot(value, now); const coverage = snapshot.providers.usgs.expandedCoverage!;
    if (mode === "missing ID") coverage.checkedLocationIds.pop();
    if (mode === "duplicate") coverage.checkedLocationIds[0] = coverage.checkedLocationIds[1];
    if (mode === "legacy ID") coverage.checkedLocationIds[0] = "at-vienna";
    if (mode === "unapproved provider") snapshot.providers.eonet.expandedCoverage = coverage;
    if (mode === "private error") Object.assign(coverage, { error: "private" });
    if (mode === "source time") Object.assign(coverage, { sourceUpdatedAt: now.toISOString() });
    if (mode === "future check") coverage.checkedAt = "2026-09-08T12:00:00.001Z";
    if (mode === "ok unavailable") coverage.unavailableLocationIds = [coverage.checkedLocationIds.pop()!];
    expect(() => SnapshotV11Schema.parse(snapshot)).toThrow();
  });
});
