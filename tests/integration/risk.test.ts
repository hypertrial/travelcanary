import { describe, expect, it } from "vitest";
import { locations } from "@/lib/data";
import { buildSnapshot, createEmptyState, indexEventsByLocation, mergeSourceResults } from "@/lib/risk";
import { eventAffectsLocation } from "@/lib/geospatial";
import { countryCodes, type CountryCode, type NormalizedEvent, type PartitionedSourceResult, type SourceId } from "@/lib/domain/schemas";
import { MAX_RETAINED_EVENTS } from "@/lib/ingestion/limits";

const now = new Date("2026-08-25T12:00:00Z");
function healthyState() {
  const state = createEmptyState(now);
  const health = { status: "ok" as const, lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(), nextExpectedUpdate: now.toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };
  for (const id of ["meteoalarm", "usgs", "effis", "cems", "eea", "effis-active-fire"] as SourceId[]) state.sources[id] = structuredClone(health);
  for (const countryCode of Object.keys(state.sourcePartitions.meteoalarm)) state.sourcePartitions.meteoalarm[countryCode as keyof typeof state.sourcePartitions.meteoalarm] = structuredClone(health);
  for (const countryCode of Object.keys(state.sourcePartitions.eea)) state.sourcePartitions.eea[countryCode as keyof typeof state.sourcePartitions.eea] = structuredClone(health);
  return state;
}
function warning(): NormalizedEvent {
  const location = locations[0];
  return { id: "warning", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "HIGH", timing: "ACTIVE", headline: "Earthquake shaking is affecting the area.", explanation: "An official report covers this destination.", action: "Follow local advice.", affectedArea: location.name, geometry: { kind: "point", coordinates: location.centroid, radiusKm: 1 }, startsAt: "2026-08-25T11:00:00Z", endsAt: "2026-08-25T15:00:00Z", sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(), expiresAt: "2026-08-25T15:00:00Z", sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "HIGH" };
}

function countryWarning(countryCode: CountryCode): NormalizedEvent {
  const location = locations.find((candidate) => candidate.countryCode === countryCode)!;
  return {
    ...warning(), id: `warning-${countryCode}`, sourceId: "meteoalarm", providerId: "meteoalarm", type: "severe-weather",
    sourceName: "MeteoAlarm", sourceUrl: "https://meteoalarm.org/", affectedArea: location.country,
    geometry: { kind: "regions", countryCode, codes: [`${countryCode}:country`] },
  };
}

function partitioned(failed: CountryCode[] = [], events: NormalizedEvent[] = []): PartitionedSourceResult {
  return {
    sourceId: "meteoalarm", checkedAt: now.toISOString(),
    partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
      status: failed.includes(countryCode) ? "failed" : "ok",
      sourceUpdatedAt: failed.includes(countryCode) ? null : now.toISOString(),
      events: events.filter((event) => event.geometry.kind === "regions" && event.geometry.countryCode === countryCode),
      error: failed.includes(countryCode) ? "timeout" : null,
    }])) as PartitionedSourceResult["partitions"],
  };
}

