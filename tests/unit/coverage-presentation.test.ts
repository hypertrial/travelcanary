import type { IngestionStateV14 as IngestionState } from "@/lib/domain/catalog-state";
import { describe, expect, it } from "vitest";
import {
  coverageCategoryDefinitions,
  locationCoveragePresentation,
  validateCoverageCategoryDefinitions,
} from "@/lib/coverage-presentation";
import { locations } from "@/lib/data";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";
import { providerRegistry } from "@/lib/provider-registry";
import { sourceCadenceMinutes, sourceHazards } from "@/lib/risk-policy";
import { countryCodes, type PartitionedSourceResult, type Snapshot, type SourceHealth, type SourceId } from "@/lib/domain/schemas";

const now = new Date("2026-08-25T12:00:00Z");

function healthySource(sourceId: SourceId): SourceHealth {
  const cadence = sourceCadenceMinutes[sourceId] || 10;
  return {
    status: "ok",
    lastAttempt: now.toISOString(),
    lastSuccess: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    nextExpectedUpdate: new Date(now.getTime() + cadence * 60_000).toISOString(),
    itemCount: 0,
    consecutiveFailures: 0,
    error: null,
  };
}

function healthyState(): IngestionState {
  const state = createEmptyState(now);
  for (const sourceId of ["meteoalarm", "usgs", "effis", "cems", "gdacs", "emsc", "eea", "effis-active-fire", "ehyd-flood"] as SourceId[]) {
    state.sources[sourceId] = healthySource(sourceId);
  }
  for (const countryCode of Object.keys(state.sourcePartitions.meteoalarm) as Array<keyof typeof state.sourcePartitions.meteoalarm>) {
    state.sourcePartitions.meteoalarm[countryCode] = healthySource("meteoalarm");
    state.sourcePartitions.eea[countryCode] = healthySource("eea");
    if (state.sourcePartitions.nationalCivilAlerts[countryCode].status !== "not_monitored") {
      state.sourcePartitions.nationalCivilAlerts[countryCode] = healthySource("national-civil-alerts");
    }
  }
  return state;
}

function presentation(snapshot: Snapshot, locationId: string) {
  const location = locations.find(({ id }) => id === locationId)!;
  return locationCoveragePresentation({ location, state: snapshot.locations[location.id], snapshot, now });
}

