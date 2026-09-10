import { describe, expect, it } from "vitest";
import demoSnapshot from "../../public/demo-snapshot.json";
import publicLocations from "../../public/locations.json";
import { nationalWarningSources } from "@/lib/national-warning-sources";
import { SnapshotSchema, type CountryCode } from "@/lib/domain/schemas";
import { verifyProduction } from "../../scripts/verify-production";
import { buildConditionsFiles } from "@/lib/conditions/state";
import { createEmptyState } from "@/lib/risk";
import { type Conditions } from "@/lib/domain/conditions";
import { conditionAttribution } from "@/lib/conditions/sources";
import { locations } from "@/lib/data";
import { marineEligibleLocationIds } from "@/lib/conditions/marine";
import { opwHydroMappings } from "@/lib/conditions/opw";

const origin = "https://travelcanary.test";
const snapshotUrl = "https://unit.public.blob.vercel-storage.com/latest.json";
const now = new Date("2026-08-30T10:00:00.000Z");
const releaseSha = "a".repeat(40);
const infrastructureSources = ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"] as const;

function conditionsFiles(state = createEmptyState(now), env: Record<string, string | undefined> = {}) {
  for (const id of infrastructureSources) state.conditions.health[id] = { checkedAt: now.toISOString(), status: "ok", matched: 0, code: null };
  return buildConditionsFiles(state, now, { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", ...env });
}

function healthySnapshot() {
  const snapshot = SnapshotSchema.parse(structuredClone(demoSnapshot));
  snapshot.generatedAt = now.toISOString();
  snapshot.dataHealth = "complete" as typeof snapshot.dataHealth;
  for (const state of Object.values(snapshot.providers)) {
    if (state.status !== "disabled") state.status = "ok";
  }
  const nationalPartitions = snapshot.providers["national-civil-alerts"].partitions;
  for (const [countryCode, source] of Object.entries(nationalWarningSources)) {
    if (source.enabled && nationalPartitions) nationalPartitions[countryCode as CountryCode].status = "ok";
  }
  for (const [id, state] of Object.entries(snapshot.locations)) {
    if (state.level === "UNKNOWN") snapshot.locations[id] = {
      level: "NORMAL", coverage: state.coverage, coverageGaps: state.coverageGaps, delayedHazards: [], hazards: [],
    };
  }
  return snapshot;
}

function fetchFixture(html: string, snapshot: unknown, conditions: Conditions[] = []): typeof fetch {
  const bodies = new Map([
    [origin + "/", html],
    [origin + "/locations.json", JSON.stringify(publicLocations)],
    [snapshotUrl, JSON.stringify(snapshot)],
  ]);
  for (const file of conditions) bodies.set(new URL(`conditions/v2/${file.countryCode}.json`, snapshotUrl).href, JSON.stringify(file));
  return (async (input: RequestInfo | URL) => {
    const body = bodies.get(String(input));
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200, headers: { "Content-Length": String(Buffer.byteLength(body)) } });
  }) as typeof fetch;
}

function pageMetadata(mode = "live", sha = releaseSha) {
  return '<meta name="travelcanary-data-mode" content="' + mode + '"><meta name="travelcanary-snapshot" content="' + snapshotUrl
    + '"><meta name="travelcanary-release" content="' + sha + '">';
}

function addExpiredInfrastructure(conditions: Conditions[], generatedMinutesAgo: number, expiredMinutesAgo: number) {
  const file = conditions.find(({ countryCode }) => countryCode === "FI")!;
  file.generatedAt = new Date(now.getTime() - generatedMinutesAgo * 60_000).toISOString();
  file.locations["fi-helsinki"].infrastructureIncidents.push({
    id: "digitraffic:expired", sourceId: "digitraffic", sourceUpdatedAt: new Date(now.getTime() - 3 * 3600000).toISOString(),
    checkedAt: new Date(now.getTime() - 3 * 3600000).toISOString(), expiresAt: new Date(now.getTime() - expiredMinutesAgo * 60_000).toISOString(),
    kind: "road-closure", status: "active", scope: "destination", scopeLabel: "Near Helsinki",
    startsAt: new Date(now.getTime() - 4 * 3600000).toISOString(), endsAt: null, estimatedRestorationAt: null,
    sourceUrl: "https://liikennetilanne.fintraffic.fi/",
  });
}

