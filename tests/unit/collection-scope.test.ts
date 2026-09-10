import { describe, expect, it, vi } from "vitest";
import { expandedAdapterLocations, scopeAdapterResult as rawScopeAdapterResult } from "@/lib/ingestion/collection-scope";
import { UsgsAdapter } from "@/lib/ingestion/adapters/usgs";
import { EmscAdapter } from "@/lib/ingestion/adapters/emsc";
import { FcdoTravelAdviceAdapter } from "@/lib/ingestion/adapters/fcdo";
import { SlfAvalancheAdapter } from "@/lib/ingestion/adapters/avalanche";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { locations } from "@/lib/data";
import type { AggregateSourceResult, NormalizedEvent } from "@/lib/domain/schemas";
import { collectAdapterResult } from "@/lib/ingestion/orchestrator";
import { createEmptyState, mergeSourceResults } from "@/lib/risk-state";
import { createSourceDiagnostics } from "@/lib/ingestion/types";
import type { SourceAdapter } from "@/lib/ingestion/types";

function scopeAdapterResult(...args: Parameters<typeof rawScopeAdapterResult>): AggregateSourceResult {
  const scoped = rawScopeAdapterResult(...args);
  if ("partitions" in scoped) throw new Error("Expected an aggregate test result");
  return scoped;
}

