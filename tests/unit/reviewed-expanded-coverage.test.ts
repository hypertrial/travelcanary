import { describe, expect, it } from "vitest";
import { createEmptyState } from "@/lib/risk-state";
import { applySnapshotStaleness } from "@/lib/snapshot-health";
import { projectCatalog2Snapshot } from "@/lib/risk-snapshot";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { expandedHazardCoverage, expandedProviderApplies } from "@/lib/expanded-coverage";
import { nationalWarningManifest } from "@/lib/national-warning-sources";
import { locationCoveragePresentation } from "@/lib/coverage-presentation";
import { SnapshotV11Schema, catalogLocationState } from "@/lib/domain/catalog-public";
import { HazardTypeSchema, type NormalizedEvent } from "@/lib/domain/schemas";
import type { IngestionState } from "@/lib/domain/catalog-state";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
import { requiredLifeSafetyTransportFailures } from "@/lib/public-health";

const now = new Date("2026-09-08T12:00:00Z");
const added = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
const englandFloodIds = new Set(nationalWarningManifest.countries.GB.systems.find(({ id }) => id === "ea-flood")!.coverageLocationIds);
const scopes = { usgs: added, emsc: added, "slf-avalanche": ["li-malbun"], "fcdo-travel-advice": added.filter((id) => !id.startsWith("gb-") && !id.startsWith("va-")) };
function state() { const value = createEmptyState(now); value.collection = { catalogVersion: 3, revision: 1 }; return value; }
function receipt(value: IngestionState, source: keyof typeof scopes, checked = scopes[source]) {
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
  it("classifies all20 hazards while preserving earthquake monitoring and reviewed partial/direct additions", () => {
    expect(HazardTypeSchema.options).toHaveLength(20);
    for (const location of catalogLocationsV3.filter(({ id }) => added.includes(id))) {
      const coverage = expandedHazardCoverage(location); expect(Object.keys(coverage).sort()).toEqual([...HazardTypeSchema.options].sort());
      expect(coverage.earthquake).toEqual({ status: "monitored", providerIds: ["usgs", "emsc"] });
      if (location.id === "li-malbun") expect(coverage.avalanche.status).toBe("monitored");
      if (["AD", "IS", "NO"].includes(location.countryCode)) {
        expect(coverage["severe-weather"].status).not.toBe("not_monitored");
      } else if (["BA", "MD", "ME", "MK", "RS"].includes(location.countryCode)) {
        expect(coverage["severe-weather"].status).toBe("not_monitored");
      }
      if (location.countryCode === "GB") {
        for (const hazard of ["severe-weather", "extreme-heat", "extreme-cold", "snow-ice", "coastal"] as const) {
          expect(coverage[hazard].status).toBe("not_monitored");
        }
        expect(coverage.flood.status).toBe(englandFloodIds.has(location.id) ? "partial" : "not_monitored");
      }
      if (location.countryCode === "NO") {
        expect(coverage["fire-danger"].status).toBe("monitored"); expect(coverage.flood.status).toBe("partial");
      }
      expect(Object.values(coverage).every(({ status }) => ["monitored", "partial", "not_monitored"].includes(status))).toBe(true);
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
    expect(recovered.locations["gb-london"].level).toBe("UNKNOWN"); expect(recovered.locations["gb-london"].hazards).toEqual([]);
    const earthquake = view(recovered, "gb-london").categories.flatMap(({ subchecks }) => subchecks).find(({ hazard }) => hazard === "earthquake")!;
    expect(earthquake).toMatchObject({ coverageStatus: "available", freshnessStatus: "current" });
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
    expect(view(snapshot, checkedId).categories.flatMap(({ subchecks }) => subchecks)
      .find(({ hazard }) => hazard === "earthquake")!.freshnessStatus).toBe("current");
  });

  it("uses Catalog 3 partition receipts for each expanded MeteoAlarm destination and blocks unavailable life-safety scope", () => {
    const value = state(); receipt(value, "usgs");
    const scope = catalogLocationsV3.filter((location) => added.includes(location.id) && expandedProviderApplies("meteoalarm", location)).map(({ id }) => id);
    const unavailableId = scope.find((id) => id.startsWith("is-"))!;
    value.collectionReceipts[3].meteoalarm = { catalogVersion: 3, collectionRevision: 1, checkedAt: now.toISOString(), status: "partial",
      checkedLocationIds: scope.filter((id) => id !== unavailableId), unavailableLocationIds: [unavailableId] };
    const currentId = scope.find((id) => id.startsWith("is-") && id !== unavailableId)!;
    const snapshot = buildCatalog3Snapshot(value, now);
    expect(snapshot.providers.meteoalarm.expandedCoverage).toMatchObject({ status: "partial", unavailableLocationIds: [unavailableId] });
    expect(snapshot.locations[currentId].delayedHazards).not.toContain("severe-weather");
    expect(snapshot.locations[unavailableId]).toMatchObject({ level: "UNKNOWN", delayedHazards: expect.arrayContaining(["severe-weather"]) });
    expect(requiredLifeSafetyTransportFailures(snapshot, catalogLocationsV3, now))
      .toContain("coverage/IS/severe-weather/meteoalarm");
  });

  it("expires the same public USGS receipt immediately after its twenty-minute cadence window", () => {
    const value = state(); receipt(value, "usgs"); const snapshot = buildCatalog3Snapshot(value, now);
    for (const [offset, expected] of [[20 * 60_000, "current"], [20 * 60_000 + 1, "delayed"]] as const) {
      const presentation = view(snapshot, "gb-london", new Date(now.getTime() + offset));
      expect(presentation.categories.flatMap(({ subchecks }) => subchecks).find(({ hazard }) => hazard === "earthquake")!.freshnessStatus).toBe(expected);
      expect(presentation.freshness.status).toBe("delayed");
    }
  });

  it.each([20 * 60_000, 20 * 60_000 + 1, 2 * 3600_000 + 1])("reassesses scoped monitoring without inventing unsupported delayed hazards at age %s", (age) => {
    const value = state(); receipt(value, "usgs"); const snapshot = buildCatalog3Snapshot(value, now); const before = structuredClone(snapshot);
    const aged = applySnapshotStaleness(snapshot, new Date(now.getTime() + age), catalogLocationsV3);
    expect(aged.locations["gb-london"]).toMatchObject({ level: "UNKNOWN", hazards: [] });
    expect(aged.locations["gb-london"].delayedHazards).toEqual(expect.arrayContaining(age === 20 * 60_000 ? ["flood"] : ["earthquake", "flood"]));
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

  it("shows EONET context but ignores broad quake geometry and ineligible FCDO country evidence", () => {
    const value = state(); receipt(value, "usgs");
    value.events = [
      { ...advice(["gb-london"]), id: "eonet:fire", sourceId: "eonet", providerId: "eonet", type: "wildfire" },
      { ...advice(["gb-london"]), id: "usgs:broad", sourceId: "usgs", providerId: "usgs", type: "earthquake", geometry: { kind: "regions", countryCode: "GB", codes: ["GB"] } },
      advice(["gb-london"]), advice(["va-vatican-city"]),
    ];
    const snapshot = buildCatalog3Snapshot(value, now);
    expect(snapshot.locations["gb-london"].hazards.map(({ providerId, type }) => [providerId, type])).toEqual([["eonet", "wildfire"]]);
    expect(snapshot.locations["gb-london"].coverageGaps).toContain("wildfire");
    for (const id of added.filter((id) => id !== "gb-london")) expect(snapshot.locations[id].hazards).toEqual([]);
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