describe("production verification", () => {
  it("reports a duplicate catalog ID without measuring mismatched coverage or interrupting conditions verification", async () => {
    const catalog = structuredClone(publicLocations);
    catalog[catalog.length - 1] = structuredClone(catalog[0]);
    expect(catalog).toHaveLength(503);
    const baseFetch = fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditionsFiles());
    const fetchWithDuplicate: typeof fetch = async (input, init) => String(input) === origin + "/locations.json"
      ? Response.json(catalog) : baseFetch(input, init);
    const report = await verifyProduction({ origin, now, fetch: fetchWithDuplicate });
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "catalog_invalid" }));
    expect(report.metrics.coverageMeasurement).toBeUndefined();
    expect(report.metrics.conditions).toMatchObject({ countries: 28, locations: 503 });
  });
  it("preserves a nested legacy snapshot prefix when fetching all28 compatibility condition files", async () => {
    const nested = snapshotUrl.replace("/latest.json", "/compat/latest.json");
    const html = (pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">').replace(snapshotUrl, nested);
    const base = fetchFixture(html, healthySnapshot(), conditionsFiles()); const requested: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const value = String(input); requested.push(value);
      return base(value === nested ? snapshotUrl : value.replace("/compat/conditions/v2/", "/conditions/v2/"), init);
    };
    const report = await verifyProduction({ origin, now, fetch });
    expect(report.metrics.conditions).toMatchObject({ countries: 28, locations: 503 });
    expect(requested.filter((url) => url.includes("/conditions/v2/"))).toHaveLength(28);
    expect(requested.filter((url) => url.includes("/conditions/v2/")).every((url) => url.includes("/compat/conditions/v2/"))).toBe(true);
  });

  it("counts mapped observation destinations once and distinguishes fresh, expired, and absent readings", async () => {
    const conditions = conditionsFiles();
    const ireland = conditions.find(({ countryCode }) => countryCode === "IE")!;
    ireland.sources["opw-hydro"] = conditionAttribution("opw-hydro");
    const [fresh, expired] = opwHydroMappings;
    const reading = (mapping: typeof fresh, expiresAt: string) => ({
      sourceId: "opw-hydro" as const, sourceUpdatedAt: new Date(now.getTime() - 3600000).toISOString(), checkedAt: new Date(now.getTime() - 60000).toISOString(),
      observedAt: new Date(now.getTime() - 3600000).toISOString(), expiresAt, stationId: mapping.stationId, stationName: mapping.stationName,
      sourceUrl: mapping.stationUrl, measurements: [{ metric: "water-level" as const, value: 0.4, unit: "m" as const }],
    });
    ireland.locations[fresh.locationId].rivers.push(
      reading(fresh, now.toISOString()), reading(fresh, new Date(now.getTime() + 1).toISOString()),
    );
    ireland.locations[expired.locationId].rivers.push(reading(expired, now.toISOString()));
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toEqual([]);
    expect(report.metrics.observationAvailability?.["opw-hydro"]).toEqual({ eligible: 6, fresh: 1, expired: 1, absent: 4, unknown: 0 });
    expect(report.metrics.conditions?.bySource["opw-hydro"].available).toBe(1);
    expect(report.warnings).toContainEqual({ code: "conditions_observation_gaps",
      message: "opw-hydro: 1/6 mapped destinations have fresh observations; 1 expired, 4 absent, 0 unknown (publication unavailable). Absence is not a healthy-empty incident feed." });
  });
  it.each(["missing", "invalid"])("reports unknown observations for an %s country publication without misclassifying absence", async (kind) => {
    const conditions = conditionsFiles();
    const ireland = conditions.find(({ countryCode }) => countryCode === "IE")!;
    if (kind === "missing") conditions.splice(conditions.indexOf(ireland), 1);
    else Reflect.deleteProperty(ireland.locations, opwHydroMappings[0].locationId);
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "conditions_publication_invalid", message: expect.stringContaining("IE:") }));
    expect(report.metrics.observationAvailability?.["opw-hydro"]).toEqual({ eligible: 6, fresh: 0, expired: 0, absent: 0, unknown: 6 });
    for (const availability of Object.values(report.metrics.observationAvailability!)) {
      expect(availability.fresh + availability.expired + availability.absent + availability.unknown).toBe(availability.eligible);
    }
  });
  it("does not credit successful observation transports with healthy-empty coverage when no readings are published", async () => {
    const conditions = conditionsFiles();
    for (const [country, source] of [["IE", "opw-hydro"], ["PT", "ipma-observations"]] as const) {
      const file = conditions.find(({ countryCode }) => countryCode === country)!;
      file.sources[source] = conditionAttribution(source);
      file.sourceHealth[source] = {
        status: "ok", checkedAt: now.toISOString(), limitationCode: null,
      };
    }
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toEqual([]);
    for (const source of ["opw-hydro", "ipma-observations"]) {
      expect(report.metrics.conditions?.bySource[source]).toMatchObject({ available: 0, health: { ok: 1, healthyEmpty: 0 } });
      const availability = report.metrics.observationAvailability![source];
      expect(availability).toMatchObject({ fresh: 0, expired: 0, absent: availability.eligible, unknown: 0 });
    }
    expect(report.metrics.conditions?.bySource.digitraffic.health.healthyEmpty).toBe(1);
  });
  it("does not reinterpret expired incident records as a healthy-empty feed", async () => {
    const conditions = conditionsFiles();
    addExpiredInfrastructure(conditions, 30, 10);
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toEqual([]);
    expect(report.metrics.conditions?.bySource.digitraffic).toMatchObject({ available: 0,
      health: { ok: 1, partial: 0, failed: 0, healthyEmpty: 0 } });
    expect(report.metrics.conditions?.pendingExpiryCleanup).toBe(1);
  });
  it("checks all 28 conditions countries and reports unavailable data separately from eligibility", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    const report = await verifyProduction({ origin, now, expectedSha: releaseSha, expectLocalConditions: true,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toEqual([]);
    expect(report.metrics.conditions).toMatchObject({ countries: 28, locations: 503, availableDestinations: 0, releaseMatches: 28, releaseMismatches: 0,
      byProduct: { weather: { eligible: 503, available: 0, missing: 503 }, airQuality: { eligible: 503, available: 0, missing: 503 }, marine: { eligible: 131, available: 0, missing: 131 } },
      bySource: { "open-meteo-weather": { eligible: 503, available: 0 }, "awc-metar": { eligible: 341, available: 0 }, "rws-water": { eligible: 7, available: 0 },
        "arso-hydro": { eligible: 7, available: 0 }, digitraffic: { available: 0, health: { ok: 1, partial: 0, failed: 0, healthyEmpty: 1 } } } });
    expect(report.warnings.filter(({ code }) => code === "conditions_availability")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^0\/503 destinations.+\(\+20 more\)$/) }),
    ]);
    expect(report.warnings.filter(({ code }) => code.endsWith("_incomplete"))).toHaveLength(3);
  });
  it("reports records-present, healthy-empty, partial, and failed source health separately", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    const germany = conditions.find(({ countryCode }) => countryCode === "DE")!;
    germany.sourceHealth["autobahn-traffic"] = { status: "partial", checkedAt: now.toISOString(), limitationCode: "partial_transport_failure" };
    const sweden = conditions.find(({ countryCode }) => countryCode === "SE")!;
    sweden.sourceHealth["krisinformation-infrastructure"] = { status: "failed", checkedAt: now.toISOString(), limitationCode: "source_unavailable" };
    const finland = conditions.find(({ countryCode }) => countryCode === "FI")!;
    finland.locations["fi-helsinki"].infrastructureIncidents.push({
      id: "digitraffic:current", sourceId: "digitraffic", sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(), kind: "road-closure", status: "active", scope: "destination",
      scopeLabel: "Near Helsinki", startsAt: now.toISOString(), endsAt: null, estimatedRestorationAt: null,
      sourceUrl: "https://liikennetilanne.fintraffic.fi/",
    });
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.metrics.conditions?.bySource.digitraffic).toMatchObject({ available: 1,
      health: { ok: 1, partial: 0, failed: 0, healthyEmpty: 0 } });
    expect(report.metrics.conditions?.bySource["autobahn-traffic"].health).toEqual({ ok: 0, partial: 1, failed: 0, healthyEmpty: 0 });
    expect(report.metrics.conditions?.bySource["krisinformation-infrastructure"].health).toEqual({ ok: 0, partial: 0, failed: 1, healthyEmpty: 0 });
    expect(report.warnings).toContainEqual({ code: "conditions_source_health",
      message: "2 country/source updates are incomplete: DE/autobahn-traffic:partial, SE/krisinformation-infrastructure:failed" });
    expect(report.warnings.some(({ code }) => code === "conditions_source_health_persistent")).toBe(false);
  });
  it("names source health that remains incomplete beyond the cadence grace", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    conditions.find(({ countryCode }) => countryCode === "DE")!.sourceHealth["autobahn-traffic"] = {
      status: "partial", checkedAt: new Date(now.getTime() - 76 * 60_000).toISOString(), limitationCode: "partial_transport_failure",
    };
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.warnings).toContainEqual({ code: "conditions_source_health_persistent",
      message: "1 country/source updates remain incomplete beyond the cadence grace: DE/autobahn-traffic:partial" });
  });
  it("reports deterministic per-product completeness and bounded missing destinations", async () => {
    const state = createEmptyState(now);
    state.conditions.health["open-meteo-marine"] = { checkedAt: now.toISOString(), status: "failed", matched: 110, code: "batch_failed" };
    const missingAir = new Set(["lu-dudelange", "lu-esch-sur-alzette", "lu-luxembourg", "lu-luxembourg-moselle", "lu-mullerthal"]);
    const expiredAir = "lu-dudelange";
    const missingMarine = new Set([...marineEligibleLocationIds].sort().slice(0, 21));
    const base = { sourceUpdatedAt: null, checkedAt: now.toISOString(), startAt: now.toISOString(), stepMinutes: 60 as const };
    for (const location of locations) state.conditions.locations[location.id] = {
      observations: [], rivers: [], earthquakes: [], infrastructureIncidents: [], systemConditions: [], limitations: [],
      weather: { ...base, sourceId: "open-meteo-weather", expiresAt: new Date(now.getTime() + 6 * 3600000).toISOString(),
        temperature: [10], precipitationProbability: [0], precipitation: [0], wind: [1], gusts: [2], weatherCode: [0] },
      ...(!missingAir.has(location.id) || location.id === expiredAir ? { airQuality: { ...base, sourceId: "open-meteo-air" as const,
        expiresAt: new Date(now.getTime() + 12 * 3600000).toISOString(),
        aqi: [10], pm25: [1], pm10: [2], dust: [0], uv: [1] } } : {}),
      ...(marineEligibleLocationIds.has(location.id) && !missingMarine.has(location.id) ? { marine: { ...base, sourceId: "open-meteo-marine" as const, expiresAt: new Date(now.getTime() + 12 * 3600000).toISOString(),
        waveHeight: [1], wavePeriod: [5], seaTemperature: [15] } } : {}),
    };
    const conditions = conditionsFiles(state, { VERCEL_GIT_COMMIT_SHA: releaseSha });
    const expiredEntry = conditions.find(({ countryCode }) => countryCode === "LU")!.locations[expiredAir].airQuality!;
    expiredEntry.checkedAt = new Date(now.getTime() - 12 * 3600000).toISOString();
    expiredEntry.startAt = new Date(now.getTime() - 12 * 3600000).toISOString();
    expiredEntry.expiresAt = new Date(now.getTime() - 1).toISOString();
    expect(conditions.flatMap(({ locations }) => Object.values(locations)).filter(({ weather }) => weather)).toHaveLength(503);
    for (const file of conditions) file.sources = { ...file.sources, "open-meteo-weather": conditionAttribution("open-meteo-weather"),
      "open-meteo-air": conditionAttribution("open-meteo-air"), "open-meteo-marine": conditionAttribution("open-meteo-marine") };
    const report = await verifyProduction({ origin, now, expectedSha: releaseSha,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.metrics.conditions?.byProduct).toEqual({ weather: { eligible: 503, available: 503, missing: 0 },
      airQuality: { eligible: 503, available: 498, missing: 5 }, marine: { eligible: 131, available: 110, missing: 21 } });
    expect(report.warnings.filter(({ code }) => code.startsWith("conditions_") && code.endsWith("_incomplete"))).toEqual([
      { code: "conditions_air_quality_incomplete", message: "Modeled air quality is fresh for 498/503 eligible destinations; 1 expired (LU: lu-dudelange); 4 absent (LU: lu-esch-sur-alzette, lu-luxembourg, lu-luxembourg-moselle, lu-mullerthal)" },
      expect.objectContaining({ code: "conditions_marine_incomplete", message: expect.stringMatching(/^Marine forecast is fresh for 110\/131.+\(\+13 more\)\)$/) }),
    ]);
    expect(report.warnings.some(({ code, message }) => code === "conditions_source_health" && message.includes("open-meteo-marine"))).toBe(false);
  });
  it("blocks country-scoped records published under another country", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    const file = conditions.find(({ countryCode }) => countryCode === "ES")!;
    file.sources["ipma-observations"] = conditionAttribution("ipma-observations");
    file.locations["es-madrid"].observations.push({
      sourceId: "ipma-observations", sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 2 * 3600000).toISOString(), observedAt: now.toISOString(),
      stationId: "portuguese-station", stationName: "Portuguese station", sourceUrl: "https://api.ipma.pt/",
      measurements: [{ metric: "temperature", value: 20, unit: "°C" }],
    });
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "conditions_publication_invalid", message: expect.stringContaining("ES:") }));
  });
  it("blocks a release that expects the reviewed conditions baseline when its switches are disabled", async () => {
    const report = await verifyProduction({ origin, now, expectLocalConditions: true,
      fetch: fetchFixture(pageMetadata(), healthySnapshot()) });
    expect(report.blockers.map(({ code }) => code)).toEqual([
      "local_conditions_disabled", "noncommercial_conditions_disabled",
    ]);
  });
  it("blocks missing or wrong-release conditions publications", async () => {
    const conditions = conditionsFiles();
    conditions.splice(-10);
    const report = await verifyProduction({ origin, now, expectedSha: releaseSha,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "conditions_catalog_incomplete", "conditions_publication_invalid", "conditions_sha_mismatch",
    ]));
    expect(report.blockers.filter(({ code }) => code === "conditions_publication_invalid")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^10\/28 conditions files.+\(\+2 more\)$/) }),
    ]);
    expect(report.blockers.filter(({ code }) => code === "conditions_sha_mismatch")).toHaveLength(1);
  });
  it("does not warn for infrastructure awaiting the next hourly cleanup", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    addExpiredInfrastructure(conditions, 30, 10);
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.metrics.conditions).toMatchObject({ pendingExpiryCleanup: 1, overdueExpiredRecords: 0 });
    expect(report.warnings.some(({ code }) => code === "conditions_stale_infrastructure")).toBe(false);
  });
  it("reports infrastructure that remains expired beyond the publication grace", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    addExpiredInfrastructure(conditions, 120, 60);
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.metrics.conditions).toMatchObject({ pendingExpiryCleanup: 0, overdueExpiredRecords: 1 });
    expect(report.warnings).toContainEqual({ code: "conditions_stale_infrastructure",
      message: "1 expired infrastructure records remain published: FI/fi-helsinki/digitraffic:expired" });
  });
  it("reports overdue conditions publications once with bounded deterministic examples", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    for (const file of conditions) file.generatedAt = new Date(now.getTime() - 76 * 60_000).toISOString();
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.warnings).toContainEqual({ code: "conditions_publication_overdue",
      message: "28/28 conditions files are older than the 75-minute publication grace: AT, BE, BG, CH, CY, CZ, DE, DK (+20 more)" });
  });
  it("blocks infrastructure that was already expired when published", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    addExpiredInfrastructure(conditions, 0, 60);
    const report = await verifyProduction({ origin, now,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers).toContainEqual({ code: "conditions_record_expired_at_publication",
      message: "1 infrastructure records were already expired when published: FI/fi-helsinki/digitraffic:expired" });
  });
  it("aggregates release mismatches with bounded deterministic country examples", async () => {
    const conditions = conditionsFiles(createEmptyState(now), { VERCEL_GIT_COMMIT_SHA: releaseSha });
    for (const file of conditions.slice(0, 10)) file.producerCommitSha = "b".repeat(40);
    const report = await verifyProduction({ origin, now, expectedSha: releaseSha, expectLocalConditions: true,
      fetch: fetchFixture(pageMetadata() + '<meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">', healthySnapshot(), conditions) });
    expect(report.blockers.filter(({ code }) => code === "conditions_sha_mismatch")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^10\/28 conditions files.+\(\+2 more\)$/) }),
    ]);
    expect(report.metrics.conditions).toMatchObject({ releaseMatches: 18, releaseMismatches: 10 });
  });
  it("treats the GDELT reliability kill switch as context unavailability, not a release blocker", async () => {
    const snapshot = healthySnapshot(); snapshot.providers.gdelt.status = "disabled";
    const report = await verifyProduction({ origin, now, fetch: fetchFixture(pageMetadata(), snapshot) });
    expect(report.blockers).toEqual([]);
    expect(report.warnings.map(({ code }) => code)).toEqual(["gdelt_reliability_gate"]);
  });
  it("accepts a fresh live Snapshot V10 catalog and an expected SHA prefix", async () => {
    const report = await verifyProduction({
      origin, expectedSha: releaseSha.slice(0, 8), now,
      fetch: fetchFixture(pageMetadata(), healthySnapshot()),
    });
    expect(report).toMatchObject({
      status: "ok", blockers: [], warnings: [],
      metrics: { releaseSha, snapshotUrl, schemaVersion: 10, catalogVersion: 2, locations: 503, unknownLocations: 0 },
    });
  });

  it("returns stable blocker codes for release, mode, freshness, and switch failures", async () => {
    const snapshot = healthySnapshot();
    snapshot.generatedAt = new Date(now.getTime() - 121 * 60_000).toISOString();
    snapshot.dataHealth = "stale";
    snapshot.providers.gfm.status = "disabled";
    const report = await verifyProduction({
      origin, expectedSha: "b".repeat(40), now,
      fetch: fetchFixture(pageMetadata("demo"), snapshot),
    });
    expect(report.status).toBe("blocked");
    expect(report.blockers.map(({ code }) => code)).toEqual([
      "data_health_stale",
      "live_mode_missing",
      "release_sha_mismatch",
      "snapshot_stale",
      "steady_state_provider_disabled",
    ]);
  });

  it("reports delayed but structurally valid production data as warnings", async () => {
    const snapshot = healthySnapshot();
    snapshot.generatedAt = new Date(now.getTime() - 31 * 60_000).toISOString();
    snapshot.dataHealth = "delayed";
    snapshot.providers.gdelt.status = "failed";
    const first = Object.keys(snapshot.locations)[0];
    const state = snapshot.locations[first];
    snapshot.locations[first] = {
      level: "UNKNOWN", coverage: "delayed", coverageGaps: state.coverageGaps, delayedHazards: ["severe-weather"], hazards: [],
    };
    const report = await verifyProduction({ origin, now, fetch: fetchFixture(pageMetadata(), snapshot) });
    expect(report.status).toBe("warning");
    expect(report.warnings.map(({ code }) => code)).toEqual([
      "data_health_delayed", "provider_health", "snapshot_age_warning", "unknown_locations",
    ]);
  });

  it("discovers live mode and the snapshot URL from a pre-metadata deployment", async () => {
    const html = 'self.__next_f.push([1,"{\\\"mode\\\":\\\"live\\\",\\\"snapshotUrl\\\":\\\"' + snapshotUrl + '\\\"}"])';
    const report = await verifyProduction({ origin, now, fetch: fetchFixture(html, healthySnapshot()) });
    expect(report.status).toBe("ok");
    expect(report.metrics.snapshotUrl).toBe(snapshotUrl);
  });
});