const now = "2026-09-08T12:00:00Z";
const adapters = [new UsgsAdapter(), new EmscAdapter(), new FcdoTravelAdviceAdapter(true), new SlfAvalancheAdapter()];
const result = (sourceId: AggregateSourceResult["sourceId"] = "usgs"): AggregateSourceResult => ({ sourceId, status: "ok", checkedAt: now, sourceUpdatedAt: now, events: [], error: null });
function event(ids = ["gb-london"]): NormalizedEvent {
  return { id: "usgs:quake:gb-london", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Reported earthquake.", explanation: "Official preliminary evidence.", action: "Check local advice.", affectedArea: "Reported area",
    geometry: { kind: "locations", ids }, startsAt: now, endsAt: "2026-09-08T14:00:00Z", sourceUpdatedAt: now, checkedAt: now, expiresAt: "2026-09-08T14:00:00Z",
    sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM" };
}

describe("approved adapter collection and replacement scopes", () => {
  it.each([2, 3] as const)("selects exact reviewed destinations for collection%s", (version) => {
    const catalog = version === 2 ? locations : catalogLocationsV3;
    for (const adapter of adapters) {
      const expected = catalog.filter((location) => adapter.id === "slf-avalanche"
        ? (location.countryCode === "CH" && ["mountain", "resort", "park"].includes(location.type)) || location.id === "li-malbun"
        : adapter.id !== "fcdo-travel-advice" || !["GB", "VA"].includes(location.countryCode));
      const actual = expandedAdapterLocations(adapter, version);
      expect(actual).toEqual(expected);
      const scoped = scopeAdapterResult(adapter, version, result(adapter.id));
      expect(scoped.checkedLocationIds?.sort()).toEqual(expected.map(({ id }) => id).sort()); expect(scoped.unavailableLocationIds).toEqual([]);
      if (version === 2) expect(actual.some(({ countryCode }) => ["GB", "VA", "LI"].includes(countryCode))).toBe(false);
    }
  });

  it("returns an unexpanded adapter result unchanged", () => {
    const original = result("gdacs"); const adapter: SourceAdapter = { id: "gdacs", cadence: "slow", async fetch() { return original; } };
    expect(scopeAdapterResult(adapter, 3, original)).toBe(original);
  });

  it.each(["source mismatch", "partitioned", "out of scope event", "nonlocal geometry", "multi-destination quake", "duplicate checked", "overlap", "out of scope checked"])("rejects invalid scoped result: %s", (mode) => {
    const value = result(); value.events = [event()];
    if (mode === "source mismatch") value.sourceId = "emsc";
    if (mode === "partitioned") Object.assign(value, { partitions: {} });
    if (mode === "out of scope event") value.events = [event(["zz-unreviewed"])];
    if (mode === "nonlocal geometry") value.events[0].geometry = { kind: "point", coordinates: [0, 51], radiusKm: 100 };
    if (mode === "multi-destination quake") value.events = [event(["gb-london", "at-vienna"])];
    if (mode === "duplicate checked") value.checkedLocationIds = ["gb-london", "gb-london"];
    if (mode === "overlap") { value.checkedLocationIds = ["gb-london"]; value.unavailableLocationIds = ["gb-london"]; }
    if (mode === "out of scope checked") value.checkedLocationIds = ["zz-unreviewed"];
    expect(() => scopeAdapterResult(new UsgsAdapter(), 3, value)).toThrow();
  });

  it("rejects discovery candidates from approved expanded adapters", () => {
    const value = result(); value.candidates = [{ providerId: "gdacs", externalId: "candidate", hazardType: "earthquake",
      geometry: { type: "Point", coordinates: [0, 51] }, startsAt: now, endsAt: "2026-09-08T14:00:00Z", sourceUpdatedAt: now,
      expiresAt: "2026-09-08T14:00:00Z", officialUrl: "https://www.gdacs.org/" }];
    expect(() => scopeAdapterResult(new UsgsAdapter(), 3, value)).toThrow(/discovery candidates/);
  });

  it("rejects expanded evidence during a collection2 rollback instead of fragmenting it", () => {
    const value = result(); value.events = [event()];
    expect(() => scopeAdapterResult(new UsgsAdapter(), 2, value)).toThrow();
    const old = result(); old.events = [event(["at-vienna"])];
    expect(scopeAdapterResult(new UsgsAdapter(), 2, old).checkedLocationIds).toHaveLength(503);
  });

  it("permits same-country travel context but rejects cross-country fragmentation and excluded destinations", () => {
    const adapter = new FcdoTravelAdviceAdapter(true);
    const value = result("fcdo-travel-advice"); value.events = [{ ...event(["tr-ankara", "tr-istanbul"]), id: "fcdo:TR", sourceId: "fcdo-travel-advice", providerId: "fcdo-travel-advice", type: "security" }];
    expect(scopeAdapterResult(adapter, 3, value).events).toEqual(value.events);
    for (const ids of [["tr-ankara", "al-tirana"], ["gb-london"], ["va-vatican-city"]]) {
      const invalid = structuredClone(value); invalid.events[0].geometry = { kind: "locations", ids };
      expect(() => scopeAdapterResult(adapter, 3, invalid)).toThrow();
    }
  });

  it.each(["failed", "disabled", "partial"] as const)("classifies all unproven destinations unavailable for a %s response", (status) => {
    const value = result(); value.status = status;
    if (status === "disabled") value.limitationCode = "not_enabled";
    const scoped = scopeAdapterResult(new UsgsAdapter(), 3, value);
    expect(scoped.checkedLocationIds).toEqual([]); expect(scoped.unavailableLocationIds?.sort()).toEqual(catalogLocationsV3.map(({ id }) => id).sort());
    expect(value.checkedLocationIds).toBeUndefined(); expect(value.unavailableLocationIds).toBeUndefined();
  });

  it("retains explicit partial checks and conservatively marks the entire remaining scope unavailable", () => {
    const value = result(); value.status = "partial"; value.checkedLocationIds = ["gb-london", "at-vienna"];
    value.unavailableLocationIds = ["li-malbun"];
    const before = structuredClone(value); const scoped = scopeAdapterResult(new UsgsAdapter(), 3, value);
    expect(scoped.checkedLocationIds).toEqual(["at-vienna", "gb-london"]);
    expect(scoped.unavailableLocationIds).toHaveLength(677); expect(scoped.unavailableLocationIds).toContain("li-malbun");
    expect(value).toEqual(before);
  });

  it("does not turn explicit unavailable locations into checked credit on an ok response", () => {
    const value = result(); value.unavailableLocationIds = ["gb-london"];
    // Contradictory aggregate scope must fail closed before replacement can erase retained evidence.
    expect(() => scopeAdapterResult(new UsgsAdapter(), 3, value)).toThrow();
  });

  it("does not accept claimed checked destinations on a failed response", () => {
    const value = result(); value.status = "failed"; value.checkedLocationIds = ["gb-london"];
    expect(() => scopeAdapterResult(new UsgsAdapter(), 3, value)).toThrow();
  });
});


describe("collector scope dispatch", () => {
  const at = new Date(now);
  const context = () => ({ now: at, fetch: vi.fn<typeof fetch>(), deadlineAt: Date.now() + 30000, diagnostics: createSourceDiagnostics() });
  it.each([2, 3] as const)("dispatches marked quake adapter against the exact collection%s catalog", async (version) => {
    const state = createEmptyState(at); state.collection.catalogVersion = version;
    const adapter = new UsgsAdapter();
    const fetch = vi.spyOn(adapter, "fetch").mockResolvedValue(result());
    const collected = await collectAdapterResult(adapter, state, context());
    expect(fetch.mock.calls[0][0].locations.map(({ id }) => id).sort()).toEqual((version === 3 ? catalogLocationsV3 : locations).map(({ id }) => id).sort());
    expect("partitions" in collected).toBe(false);
    if ("partitions" in collected) throw new Error("Expected aggregate result");
    expect(collected.checkedLocationIds).toHaveLength(version === 3 ? 679 : 503);
  });

  it("keeps unapproved adapters on503 legacy destinations even with collection3 state", async () => {
    const state = createEmptyState(at); state.collection.catalogVersion = 3;
    const fetch = vi.fn<SourceAdapter["fetch"]>().mockResolvedValue(result("gdacs"));
    const adapter: SourceAdapter = { id: "gdacs", cadence: "slow", fetch };
    await collectAdapterResult(adapter, state, context());
    expect(fetch.mock.calls[0][0].locations).toEqual(locations);
  });

  it.each(["exception", "invalid source", "out-of-scope event"])("normalizes %s into a full unavailable receipt", async (mode) => {
    const state = createEmptyState(at); state.collection.catalogVersion = 3;
    const adapter = new UsgsAdapter(); const fetch = vi.spyOn(adapter, "fetch");
    if (mode === "exception") fetch.mockRejectedValue(new Error("network unavailable"));
    else { const value = result(mode === "invalid source" ? "emsc" : "usgs"); if (mode === "out-of-scope event") value.events = [event(["zz-unreviewed"])]; fetch.mockResolvedValue(value); }
    const collected = await collectAdapterResult(adapter, state, context());
    if ("partitions" in collected) throw new Error("Expected aggregate result");
    expect(collected.status).toBe("failed"); expect(collected.events).toEqual([]); expect(collected.checkedLocationIds).toEqual([]);
    expect(collected.unavailableLocationIds).toHaveLength(679);
  });

  it.each(["new cohort", "legacy cohort"] as const)("isolates a failure of the %s from the other cohort's health and evidence", (failed) => {
    const base = createEmptyState(at); base.collection.catalogVersion = 3;
    const seed = result(); seed.events = [event(["gb-london"]), { ...event(["at-vienna"]), id: "usgs:quake:at-vienna" }];
    const healthy = mergeSourceResults(base, [scopeAdapterResult(new UsgsAdapter(), 3, seed)], at);
    const legacyIds = new Set(locations.map(({ id }) => id));
    const checked = catalogLocationsV3.filter(({ id }) => failed === "new cohort" ? legacyIds.has(id) : !legacyIds.has(id)).map(({ id }) => id);
    const later = new Date(at.getTime() + 60000);
    const partial = { ...result(), status: "partial" as const, checkedAt: later.toISOString(), checkedLocationIds: checked, error: "One cohort unavailable" };
    const merged = mergeSourceResults(healthy, [scopeAdapterResult(new UsgsAdapter(), 3, partial)], later);
    expect(merged.sources.usgs.status).toBe(failed === "new cohort" ? "ok" : "failed");
    expect(merged.providers.usgs.status).toBe(merged.sources.usgs.status);
    expect(merged.expandedSourceHealth.usgs!.health.status).toBe(failed === "new cohort" ? "failed" : "ok");
    const retainedId = failed === "new cohort" ? "usgs:quake:gb-london" : "usgs:quake:at-vienna";
    expect(merged.events).toEqual([healthy.events.find(({ id }) => id === retainedId)]);
    if (failed === "new cohort") expect(merged.expandedSourceHealth.usgs!.health.lastSuccess).toBe(now);
    else expect(merged.expandedSourceHealth.usgs!.health.lastSuccess).toBe(later.toISOString());
  });

  it.each(["disabled", "partial cancellation"] as const)("preserves retained expanded evidence when legacy collection receives %s", (mode) => {
    const base = createEmptyState(at);
    const expandedEvent = { ...event(["gb-london"]), id: "usgs:q:gb-london" };
    const legacyEvent = { ...event(["at-vienna"]), id: "usgs:q:at-vienna" };
    base.events = [expandedEvent, legacyEvent];
    const input: AggregateSourceResult = mode === "disabled"
      ? { ...result(), status: "disabled", limitationCode: "not_enabled" }
      : { ...result(), status: "partial", checkedLocationIds: [], removedEventPrefixes: ["usgs:q:"], error: "Partial feed cancellation" };
    const scoped = scopeAdapterResult(new UsgsAdapter(), 2, input);
    const merged = mergeSourceResults(base, [scoped], at);
    expect(merged.events).toEqual([expandedEvent]);
    expect(base.events).toEqual([expandedEvent, legacyEvent]);
    const replayAt = new Date(at.getTime() + 60000);
    const replay = scopeAdapterResult(new UsgsAdapter(), 2, { ...input, checkedAt: replayAt.toISOString() });
    expect(mergeSourceResults(merged, [replay], replayAt).events).toEqual([expandedEvent]);
  });

  it("allows pure catalog3 merge while a later legacy-only scoped refresh preserves new evidence and receipts", () => {
    const base = createEmptyState(at); base.collection.catalogVersion = 3;
    const initial = result(); initial.events = [event(["gb-london"]), { ...event(["at-vienna"]), id: "usgs:quake:at-vienna" }];
    const expanded = mergeSourceResults(base, [scopeAdapterResult(new UsgsAdapter(), 3, initial)], at);
    expect(expanded.events.map(({ id }) => id).sort()).toEqual(initial.events.map(({ id }) => id).sort());
    expect(expanded.expandedSourceHealth.usgs!.checkedLocationIds).toHaveLength(176);
    const receipt = structuredClone(expanded.expandedSourceHealth.usgs); const retained = structuredClone(expanded.events.find(({ id }) => id.endsWith("gb-london")));
    expanded.collection = { catalogVersion: 2, revision: 1 };
    const later = new Date(at.getTime() + 60000); const refresh = { ...result(), checkedAt: later.toISOString() };
    const rolledBack = mergeSourceResults(expanded, [scopeAdapterResult(new UsgsAdapter(), 2, refresh)], later);
    expect(rolledBack.events).toEqual([retained]); expect(rolledBack.expandedSourceHealth.usgs).toEqual(receipt);
  });
});