describe("risk publication", () => {
  it.each(["FI", "IE"] as const)("keeps repeated successful %s fallback recovery partial without hiding primary failures", (countryCode) => {
    for (const limitationCode of ["national_authority_fallback", "ifrc_fallback"] as const) {
      let state = healthyState();
      const transportId = limitationCode === "ifrc_fallback" ? "ifrc-meteoalarm" : countryCode === "FI" ? "fmi-cap" : "met-eireann-json";
      for (let attempt = 0; attempt < 3; attempt++) {
        const at = new Date(now.getTime() + attempt * 10 * 60_000);
        const result = partitioned();
        result.checkedAt = at.toISOString();
        result.partitions[countryCode] = {
          status: "partial", events: [], sourceUpdatedAt: at.toISOString(), limitationCode,
          error: "Primary failed; fallback succeeded",
          transports: {
            "meteoalarm-primary": { status: "failed", events: [], sourceUpdatedAt: null, error: "timeout" },
            [transportId]: { status: "ok", events: [], sourceUpdatedAt: at.toISOString(), error: null },
          },
        };
        state = mergeSourceResults(state, [result], at);
        expect(state.sourcePartitions.meteoalarm[countryCode]).toMatchObject({ status: "partial", consecutiveFailures: 0, lastSuccess: at.toISOString() });
        expect(buildSnapshot(state, at).locations[countryCode === "FI" ? "fi-helsinki" : "ie-dublin"].delayedHazards).not.toContain("severe-weather");
      }
      expect(state.partitionTransports.meteoalarm[countryCode]["meteoalarm-primary"]).toMatchObject({ status: "delayed", consecutiveFailures: 3 });
      expect(state.partitionTransports.meteoalarm[countryCode][transportId].status).toBe("ok");
    }
  });

  it("still escalates incomplete country parsing rather than treating it as fallback recovery", () => {
    const result = partitioned();
    result.partitions.FI = { status: "partial", events: [], sourceUpdatedAt: now.toISOString(), error: "Malformed warning" };
    const state = mergeSourceResults(mergeSourceResults(healthyState(), [result], now), [result], now);
    expect(state.sourcePartitions.meteoalarm.FI).toMatchObject({ status: "delayed", consecutiveFailures: 2 });
  });

  it.each([undefined, "meteoalarm-primary", "ifrc-meteoalarm"])("applies explicit CAP supersession across delivery paths (previous %s)", (transportId) => {
    const state = healthyState();
    state.events = [
      { ...countryWarning("FI"), id: "meteoalarm:cancelled:wind", transportId },
      { ...countryWarning("FI"), id: "meteoalarm:unrelated:wind", transportId },
      { ...countryWarning("IE"), id: "meteoalarm:cancelled:rain", transportId },
    ];
    const delivery = transportId === "ifrc-meteoalarm" ? "meteoalarm-primary" : "ifrc-meteoalarm";
    const result = partitioned(["FI", "IE"]);
    result.partitions.FI.status = "partial";
    result.partitions.FI.transports = { [delivery]: {
      status: "partial", events: [], sourceUpdatedAt: now.toISOString(), error: "unrelated malformed entry",
      removedEventPrefixes: ["meteoalarm:cancelled:"],
    } };
    expect(mergeSourceResults(state, [result], now).events.map(({ id }) => id).sort()).toEqual([
      "meteoalarm:cancelled:rain", "meteoalarm:unrelated:wind",
    ]);
  });
  it("replaces only healthy transport events and retains failed or not-due delivery", () => {
    const state = healthyState();
    state.events = ["meteoalarm-primary", "fmi-cap", "ifrc-meteoalarm"].map((transportId) => ({ ...countryWarning("FI"), id: transportId, transportId }));
    const result = partitioned(["FI"]);
    result.partitions.FI.status = "partial";
    result.partitions.FI.transports = {
      "meteoalarm-primary": { status: "ok", events: [], sourceUpdatedAt: now.toISOString(), error: null },
      "fmi-cap": { status: "failed", events: [], sourceUpdatedAt: null, error: "timeout" },
      "ifrc-meteoalarm": { status: "not_due", events: [], sourceUpdatedAt: null, error: null },
    };
    expect(mergeSourceResults(state, [result], now).events.map(({ id }) => id).sort()).toEqual(["fmi-cap", "ifrc-meteoalarm"]);
  });
  it("keeps broad fallback replacement prefixes local to their transport", () => {
    const state = healthyState();
    state.events = [{ ...countryWarning("FI"), id: "meteoalarm:fmi:legacy:wind", transportId: "meteoalarm-primary" }];
    const result = partitioned(["FI"]);
    result.partitions.FI.status = "partial";
    result.partitions.FI.transports = { "fmi-cap": {
      status: "ok", events: [], sourceUpdatedAt: now.toISOString(), error: null, removedEventPrefixes: ["meteoalarm:fmi:"],
    } };
    expect(mergeSourceResults(state, [result], now).events).toEqual(state.events);
  });
  it("does not reinsert a superseded warning from another delivery in the same result", () => {
    const state = healthyState(); const result = partitioned(["FI"]);
    result.partitions.FI.status = "partial";
    result.partitions.FI.transports = {
      "meteoalarm-primary": { status: "partial", events: [], sourceUpdatedAt: now.toISOString(), error: "malformed entry", removedEventPrefixes: ["meteoalarm:old:"] },
      "ifrc-meteoalarm": { status: "ok", events: [{ ...countryWarning("FI"), id: "meteoalarm:old:wind" }], sourceUpdatedAt: now.toISOString(), error: null },
    };
    expect(mergeSourceResults(state, [result], now).events).toEqual([]);
  });
  it("ignores an older transport result even if its country summary is older still", () => {
    const state = healthyState(); const transportId = "fmi-cap";
    state.events = [{ ...countryWarning("FI"), transportId }];
    state.partitionTransports.meteoalarm.FI[transportId] = {
      ...state.sourcePartitions.meteoalarm.FI, lastAttempt: "2026-08-25T12:10:00Z", checkedLocationIds: [], unavailableLocationIds: [],
    };
    const result = partitioned();
    result.partitions.FI.transports = { [transportId]: { status: "ok", events: [], sourceUpdatedAt: now.toISOString(), error: null } };
    const merged = mergeSourceResults(state, [result], now);
    expect(merged.events).toEqual(state.events);
    expect(merged.partitionTransports.meteoalarm.FI[transportId].lastAttempt).toBe("2026-08-25T12:10:00Z");
  });
  it("reports an unused retired fallback as ready when its primary has recovered", () => {
    const state = healthyState();
    state.partitionTransports.meteoalarm.FI["fmi-cap"] = {
      ...state.sourcePartitions.meteoalarm.FI, status: "not_monitored", checkedLocationIds: [], unavailableLocationIds: [],
    };
    expect(buildSnapshot(state, now).providers.meteoalarm.partitions?.FI.transports?.find(({ id }) => id === "fmi-cap")?.status).toBe("ok");
  });
  it("fails closed before retained events can exceed the private-state limit", () => {
    const state = createEmptyState(now);
    state.events = Array.from({ length: MAX_RETAINED_EVENTS }, (_, index) => ({ ...warning(), id: `retained-${index}` }));
    expect(() => mergeSourceResults(state, [{
      sourceId: "vigicrues", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      events: [{ ...warning(), id: "overflow", sourceId: "vigicrues", providerId: "vigicrues" }],
      status: "partial", error: "fixture partial",
    }], now)).toThrow(/event hard limit/);
  });

  it("publishes the highest known risk while retaining partial coverage", () => {
    const state = healthyState();
    state.events = [warning()];
    const locationState = buildSnapshot(state, now).locations[locations[0].id];
    expect(locationState.level).toBe("HIGH");
    expect(locationState.coverage).toBe("partial");
  });

  it("does not erase valid events on a failed source request", () => {
    const state = healthyState(); state.events = [warning()];
    const merged = mergeSourceResults(state, [{ sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" }], now);
    expect(merged.events).toHaveLength(1);
    expect(merged.sources.usgs.consecutiveFailures).toBe(1);
  });

  it("does not create a global delay when discovery, fallback, or complementary satellite fire data fails", () => {
    let state = healthyState();
    state = mergeSourceResults(state, [
      { sourceId: "gdacs", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" },
      { sourceId: "emsc", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" },
      { sourceId: "effis-active-fire", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" },
    ], now);
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.dataHealth).toBe("complete");
    expect(snapshot.providers.gdacs.status).toBe("failed");
    expect(snapshot.providers.emsc.status).toBe("failed");
    expect(snapshot.providers["effis-active-fire"].status).toBe("failed");
    state = mergeSourceResults(state, [
      { sourceId: "gdacs", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" },
      { sourceId: "emsc", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" },
      { sourceId: "effis-active-fire", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout" },
    ], now);
    const delayedProviders = buildSnapshot(state, now);
    expect(delayedProviders.dataHealth).toBe("complete");
    expect(delayedProviders.providers.gdacs.status).toBe("delayed");
    expect(delayedProviders.providers.emsc.status).toBe("delayed");
    expect(delayedProviders.providers["effis-active-fire"].status).toBe("delayed");
    expect(delayedProviders.locations["hu-budapest"].level).toBe("NORMAL");
  });

  it("scopes two authoritative provider failures to matrix entries containing that provider", () => {
    let state = healthyState();
    const failed = { sourceId: "vigicrues" as const, checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed" as const, error: "timeout" };
    state = mergeSourceResults(state, [failed], now);
    state = mergeSourceResults(state, [failed], now);
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.dataHealth).toBe("complete");
    expect(snapshot.locations["fr-paris"]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
    expect(snapshot.locations["fr-reims"].level).toBe("NORMAL");
    expect(snapshot.locations["fr-reims"].coverage).not.toBe("delayed");
    expect(snapshot.locations["hu-budapest"].level).toBe("NORMAL");
  });

  it("scopes an eHYD failure to mapped Austrian flood coverage", () => {
    let state = healthyState();
    const failed = { sourceId: "ehyd-flood" as const, checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed" as const, error: "timeout" };
    state = mergeSourceResults(state, [failed], now);
    state = mergeSourceResults(state, [failed], now);
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.dataHealth).toBe("complete");
    expect(snapshot.locations["at-vienna"]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
    expect(snapshot.locations["hu-budapest"].level).toBe("NORMAL");
    expect(snapshot.locations["hu-budapest"].coverage).not.toBe("delayed");
  });

  it("keeps checked destinations current across repeated mixed-validity refreshes", () => {
    let state = healthyState();
    const partial = {
      sourceId: "vigicrues" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [],
      status: "partial" as const, error: "one mapped destination unavailable",
      checkedLocationIds: ["fr-paris"], unavailableLocationIds: ["fr-lyon"],
    };
    state = mergeSourceResults(state, [partial], now);
    state = mergeSourceResults(state, [partial], now);
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations["fr-paris"].level).toBe("NORMAL");
    expect(snapshot.locations["fr-paris"].coverage).not.toBe("delayed");
    expect(snapshot.locations["fr-lyon"]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
  });

  it("ages repeated partial country refreshes and delays only unavailable destinations", () => {
    let state = healthyState();
    const partial: PartitionedSourceResult = {
      sourceId: "eea", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, countryCode === "HU" ? {
        status: "partial", sourceUpdatedAt: now.toISOString(), events: [], error: "one sample unavailable",
        checkedLocationIds: ["hu-budapest"], unavailableLocationIds: ["hu-debrecen"],
      } : { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null }])) as unknown as PartitionedSourceResult["partitions"],
    };
    state = mergeSourceResults(state, [partial], now);
    state = mergeSourceResults(state, [partial], now);
    const snapshot = buildSnapshot(state, now);
    expect(state.sourcePartitions.eea.HU).toMatchObject({ status: "delayed", consecutiveFailures: 2 });
    expect(snapshot.locations["hu-budapest"].level).toBe("NORMAL");
    expect(snapshot.locations["hu-budapest"].coverage).not.toBe("delayed");
    expect(snapshot.locations["hu-debrecen"]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
  });

  it("keeps an unavailable EEA country from delaying other countries", () => {
    let state = healthyState();
    const failed: PartitionedSourceResult = {
      sourceId: "eea", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
        status: countryCode === "HU" ? "failed" as const : "ok" as const,
        sourceUpdatedAt: countryCode === "HU" ? null : now.toISOString(), events: [],
        error: countryCode === "HU" ? "timeout" : null,
      }])) as unknown as PartitionedSourceResult["partitions"],
    };
    state = mergeSourceResults(state, [failed], now);
    state = mergeSourceResults(state, [failed], now);
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations["hu-budapest"]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
    expect(snapshot.locations["at-vienna"].level).toBe("NORMAL");
    expect(snapshot.locations["at-vienna"].coverage).not.toBe("delayed");
  });

  it("retains unavailable partition evidence even when another alert targets the same destination", () => {
    const locationId = "se-stockholm";
    const oldEvent: NormalizedEvent = {
      ...warning(), id: "old-vma", sourceId: "national-civil-alerts", providerId: "national-civil-alerts",
      type: "civil-emergency", geometry: { kind: "locations", ids: [locationId] }, sourceName: "Krisinformation",
    };
    const newEvent = { ...oldEvent, id: "new-vma", sourceUpdatedAt: "2026-08-25T12:01:00Z" };
    const state = healthyState();
    state.events = [oldEvent];
    const result: PartitionedSourceResult = {
      sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, countryCode === "SE" ? {
        status: "partial", sourceUpdatedAt: newEvent.sourceUpdatedAt, events: [newEvent], error: "one VMA was malformed",
        checkedLocationIds: [], unavailableLocationIds: [locationId],
      } : { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "no_approved_machine_feed" }])) as unknown as PartitionedSourceResult["partitions"],
    };
    const merged = mergeSourceResults(state, [result], now);
    expect(merged.events.filter(({ sourceId }) => sourceId === "national-civil-alerts").map(({ id }) => id)).toEqual(["old-vma", "new-vma"]);
    result.partitions.SE.checkedLocationIds = [locationId];
    result.partitions.SE.unavailableLocationIds = [];
    expect(mergeSourceResults(state, [result], now).events.map(({ id }) => id)).toEqual(["new-vma"]);
  });

  it("persists each national transport's own cadence for freshness checks", () => {
    const result: PartitionedSourceResult = {
      sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, countryCode === "IT" ? {
        status: "partial", sourceUpdatedAt: now.toISOString(), events: [], error: "partial national flood coverage",
        checkedLocationIds: [], unavailableLocationIds: ["it-rome"],
        transports: { "dpc-flood-bulletin": { status: "partial", sourceUpdatedAt: now.toISOString(), error: "partial national flood coverage", checkedLocationIds: [], unavailableLocationIds: ["it-rome"] } },
      } : { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "no_active_transport" }])) as unknown as PartitionedSourceResult["partitions"],
    };
    const merged = mergeSourceResults(createEmptyState(now), [result], now);
    expect(merged.partitionTransports.nationalCivilAlerts.IT["dpc-flood-bulletin"].nextExpectedUpdate)
      .toBe("2026-08-25T13:00:00.000Z");
  });

  it("merges partial aggregate results without erasing prior evidence", () => {
    const state = healthyState();
    const previous = { ...warning(), id: "previous-cems", sourceId: "cems" as const, providerId: "cems-rapid-mapping" as const, sourceName: "Copernicus EMS" };
    const current = {
      ...previous, id: "current-cems", sourceUpdatedAt: "2026-08-25T12:01:00Z",
      startsAt: "2026-08-25T11:01:00Z", endsAt: "2026-08-25T15:01:00Z", expiresAt: "2026-08-25T15:01:00Z",
    };
    state.events = [previous];
    const merged = mergeSourceResults(state, [{
      sourceId: "cems", checkedAt: now.toISOString(), sourceUpdatedAt: current.sourceUpdatedAt,
      events: [current], status: "partial", error: "1 of 2 activation details unavailable",
    }], now);
    expect(merged.events.map((event) => event.id).sort()).toEqual(["current-cems", "previous-cems"]);
    expect(merged.sources.cems).toMatchObject({ status: "partial", consecutiveFailures: 1 });
  });

  it("applies explicit aggregate tombstones during a partial refresh", () => {
    const state = healthyState();
    const closed = { ...warning(), id: "cems:EMSR001", sourceId: "cems" as const, providerId: "cems-rapid-mapping" as const, sourceName: "Copernicus EMS" };
    const retained = { ...closed, id: "cems:EMSR002" };
    const similarCode = { ...closed, id: "cems:EMSR0010" };
    state.events = [closed, retained, similarCode];

    const merged = mergeSourceResults(state, [{
      sourceId: "cems", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      events: [], removedEventPrefixes: ["cems:EMSR001"], status: "partial", error: "one activation detail unavailable",
    }], now);

    expect(merged.events.map(({ id }) => id)).toEqual(["cems:EMSR002", "cems:EMSR0010"]);
  });

  it("marks complementary CEMS delayed after two incomplete refreshes without delaying the snapshot", () => {
    let state = healthyState();
    const partial = {
      sourceId: "cems" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      events: [], status: "partial" as const, error: "1 of 2 activation details unavailable",
    };
    state = mergeSourceResults(state, [partial], now);
    expect(state.sources.cems).toMatchObject({ status: "partial", consecutiveFailures: 1 });
    expect(buildSnapshot(state, now)).toMatchObject({
      dataHealth: "complete",
      providers: { "cems-rapid-mapping": { status: "partial" } },
      locations: { "hu-budapest": { level: "NORMAL", delayedHazards: [] } },
    });
    state = mergeSourceResults(state, [partial], now);
    const snapshot = buildSnapshot(state, now);
    expect(state.sources.cems).toMatchObject({ status: "delayed", consecutiveFailures: 2 });
    expect(snapshot.providers["cems-rapid-mapping"].status).toBe("delayed");
    expect(snapshot.locations["hu-budapest"].level).toBe("NORMAL");
    expect(snapshot.locations["hu-budapest"].delayedHazards).toEqual([]);
    expect(snapshot.dataHealth).toBe("complete");
  });

  it("still publishes retained CEMS evidence after complementary delays", () => {
    let state = healthyState();
    const event = {
      ...warning(), id: "cems:EMSR001", sourceId: "cems" as const, providerId: "cems-rapid-mapping" as const,
      type: "wildfire" as const, sourceName: "Copernicus EMS",
    };
    state.events = [event];
    const partial = {
      sourceId: "cems" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      events: [], status: "partial" as const, error: "1 of 2 activation details unavailable",
    };
    state = mergeSourceResults(state, [partial], now);
    state = mergeSourceResults(state, [partial], now);
    const snapshot = buildSnapshot(state, now);
    const locationId = locations[0].id;
    expect(state.sources.cems).toMatchObject({ status: "delayed", consecutiveFailures: 2 });
    expect(snapshot.dataHealth).toBe("complete");
    expect(snapshot.locations[locationId].level).toBe("HIGH");
    expect(snapshot.locations[locationId].hazards.map(({ type }) => type)).toContain("wildfire");
    expect(snapshot.locations["hu-budapest"].level).toBe("NORMAL");
  });

  it("still delays the snapshot when USGS fails alongside complementary CEMS", () => {
    let state = healthyState();
    const cemsPartial = {
      sourceId: "cems" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      events: [], status: "partial" as const, error: "1 of 2 activation details unavailable",
    };
    const usgsFailed = { sourceId: "usgs" as const, checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed" as const, error: "timeout" };
    state = mergeSourceResults(state, [cemsPartial, usgsFailed], now);
    state = mergeSourceResults(state, [cemsPartial, usgsFailed], now);
    const snapshot = buildSnapshot(state, now);
    const unaffected = locations.find((location) => location.id !== locations[0].id)!;
    expect(state.sources.cems).toMatchObject({ status: "delayed", consecutiveFailures: 2 });
    expect(snapshot.providers["cems-rapid-mapping"].status).toBe("delayed");
    expect(snapshot.dataHealth).toBe("delayed");
    expect(snapshot.locations[unaffected.id].level).toBe("UNKNOWN");
    expect(snapshot.locations[unaffected.id].delayedHazards).toContain("earthquake");
    expect(snapshot.locations["hu-budapest"].delayedHazards).toEqual(["earthquake"]);
  });

  it("still delays official flood coverage when complementary CEMS is also delayed", () => {
    let state = healthyState();
    const cemsPartial = {
      sourceId: "cems" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      events: [], status: "partial" as const, error: "1 of 2 activation details unavailable",
    };
    const vigicruesFailed = { sourceId: "vigicrues" as const, checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed" as const, error: "timeout" };
    state = mergeSourceResults(state, [cemsPartial, vigicruesFailed], now);
    state = mergeSourceResults(state, [cemsPartial, vigicruesFailed], now);
    const snapshot = buildSnapshot(state, now);
    expect(state.sources.cems).toMatchObject({ status: "delayed", consecutiveFailures: 2 });
    expect(snapshot.dataHealth).toBe("complete");
    expect(snapshot.locations["fr-paris"]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
    expect(snapshot.locations["fr-paris"].delayedHazards).toContain("flood");
    expect(snapshot.locations["hu-budapest"].level).toBe("NORMAL");
    expect(snapshot.locations["hu-budapest"].delayedHazards).toEqual([]);
  });

  it("does not publish normal before EEA air quality has succeeded", () => {
    const state = healthyState();
    state.sources.eea = {
      status: "failed", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      itemCount: 0, consecutiveFailures: 0, error: "Not yet checked",
    };
    for (const countryCode of countryCodes) state.sourcePartitions.eea[countryCode] = structuredClone(state.sources.eea);
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.providers["eea-aqi"].status).toBe("delayed");
    expect(snapshot.locations["hu-budapest"].level).toBe("UNKNOWN");
  });

  it("marks otherwise-normal locations unknown after two failures", () => {
    let state = healthyState();
    const failed = { sourceId: "usgs" as const, checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed" as const, error: "timeout" };
    state = mergeSourceResults(state, [failed], now);
    state = mergeSourceResults(state, [failed], now);
    const unaffected = locations.find((location) => location.id !== locations[0].id)!;
    expect(buildSnapshot(state, now).locations[unaffected.id].level).toBe("UNKNOWN");
  });

  it("limits delayed fire-danger coverage to outdoor destinations", () => {
    let state = healthyState();
    const failed = { sourceId: "effis" as const, checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed" as const, error: "timeout" };
    state = mergeSourceResults(state, [failed], now);
    state = mergeSourceResults(state, [failed], now);
    const city = locations.find((location) => location.type === "city")!;
    const outdoor = locations.find((location) => ["resort", "island", "park", "mountain", "coastal"].includes(location.type))!;
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations[city.id].level).toBe("NORMAL");
    expect(snapshot.locations[city.id].coverage).not.toBe("delayed");
    expect(snapshot.locations[outdoor.id].level).toBe("UNKNOWN");
  });

  it("limits stale fire-danger delays to outdoor destinations", () => {
    const state = healthyState();
    const old = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    for (const source of Object.values(state.sources)) {
      if (source.status === "not_monitored") continue;
      source.lastAttempt = old;
      source.lastSuccess = old;
      source.sourceUpdatedAt = old;
      source.nextExpectedUpdate = old;
    }
    for (const countryCode of countryCodes) {
      state.sourcePartitions.meteoalarm[countryCode] = { ...state.sourcePartitions.meteoalarm[countryCode], lastSuccess: old, lastAttempt: old, sourceUpdatedAt: old, nextExpectedUpdate: old };
      state.sourcePartitions.eea[countryCode] = { ...state.sourcePartitions.eea[countryCode], lastSuccess: old, lastAttempt: old, sourceUpdatedAt: old, nextExpectedUpdate: old };
    }
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.dataHealth).toBe("stale");
    expect(snapshot.locations["hu-budapest"].delayedHazards.includes("fire-danger")).toBe(false);
    expect(snapshot.locations["at-austrian-alps"].delayedHazards.includes("fire-danger")).toBe(true);
    expect(snapshot.locations["lu-luxembourg-moselle"].delayedHazards.includes("fire-danger")).toBe(true);
  });

  it("does not publish normal before an applicable source has succeeded", () => {
    const state = healthyState();
    state.sources.effis = {
      status: "failed", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      itemCount: 0, consecutiveFailures: 0, error: "Not yet checked",
    };
    const outdoor = locations.find((location) => ["resort", "island", "park", "mountain", "coastal"].includes(location.type))!;
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.providers["effis-fire-danger"].status).toBe("delayed");
    expect(snapshot.locations[outdoor.id].level).toBe("UNKNOWN");
  });

  it("ages an overdue source independently of fresher sources", () => {
    const state = healthyState();
    const old = new Date(now.getTime() - 3 * 60 * 60_000);
    state.sources.effis = {
      status: "ok", lastAttempt: old.toISOString(), lastSuccess: old.toISOString(), sourceUpdatedAt: old.toISOString(),
      nextExpectedUpdate: new Date(old.getTime() + 60 * 60_000).toISOString(), itemCount: 0, consecutiveFailures: 0, error: null,
    };
    const outdoor = locations.find((location) => ["resort", "island", "park", "mountain", "coastal"].includes(location.type))!;
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.providers["effis-fire-danger"].status).toBe("delayed");
    expect(snapshot.locations[outdoor.id].level).toBe("UNKNOWN");
  });

  it("keeps an overdue source delayed when its retry fails", () => {
    const state = healthyState();
    const old = new Date(now.getTime() - 3 * 60 * 60_000);
    state.sources.effis = {
      status: "ok", lastAttempt: old.toISOString(), lastSuccess: old.toISOString(), sourceUpdatedAt: old.toISOString(),
      nextExpectedUpdate: new Date(old.getTime() + 60 * 60_000).toISOString(), itemCount: 0, consecutiveFailures: 0, error: null,
    };
    const merged = mergeSourceResults(state, [{
      sourceId: "effis", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "failed", error: "timeout",
    }], now);
    const outdoor = locations.find((location) => ["resort", "island", "park", "mountain", "coastal"].includes(location.type))!;

    expect(merged.sources.effis.nextExpectedUpdate).toBe(new Date(old.getTime() + 60 * 60_000).toISOString());
    expect(buildSnapshot(merged, now).locations[outdoor.id].level).toBe("UNKNOWN");
  });

  it("ignores an aggregate result older than the committed source attempt", () => {
    const state = healthyState();
    const committedAt = "2026-08-25T12:10:00.000Z";
    const committed = { ...warning(), id: "newer", sourceUpdatedAt: committedAt, checkedAt: committedAt };
    state.events = [committed];
    state.sources.usgs = { ...state.sources.usgs, lastAttempt: committedAt, lastSuccess: committedAt, sourceUpdatedAt: committedAt };

    const merged = mergeSourceResults(state, [{
      sourceId: "usgs", checkedAt: "2026-08-25T12:05:00.000Z", sourceUpdatedAt: "2026-08-25T12:05:00.000Z",
      events: [], status: "ok", error: null,
    }], new Date("2026-08-25T12:15:00.000Z"));

    expect(merged.events.map(({ id }) => id)).toEqual(["newer"]);
    expect(merged.sources.usgs.lastAttempt).toBe(committedAt);
  });

  it("ignores partition refreshes older than their committed attempts", () => {
    const state = healthyState();
    const committedAt = "2026-08-25T12:10:00.000Z";
    state.events = [countryWarning("AT")];
    state.sourcePartitions.meteoalarm.AT = {
      ...state.sourcePartitions.meteoalarm.AT, lastAttempt: committedAt, lastSuccess: committedAt, sourceUpdatedAt: committedAt,
    };
    const stale = partitioned();
    stale.checkedAt = "2026-08-25T11:59:00.000Z";

    const merged = mergeSourceResults(state, [stale], new Date("2026-08-25T12:15:00.000Z"));

    expect(merged.events.map(({ id }) => id)).toEqual(["warning-AT"]);
    expect(merged.sourcePartitions.meteoalarm.AT.lastAttempt).toBe(committedAt);
  });

  it("preserves destination coverage from partitions newer than a mixed refresh", () => {
    const state = healthyState();
    const committedAt = "2026-08-25T12:10:00.000Z";
    state.sourcePartitions.meteoalarm.AT = {
      ...state.sourcePartitions.meteoalarm.AT, lastAttempt: committedAt, lastSuccess: committedAt, sourceUpdatedAt: committedAt,
    };
    state.providerCoverage.meteoalarm = {
      checkedAt: committedAt, checkedLocationIds: [], unavailableLocationIds: ["at-vienna"],
    };
    for (const countryCode of countryCodes) {
      if (countryCode !== "AT") state.sourcePartitions.meteoalarm[countryCode].lastAttempt = "2026-08-25T11:50:00.000Z";
    }
    const mixed = partitioned();
    mixed.partitions.DE.checkedLocationIds = ["de-berlin"];

    const merged = mergeSourceResults(state, [mixed], new Date("2026-08-25T12:15:00.000Z"));

    expect(merged.providerCoverage.meteoalarm).toEqual({
      checkedAt: committedAt, checkedLocationIds: ["de-berlin"], unavailableLocationIds: ["at-vienna"],
    });
  });

  it("removes a source event when a successful refresh no longer contains it", () => {
    const state = healthyState(); state.events = [warning()];
    const merged = mergeSourceResults(state, [{ sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null }], now);
    expect(merged.events).toHaveLength(0);
  });

  it("retains distinct source event identifiers even when their fallback fingerprints match", () => {
    const state = healthyState();
    const first = warning();
    const second = { ...first, id: "separate-warning", level: "ELEVATED" as const, sourceUpdatedAt: "2026-08-25T12:01:00Z" };
    const merged = mergeSourceResults(state, [{ sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: second.sourceUpdatedAt, events: [first, second], status: "ok", error: null }], now);
    expect(merged.events.map(({ id }) => id).sort()).toEqual(["separate-warning", "warning"]);
    expect(buildSnapshot(merged, now).locations[locations[0].id].level).toBe("HIGH");
  });

  it("applies MeteoAlarm cancellation prefixes during a partial country refresh", () => {
    const state = healthyState();
    state.events = [{ ...countryWarning("HU"), id: "meteoalarm:alert-1:region" }];
    const result = partitioned();
    result.partitions.HU = {
      status: "partial", sourceUpdatedAt: now.toISOString(), events: [], error: "one record invalid",
      removedEventPrefixes: ["meteoalarm:alert-1:"],
    };

    expect(mergeSourceResults(state, [result], now).events).toEqual([]);
  });

  it("prefers a matching USGS event over EMSC fallback evidence", () => {
    const state = healthyState();
    const locationId = locations[0].id;
    const usgs = {
      ...warning(),
      geometry: { kind: "locations" as const, ids: [locationId] },
      earthquake: { ids: ["usgs-event"], coordinates: locations[0].centroid, magnitude: 5 },
    };
    const emsc = {
      ...usgs, id: "emsc-fallback", sourceId: "emsc" as const, providerId: "emsc" as const,
      earthquake: { ids: ["emsc-event"], coordinates: locations[0].centroid, magnitude: 5 },
      level: "ELEVATED" as const, sourceName: "EMSC", sourceUrl: "https://www.emsc-csem.org/",
    };
    state.events = [emsc, usgs];
    const merged = mergeSourceResults(state, [], now);
    expect(merged.events.map((event) => event.sourceId)).toEqual(["usgs"]);
    const hazard = buildSnapshot(merged, now).locations[locationId].hazards[0];
    expect(hazard.providerId).toBe("usgs");
    expect(hazard).not.toHaveProperty("earthquake");
  });

  it("retains distinct earthquakes reported within 90 seconds", () => {
    const state = healthyState();
    const location = locations[0];
    const usgs = {
      ...warning(),
      geometry: { kind: "locations" as const, ids: [location.id] },
      earthquake: { ids: ["usgs-event"], coordinates: location.centroid, magnitude: 5 },
    };
    const emsc = {
      ...usgs,
      id: "emsc-distinct",
      sourceId: "emsc" as const,
      providerId: "emsc" as const,
      startsAt: "2026-08-25T11:01:00Z",
      earthquake: { ids: ["emsc-event"], coordinates: [location.centroid[0] + 1, location.centroid[1]] as [number, number], magnitude: 5 },
      level: "ELEVATED" as const,
      sourceName: "EMSC",
      sourceUrl: "https://www.emsc-csem.org/",
    };
    state.events = [usgs, emsc];

    expect(mergeSourceResults(state, [], now).events.map((event) => event.sourceId).sort()).toEqual(["emsc", "usgs"]);
  });

  it("retains a failed country's warning and delays only that country", () => {
    let state = healthyState();
    state.events = [countryWarning("AT")];
    state = mergeSourceResults(state, [partitioned(["AT"])], now);
    state = mergeSourceResults(state, [partitioned(["AT"])], now);
    const snapshot = buildSnapshot(state, now);
    const austrian = locations.find((location) => location.countryCode === "AT")!;
    const german = locations.find((location) => location.countryCode === "DE")!;
    expect(snapshot.locations[austrian.id]).toMatchObject({ level: "HIGH", coverage: "delayed" });
    expect(snapshot.locations[german.id].level).toBe("NORMAL");
    expect(snapshot.locations[german.id].coverage).not.toBe("delayed");
  });

  it("limits first-run weather unavailability to the failed country", () => {
    const state = createEmptyState(now);
    const health = { status: "ok" as const, lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(), nextExpectedUpdate: now.toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };
    for (const id of ["usgs", "effis", "cems", "eea"] as const) state.sources[id] = structuredClone(health);
    for (const countryCode of countryCodes) state.sourcePartitions.eea[countryCode] = structuredClone(health);
    const merged = mergeSourceResults(state, [partitioned(["AT"])], now);
    const snapshot = buildSnapshot(merged, now);
    const austrian = locations.find((location) => location.countryCode === "AT")!;
    const german = locations.find((location) => location.countryCode === "DE")!;
    expect(snapshot.locations[austrian.id]).toMatchObject({ level: "UNKNOWN", coverage: "delayed" });
    expect(snapshot.locations[german.id].level).toBe("NORMAL");
    expect(snapshot.locations[german.id].coverage).not.toBe("delayed");
  });

  it("replaces only successful country events and recovers partition health", () => {
    let state = healthyState();
    state.events = [countryWarning("AT"), countryWarning("DE")];
    state = mergeSourceResults(state, [partitioned(["AT"])], now);
    expect(state.events.some((event) => event.id === "warning-AT")).toBe(true);
    expect(state.events.some((event) => event.id === "warning-DE")).toBe(false);
    state = mergeSourceResults(state, [partitioned()], now);
    expect(state.events.some((event) => event.sourceId === "meteoalarm")).toBe(false);
    expect(state.sourcePartitions.meteoalarm.AT).toMatchObject({ status: "ok", consecutiveFailures: 0 });
  });

  it("indexes every geometry with the same matches as the naïve reference", () => {
    const first = locations[0];
    const events: NormalizedEvent[] = [
      { ...warning(), id: "by-id", geometry: { kind: "locations", ids: [first.id] } },
      countryWarning(first.countryCode),
      { ...warning(), id: "by-point", geometry: { kind: "point", coordinates: first.centroid, radiusKm: 1 } },
      { ...warning(), id: "by-polygon", geometry: { kind: "polygon", coordinates: [[[first.centroid[0] - .01, first.centroid[1] - .01], [first.centroid[0] + .01, first.centroid[1] - .01], [first.centroid[0] + .01, first.centroid[1] + .01], [first.centroid[0] - .01, first.centroid[1] + .01], [first.centroid[0] - .01, first.centroid[1] - .01]]] } },
    ];
    const indexed = indexEventsByLocation(events, now);
    for (const location of locations) {
      const expected = events.filter((event) => eventAffectsLocation(event, location)).map((event) => event.id);
      expect((indexed.get(location.id) || []).map((event) => event.id)).toEqual(expected);
    }
  });
});