describe("location coverage presentation", () => {
  it.each(["partial", "delayed"] as const)("keeps permanent coverage counts unchanged during %s weather delivery", (status) => {
    const state = healthyState();
    const healthySnapshot = buildSnapshot(state, now);
    const healthy = presentation(healthySnapshot, "hu-budapest");
    state.sourcePartitions.meteoalarm.HU.status = status;
    const snapshot = buildSnapshot(state, now);
    const result = presentation(snapshot, "hu-budapest");
    expect(snapshot.locations["hu-budapest"].coverageGaps).toEqual(healthySnapshot.locations["hu-budapest"].coverageGaps);
    expect(result.counts).toMatchObject({ available: healthy.counts.available, limited: healthy.counts.limited, not_monitored: healthy.counts.not_monitored });
    expect(result.summaryLabel).toBe(healthy.summaryLabel);
    expect(result.categories.find(({ key }) => key === "weather")).toMatchObject({
      coverageStatus: "available", freshnessStatus: status === "delayed" ? "delayed" : "current",
      providers: expect.arrayContaining([expect.objectContaining({ id: "meteoalarm", status: status === "partial" ? "limited" : "delayed" })]),
    });
  });

  it("groups every public hazard exactly once", () => {
    expect(validateCoverageCategoryDefinitions()).toBe(true);
    expect(new Set(coverageCategoryDefinitions.flatMap(({ hazards }) => hazards)).size).toBe(20);
    expect(sourceHazards.cems).toEqual(providerRegistry["cems-rapid-mapping"].hazards);
    expect(sourceHazards.cems).toContain("flood");
  });

  it("derives Budapest coverage from the matrix and provider health", () => {
    const result = presentation(buildSnapshot(healthyState(), now), "hu-budapest");
    expect(result.counts).toEqual({ available: 3, limited: 3, delayed: 0, not_monitored: 2 });
    expect(result.summaryLabel).toBe("3 fully checked · 3 partly checked · 2 not checked");
    expect(result.freshness).toEqual({
      status: "current",
      visibleLabel: "Current · updated just now",
      accessibleLabel: "Source updates are current. Updated just now.",
    });
    expect(result.delayed).toHaveLength(0);
    expect(result.gaps).toHaveLength(5);
    expect(result.fullyChecked).toHaveLength(3);
    expect(Object.fromEntries(result.categories.map(({ key, status }) => [key, status]))).toEqual({
      weather: "available",
      "flood-coastal": "limited",
      fire: "limited",
      earthquake: "available",
      drought: "not_monitored",
      "air-quality": "available",
      "major-emergencies": "limited",
      "security-conflict": "not_monitored",
    });
    expect(result.categories.some(({ key }) => key === "avalanche")).toBe(false);
    expect(result.categories.find(({ key }) => key === "flood-coastal")?.label).toBe("Flooding");
    expect(result.categories.find(({ key }) => key === "fire")?.providers.find(({ id }) => id === "effis-active-fire")).toBeUndefined();
    expect(result.contextProviders.find(({ id }) => id === "effis-active-fire")).toMatchObject({ name: "EFFIS / NASA FIRMS active fire" });
  });

  it("does not label inland destinations as coastal", () => {
    const landlocked = new Set(["AT", "CZ", "HU", "LU", "SK", "CH"]);
    expect(locations.filter((location) => location.type === "coastal" && !location.isCoastal)).toEqual([]);
    expect(locations.filter((location) => location.type === "coastal" && landlocked.has(location.countryCode))).toEqual([]);
    expect(locations.find((location) => location.id === "lu-luxembourg-moselle")).toMatchObject({
      type: "resort",
      isCoastal: false,
      countryCode: "LU",
    });
  });

  it("shows coastal coverage only for explicitly coastal destinations", () => {
    const snapshot = buildSnapshot(healthyState(), now);
    const coast = presentation(snapshot, "hr-split").categories.find(({ key }) => key === "flood-coastal");
    expect(coast?.label).toBe("Flooding and coastal hazards");
    expect(locations.find(({ id }) => id === "hr-split")?.isCoastal).toBe(true);
  });

  it("delays only the country whose MeteoAlarm partition failed", () => {
    const state = healthyState();
    state.sourcePartitions.meteoalarm.HU = { ...healthySource("meteoalarm"), status: "delayed", consecutiveFailures: 2 };
    const snapshot = buildSnapshot(state, now);
    expect(presentation(snapshot, "hu-budapest").categories.find(({ key }) => key === "weather")?.status).toBe("delayed");
    expect(presentation(snapshot, "at-vienna").categories.find(({ key }) => key === "weather")?.status).toBe("available");
  });

  it("shows Bydgoszcz's late IMGW partition only under flooding while permanent gaps remain gaps", () => {
    const state = healthyState();
    state.sourcePartitions.nationalCivilAlerts.PL = {
      ...healthySource("national-civil-alerts"), status: "delayed", consecutiveFailures: 2, error: "IMGW delayed",
    };
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations["pl-bydgoszcz"]).toMatchObject({
      coverage: "delayed",
      coverageGaps: expect.arrayContaining(["flood", "wildfire", "civil-emergency"]),
      delayedHazards: ["flood"],
    });
    const result = presentation(snapshot, "pl-bydgoszcz");
    expect(result.delayed.map(({ key }) => key)).toEqual(["flood-coastal"]);
    expect(result.delayed[0].subchecks.map(({ hazard }) => hazard)).toEqual(["flood"]);
    expect(result.delayed[0].providers.map(({ id }) => id)).toEqual(["national-civil-alerts"]);
    expect(result.gaps.map(({ key }) => key)).toEqual(expect.arrayContaining(["fire", "major-emergencies"]));
    expect(result.categories.find(({ key }) => key === "fire")).toMatchObject({ freshnessStatus: "current" });
    expect(result.categories.find(({ key }) => key === "major-emergencies")).toMatchObject({ freshnessStatus: "current" });

    snapshot.providers["national-civil-alerts"].partitions!.PL.status = "partial";
    const partialResult = presentation(snapshot, "pl-bydgoszcz");
    expect(partialResult.delayed[0].providers).toEqual([
      expect.objectContaining({ id: "national-civil-alerts", status: "delayed", statusLabel: "Update delayed" }),
    ]);
  });

  it("keeps a checked destination current after a sibling makes its partition delayed", () => {
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

    const budapest = presentation(snapshot, "hu-budapest").categories.find(({ key }) => key === "air-quality");
    const debrecen = presentation(snapshot, "hu-debrecen").categories.find(({ key }) => key === "air-quality");
    expect(budapest).toMatchObject({ status: "available", providers: [expect.objectContaining({ id: "eea-aqi", status: "available" })] });
    expect(debrecen).toMatchObject({ status: "delayed", providers: [expect.objectContaining({ id: "eea-aqi", status: "delayed" })] });
  });

  it("keeps checked destinations current for coverage-scoped aggregate providers", () => {
    let state = healthyState();
    const partial = {
      sourceId: "vigicrues" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [],
      status: "partial" as const, error: "one mapped destination unavailable",
      checkedLocationIds: ["fr-paris"], unavailableLocationIds: ["fr-lyon"],
    };
    state = mergeSourceResults(state, [partial], now);
    state = mergeSourceResults(state, [partial], now);
    const snapshot = buildSnapshot(state, now);

    const flood = (locationId: string) => presentation(snapshot, locationId).categories.find(({ key }) => key === "flood-coastal");
    expect(flood("fr-paris")).toMatchObject({
      status: "limited", providers: expect.arrayContaining([expect.objectContaining({ id: "vigicrues", status: "available" })]),
    });
    expect(flood("fr-lyon")).toMatchObject({
      status: "delayed", providers: expect.arrayContaining([expect.objectContaining({ id: "vigicrues", status: "delayed" })]),
    });
  });

  it("preserves aggregate delivery limitations on older snapshots without changing permanent coverage", () => {
    const snapshot = structuredClone(buildSnapshot(healthyState(), now));
    Reflect.deleteProperty(snapshot.providers.meteoalarm, "partitions");
    snapshot.providers.meteoalarm.status = "partial";
    expect(presentation(snapshot, "hu-budapest").categories.find(({ key }) => key === "weather")).toMatchObject({
      coverageStatus: "available", freshnessStatus: "current",
      providers: expect.arrayContaining([expect.objectContaining({ id: "meteoalarm", status: "limited" })]),
    });
  });

  it("does not let fallback or discovery health override authoritative coverage", () => {
    const state = healthyState();
    state.sources.emsc = { ...state.sources.emsc, status: "delayed", consecutiveFailures: 2 };
    state.sources.gdacs = { ...state.sources.gdacs, status: "delayed", consecutiveFailures: 2 };
    const earthquake = presentation(buildSnapshot(state, now), "hu-budapest").categories.find(({ key }) => key === "earthquake");
    expect(earthquake?.status).toBe("available");
    expect(earthquake?.providers.find(({ id }) => id === "usgs")?.status).toBe("available");
  });

  it("lists national weather fallbacks only for hazards their contract supports", () => {
    const result = presentation(buildSnapshot(healthyState(), now), "fi-finnish-lapland");
    expect(result.categories.find(({ key }) => key === "weather")?.providers.map(({ key }) => key))
      .toContain("meteoalarm:fmi-cap");
    expect(result.categories.find(({ key }) => key === "avalanche")?.providers.map(({ key }) => key))
      .not.toContain("meteoalarm:fmi-cap");
  });

  it("exposes every applicable hazard as a labeled subcheck", () => {
    const snapshot = buildSnapshot(healthyState(), now);
    const city = presentation(snapshot, "hu-budapest");
    expect(city.categories.find(({ key }) => key === "earthquake")?.subchecks).toEqual([
      expect.objectContaining({ hazard: "earthquake", label: "Earthquake activity", status: "available", coverageStatus: "available", freshnessStatus: "current", statusLabel: "Fully checked" }),
    ]);
    expect(city.categories.find(({ key }) => key === "earthquake")?.label).toBe("Earthquakes");
    const volcanic = presentation(snapshot, "it-naples").categories.find(({ key }) => key === "earthquake")?.subchecks;
    expect(volcanic?.map(({ hazard }) => hazard)).toEqual(["earthquake", "volcano"]);
    expect(city.categories.find(({ key }) => key === "fire")?.subchecks.map(({ hazard }) => hazard)).toEqual(["wildfire"]);
    expect(city.categories.find(({ key }) => key === "flood-coastal")?.subchecks.map(({ hazard }) => hazard)).toEqual(["flood"]);
    expect(city.categories.find(({ key }) => key === "major-emergencies")?.subchecks.map(({ hazard }) => hazard)).toEqual([
      "industrial", "nuclear", "civil-emergency",
    ]);

    const mountain = presentation(snapshot, "at-austrian-alps");
    expect(mountain.categories.find(({ key }) => key === "fire")?.subchecks.map(({ hazard }) => hazard)).toEqual(["wildfire", "fire-danger"]);
    const coast = presentation(snapshot, "hr-split");
    expect(coast.categories.find(({ key }) => key === "flood-coastal")?.subchecks.map(({ hazard }) => hazard)).toEqual(["flood", "coastal"]);
  });

  it("keeps volcanic activity applicable when current evidence overrides static geography", () => {
    const state = healthyState();
    state.events.push({
      id: "eonet:volcano:budapest", sourceId: "eonet", providerId: "eonet", type: "volcano", level: "ELEVATED", timing: "ACTIVE",
      headline: "Volcanic activity context near Budapest", explanation: "Current published evidence.", action: "Check official updates.", affectedArea: "Budapest",
      geometry: { kind: "locations", ids: ["hu-budapest"] }, startsAt: "2026-08-25T11:00:00Z", endsAt: "2026-08-25T13:00:00Z",
      sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(), expiresAt: "2026-08-25T13:00:00Z",
      sourceName: "NASA EONET", sourceUrl: "https://eonet.gsfc.nasa.gov/", confidence: "MEDIUM",
    });
    const earthquake = presentation(buildSnapshot(state, now), "hu-budapest").categories.find(({ key }) => key === "earthquake");
    expect(earthquake?.subchecks.map(({ hazard }) => hazard)).toEqual(["earthquake", "volcano"]);
  });

  it("marks normally live categories delayed when the public snapshot is old", () => {
    const snapshot = buildSnapshot(healthyState(), now);
    const result = locationCoveragePresentation({
      location: locations.find(({ id }) => id === "hu-budapest")!,
      state: snapshot.locations["hu-budapest"],
      snapshot,
      now: new Date(now.getTime() + 31 * 60_000),
    });
    expect(result.categories.find(({ key }) => key === "earthquake")?.status).toBe("delayed");
    expect(result.categories.find(({ key }) => key === "weather")?.status).toBe("delayed");
    expect(result.categories.find(({ key }) => key === "security-conflict")?.status).toBe("not_monitored");
    expect(result.delayed.map(({ key }) => key)).toContain("earthquake");
    expect(result.freshness.status).toBe("delayed");
    expect(result.freshness.visibleLabel).toBe("Some updates delayed · last updated 31 min ago");
  });

  it("includes fire danger only for applicable outdoor locations", () => {
    const snapshot = buildSnapshot(healthyState(), now);
    const cityProviders = presentation(snapshot, "hu-budapest").categories.find(({ key }) => key === "fire")?.providers.map(({ id }) => id);
    const mountainProviders = presentation(snapshot, "at-austrian-alps").categories.find(({ key }) => key === "fire")?.providers.map(({ id }) => id);
    expect(cityProviders).not.toContain("effis-fire-danger");
    expect(mountainProviders).toContain("effis-fire-danger");
  });

  it("keeps known alerts separate from coverage and avoids broad safety claims", () => {
    const snapshot = buildSnapshot(healthyState(), now);
    const result = presentation(snapshot, "hu-budapest");
    expect(result.categories).toHaveLength(8);
    expect(result.categories.map(({ description }) => description).join(" ")).not.toMatch(/\bsafe\b|all clear/i);
  });

  it("shows enabled national feeds without disabled-country readiness warnings", () => {
    const snapshot = buildSnapshot(healthyState(), now);
    const sweden = presentation(snapshot, "se-stockholm").categories
      .find(({ key }) => key === "major-emergencies")?.providers
      .find(({ id }) => id === "national-civil-alerts");
    const hungary = presentation(snapshot, "hu-budapest").nationalSystemGap;
    const azores = presentation(snapshot, "pt-ponta-delgada").nationalSystemGap;
    const mainlandPortugal = presentation(snapshot, "pt-lisbon").nationalSystemGap;
    const slovakia = presentation(snapshot, "sk-bratislava").nationalSystemGap;
    const france = presentation(snapshot, "fr-paris").categories
      .find(({ key }) => key === "security-conflict")?.providers
      .find(({ id }) => id === "national-civil-alerts");
    const luxembourg = presentation(snapshot, "lu-luxembourg").categories
      .find(({ key }) => key === "security-conflict")?.providers
      .find(({ id }) => id === "national-civil-alerts");
    expect(sweden?.name).toBe("Krisinformation");
    expect(sweden?.limitation).not.toMatch(/have not been verified/i);
    expect(france).toMatchObject({ name: "FR-Alert", limitation: expect.stringMatching(/vary by country/i) });
    expect(luxembourg).toMatchObject({ name: "LU-Alert", limitation: expect.stringMatching(/vary by country/i) });
    expect(hungary).toMatchObject({ name: "National system not connected", limitation: expect.stringMatching(/Reviewed 2026-08-30/) });
    expect(azores).toMatchObject({ role: "Azores Civil Protection alerts", limitation: expect.stringMatching(/permission for automated republication/i) });
    expect(mainlandPortugal).toMatchObject({ role: "ANEPC operational incidents", limitation: expect.stringMatching(/successor-service reuse/i) });
    expect(slovakia).toMatchObject({ role: "Crisis-management REST service", limitation: expect.stringMatching(/authority-issued key/i) });
  });

  it("labels Catalonia plan status as context without satisfying local-warning coverage", () => {
    const result = presentation(buildSnapshot(healthyState(), now), "es-barcelona");
    const provider = result.contextProviders.find(({ id }) => id === "national-civil-alerts");
    expect(provider).toMatchObject({ name: "Catalonia civil-protection plans", role: "Additional context" });
    expect(provider?.limitation).toMatch(/does not establish complete monitoring/i);
    expect(result.categories.find(({ key }) => key === "major-emergencies")?.status).toBe("limited");
  });

  it("keeps applicable context sources outside coverage counts and subchecks", () => {
    const result = presentation(buildSnapshot(healthyState(), now), "hu-budapest");
    expect(result.contextProviders.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "gfm", "emsc", "effis-active-fire", "gdelt", "eonet", "edo-drought", "fcdo-travel-advice",
    ]));
    expect(result.contextProviders.every(({ role }) => role === "Additional context")).toBe(true);
    expect(result.categories.flatMap(({ providers }) => providers).some(({ id }) => id === "gfm")).toBe(false);
    expect(result.categories.flatMap(({ providers }) => providers).some(({ id }) => id === "emsc")).toBe(false);
    expect(result.counts).toEqual({ available: 3, limited: 3, delayed: 0, not_monitored: 2 });
  });

  it("does not make Catalan destinations unknown when context-only plan status is delayed", () => {
    const state = healthyState();
    state.sourcePartitions.nationalCivilAlerts.ES = {
      ...state.sourcePartitions.nationalCivilAlerts.ES, status: "delayed", consecutiveFailures: 2,
      lastAttempt: now.toISOString(), error: "upstream delayed",
    };
    expect(buildSnapshot(state, now).locations["es-barcelona"].level).toBe("NORMAL");
  });

  it("shows eHYD and AT-Alert on Vienna without claiming complete flood or security coverage", () => {
    const result = presentation(buildSnapshot(healthyState(), now), "at-vienna");
    expect(result.summaryLabel).toBe("3 fully checked · 3 partly checked · 2 not checked");
    expect(result.categories.find(({ key }) => key === "flood-coastal")).toMatchObject({ status: "limited", label: "Flooding" });
    expect(result.categories.find(({ key }) => key === "flood-coastal")?.providers.find(({ id }) => id === "ehyd-flood")).toMatchObject({
      name: "eHYD flood stages", status: "available",
    });
    expect(result.categories.find(({ key }) => key === "major-emergencies")?.providers.find(({ id }) => id === "national-civil-alerts")).toMatchObject({
      name: "AT-Alert", status: "available",
    });
    expect(result.categories.find(({ key }) => key === "security-conflict")?.status).toBe("not_monitored");
  });

  it("does not treat a newly enabled Austrian source as unmonitored before its first live check", () => {
    const snapshot = structuredClone(buildSnapshot(healthyState(), now));
    snapshot.providers["national-civil-alerts"].partitions!.AT = {
      status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "undocumented_machine_feed",
    };
    snapshot.providers["ehyd-flood"] = {
      mode: "authoritative", status: "disabled", lastSuccess: null, sourceUpdatedAt: null,
      nextExpectedUpdate: null, limitationCode: "not_yet_checked",
    };
    const result = presentation(snapshot, "at-vienna");
    expect(result.categories.find(({ key }) => key === "major-emergencies")).toMatchObject({
      status: "delayed", coverageStatus: "limited", freshnessStatus: "delayed",
    });
    expect(result.delayed.map(({ key }) => key)).toContain("major-emergencies");
    expect(result.gaps.map(({ key }) => key)).toContain("major-emergencies");
    expect(result.categories.find(({ key }) => key === "major-emergencies")?.providers.find(({ id }) => id === "national-civil-alerts")).toMatchObject({
      name: "AT-Alert", status: "delayed",
    });
    expect(result.categories.find(({ key }) => key === "flood-coastal")).toMatchObject({
      status: "delayed", coverageStatus: "limited", freshnessStatus: "delayed",
    });
    expect(result.categories.find(({ key }) => key === "flood-coastal")?.providers.find(({ id }) => id === "ehyd-flood")).toMatchObject({
      name: "eHYD flood stages", status: "delayed",
    });
    expect(result.categories.find(({ key }) => key === "security-conflict")?.status).toBe("not_monitored");
    expect(presentation(snapshot, "hu-budapest").nationalSystemGap?.status).toBe("not_monitored");
  });
});
