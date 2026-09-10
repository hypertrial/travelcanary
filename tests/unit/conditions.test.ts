import { parseCatalogState } from "@/lib/domain/catalog-state";
import { projectLegacyState } from "../fixtures/legacy-state";
import { describe, expect, it, vi } from "vitest";
import forecastFixture from "../fixtures/conditions/forecast.json";
import airFixture from "../fixtures/conditions/air.json";
import metarFixture from "../fixtures/conditions/metar.json";
import metNorwayFixture from "../fixtures/conditions/met-norway.json";
import marineFixture from "../fixtures/conditions/marine.json";
import rwsFixture from "../fixtures/conditions/rws-water.json";
import ipmaObservationFixture from "../fixtures/conditions/ipma-observations.json";
import ipmaSeismicFixture from "../fixtures/conditions/ipma-seismic.json";
import { parseMetNorway, parseOpenMeteo, forecastUrl } from "@/lib/conditions/forecast";
import { parseMetars, airportMappings } from "@/lib/conditions/metar";
import { availableForecastWeight, buildConditionsFiles, currentConditions, fitConditionsState } from "@/lib/conditions/state";
import { conditionAttribution, conditionSourceEnabled, conditionsDisabledSources } from "@/lib/conditions/sources";
import { forecastBatches, forecastSplitHasLocalHeadroom, runConditions } from "@/lib/conditions/worker";
import { ConditionsSchema, emptyConditions, conditionRecords, conditionSourceIds, CONDITIONS_CACHE_LIMIT, type Conditions } from "@/lib/domain/conditions";
import { locations } from "@/lib/data";
import { createEmptyState, buildSnapshot } from "@/lib/risk";
import { downgradeIngestionStateV11, downgradeIngestionStateV12, parseIngestionState } from "@/lib/domain/schemas";
import { MemoryStateStore } from "@/lib/storage";
import { parseRwsWater, rwsWaterMappings, rwsWaterRequest } from "@/lib/conditions/rws-water";
import { marineConditionMapping, marineEligibleLocationIds } from "@/lib/conditions/marine";
import { ipmaStationMappings, parseIpmaEarthquakes, parseIpmaObservations } from "@/lib/conditions/ipma";
import { readFileSync } from "node:fs";
import { arsoHydroMappings, parseArsoHydrology } from "@/lib/conditions/arso-hydro";

const now = new Date("2026-08-31T17:45:00.000Z");
const enabled = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true" };
const weather = () => parseOpenMeteo(forecastFixture, "weather", now) as NonNullable<Conditions["locations"][string]["weather"]>;
const successfulPublish = async (files: Conditions[]) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] });

describe("isolated local conditions", () => {
  it("parses real hourly island fixtures without fabricating issue times", () => {
    expect(weather()).toMatchObject({ sourceId: "open-meteo-weather", sourceUpdatedAt: null, temperature: expect.any(Array) });
    expect(parseOpenMeteo(airFixture, "airQuality", now)).toMatchObject({ pm25: expect.any(Array), dust: Array(24).fill(0) });
    expect(forecastUrl("weather", [[-31.127, 39.4556]])).toContain("wind_speed_unit=ms");
    expect(() => forecastUrl("weather", Array(41).fill([0, 0]))).toThrow(/40/);
    expect(parseOpenMeteo(marineFixture, "marine", new Date("2026-08-31T18:58:55.507Z"))).toMatchObject({ sourceUpdatedAt: null, waveHeight: expect.any(Array) });
  });
  it("rejects invalid units, time alignment, missing data, future windows and impossible values", () => {
    for (const mutate of [
      (data: typeof forecastFixture) => { data.hourly_units.wind_speed_10m = "km/h"; },
      (data: typeof forecastFixture) => { data.hourly.time[1] += 1; },
      (data: typeof forecastFixture) => { data.hourly.temperature_2m.pop(); },
      (data: typeof forecastFixture) => { data.hourly.temperature_2m[0] = 100; },
      (data: typeof forecastFixture) => { data.hourly.time = data.hourly.time.map((time) => time + 86400); },
    ]) { const data = structuredClone(forecastFixture); mutate(data); expect(() => parseOpenMeteo(data, "weather", now)).toThrow(); }
    const nulls = { ...forecastFixture, hourly: { ...forecastFixture.hourly, temperature_2m: Array(24).fill(null) } };
    expect(() => parseOpenMeteo(nulls, "weather", now)).toThrow(/representative/);
  });
  it("keeps missing optional values null, not zero", () => {
    const data = { ...forecastFixture, hourly: { ...forecastFixture.hourly, wind_gusts_10m: Array(24).fill(null) } };
    expect(parseOpenMeteo(data, "weather", now)).toHaveProperty("gusts", Array(24).fill(null));
  });
  it("converts actual METAR units and preserves the visibility lower bound", () => {
    const observations = parseMetars(metarFixture, now);
    expect(observations.get("LPFL")?.measurements).toContainEqual({ metric: "wind", value: 3.1, unit: "m/s" });
    expect(observations.get("LPFL")?.measurements).toContainEqual({ metric: "visibility", value: 9.7, unit: "km", qualifier: "at-least" });
    expect(JSON.stringify([...observations.values()])).not.toContain("rawOb");
    expect(() => parseMetars(metarFixture, new Date("2026-09-01T00:00:00Z"))).toThrow(/current/);
    expect(parseMetars([], now).size).toBe(0);
  });
  it("accepts only current reviewed Rijkswaterstaat NAP observations and preserves quality", () => {
    const observedNow = new Date("2026-09-01T13:00:00.000Z");
    const parsed = parseRwsWater(rwsFixture, observedNow);
    expect(rwsWaterMappings).toHaveLength(7);
    expect(rwsWaterRequest()).toMatchObject({ AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Hoedanigheid: { Code: "NAP" }, ProcesType: "meting" } }] });
    expect(parsed.get("rotterdam.nieuwemaas.boerengat")).toMatchObject({ sourceId: "rws-water", datum: "NAP", qualityCode: "00",
      qualityStatus: "provisional", measurements: [{ metric: "water-level", value: -4, unit: "cm" }] });
    expect([...parsed.values()]).toHaveLength(1);
    expect(parseRwsWater({ Succesvol: true, WaarnemingenLijst: [] }, observedNow).size).toBe(0);
    for (const mutate of [
      (value: typeof rwsFixture) => { value.WaarnemingenLijst[0].AquoMetadata.Hoedanigheid.Code = "MSL"; },
      (value: typeof rwsFixture) => { value.WaarnemingenLijst[0].MetingenLijst[0].WaarnemingMetadata.Kwaliteitswaardecode = "99"; },
      (value: typeof rwsFixture) => { value.WaarnemingenLijst[0].Locatie.Code = "unreviewed"; },
      (value: typeof rwsFixture) => { value.WaarnemingenLijst[0].Locatie.Lat += 1; },
    ]) { const value = structuredClone(rwsFixture); mutate(value); expect(() => parseRwsWater(value, observedNow)).toThrow(); }
  });
  it("parses only current reviewed ARSO gauges and keeps reference crossings contextual", () => {
    const xml = readFileSync("tests/fixtures/conditions/arso-hydrology.xml", "utf8");
    const observedNow = new Date("2026-09-02T07:30:00.000Z");
    const parsed = parseArsoHydrology(xml, observedNow);
    expect(new Set(arsoHydroMappings.map(({ locationId }) => locationId))).toEqual(new Set(locations.filter(({ countryCode }) => countryCode === "SI").map(({ id }) => id)));
    expect(Math.max(...locations.map(({ id }) => arsoHydroMappings.filter(({ locationId }) => locationId === id).length))).toBeLessThanOrEqual(3);
    expect(parsed.get("6140")).toMatchObject({ sourceId: "arso-hydro", observedAt: "2026-09-02T07:00:00.000Z",
      datum: "ARSO gauge zero 232.11 m", qualityStatus: "provisional",
      measurements: [{ metric: "water-level", value: 90, unit: "cm" }, { metric: "discharge", value: 6.55, unit: "m³/s" },
        { metric: "water-temperature", value: 21, unit: "°C" }] });
    expect(parsed.get("6720")?.measurements).toContainEqual({ metric: "water-level", value: 57, unit: "cm", qualifier: "above-reference" });
    expect(parsed.get("5479")).toMatchObject({ stationId: "5479", stationName: "Gradaščica - Bokalce" });
    expect(parsed.has("9999")).toBe(false);
    expect(parseArsoHydrology(xml.replaceAll("2026-09-02 08:00", "2026-09-02 05:00"), observedNow).size).toBe(0);
    expect(parseArsoHydrology(xml.replaceAll("2026-09-02 08:00", "2026-09-02 09:00"), observedNow).size).toBe(0);
    expect(() => parseArsoHydrology(xml.replace("Agencija RS za okolje", "Unknown authority"), observedNow)).toThrow(/contract/);
    expect(() => parseArsoHydrology(xml.replace("Savinja</reka>", "Changed</reka>"), observedNow)).toThrow(/contract changed/);
    expect(() => parseArsoHydrology("<!DOCTYPE evil>" + xml, observedNow)).toThrow(/Unsupported/);
  });
  it("includes all five island airport mappings and no park/mountain inference", () => {
    for (const id of ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores", "es-las-palmas-de-gran-canaria", "es-santa-cruz-de-tenerife"]) expect(airportMappings.some((mapping) => mapping.locationId === id)).toBe(true);
    expect(airportMappings.every((mapping) => mapping.distanceKm <= 25)).toBe(true);
    expect(airportMappings.some((mapping) => mapping.locationId === "at-austrian-alps")).toBe(false);
  });
  it("uses only reviewed offshore marine cells and never retries permanent exclusions", () => {
    expect(marineConditionMapping.mappings).toHaveLength(152);
    expect(marineEligibleLocationIds.size).toBe(131);
    expect(marineConditionMapping.mappings.filter(({ status }) => status === "unsupported")).toHaveLength(21);
    expect(marineConditionMapping.mappings.find(({ locationId }) => locationId === "ie-galway")).toMatchObject({
      status: "mapped", queryCoordinates: [-9.2916565, 53.208336], distanceKm: 17.5,
    });
    const marineIds = forecastBatches(createEmptyState(now), now, enabled).filter(({ kind }) => kind === "marine").flatMap(({ ids }) => ids);
    expect(marineIds.every((id) => marineEligibleLocationIds.has(id))).toBe(true);
    const unsupported = marineConditionMapping.mappings.find(({ status }) => status === "unsupported")!.locationId;
    const file = buildConditionsFiles(createEmptyState(now), now, enabled).find(({ countryCode }) => unsupported.startsWith(`${countryCode.toLowerCase()}-`))!;
    expect(file.locations[unsupported].limitations).toContain("outside-product");
  });
  it("prioritizes missing, near-expiry, and ordinary due forecasts deterministically", () => {
    const state = createEmptyState(now); const env = { ...enabled,
      CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") };
    for (const location of locations) {
      state.conditions.attempts[`weather:${location.id}`] = now.toISOString();
      state.conditions.locations[location.id] = { ...emptyConditions(), weather: weather() };
    }
    const [missing, nearExpiry, ordinary] = ["at-vienna", "be-brussels", "ch-zuerich"];
    delete state.conditions.locations[missing];
    state.conditions.attempts[`weather:${missing}`] = new Date(now.getTime() - 5 * 60_000).toISOString();
    state.conditions.attempts[`weather:${ordinary}`] = new Date(now.getTime() - 5 * 3600000).toISOString();
    state.conditions.locations[nearExpiry] = { ...emptyConditions(), weather: { ...weather(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString() } };
    state.conditions.locations[ordinary] = { ...emptyConditions(), weather: { ...weather(), expiresAt: new Date(now.getTime() + 2 * 3600000).toISOString() } };
    expect(forecastBatches(state, now, env).find(({ kind }) => kind === "weather")?.ids).toEqual([missing, nearExpiry, ordinary]);
  });
  it("permits a split only with request, byte, deadline, and retry headroom", () => {
    const eligible = { splitRetry: true, batchSize: 40, requests: 126, remainingBytes: 1024 * 1024, remainingMs: 8000 };
    expect(forecastSplitHasLocalHeadroom(eligible)).toBe(true);
    for (const input of [
      { ...eligible, splitRetry: false }, { ...eligible, batchSize: 1 }, { ...eligible, requests: 127 },
      { ...eligible, remainingBytes: 1024 * 1024 - 1 }, { ...eligible, remainingMs: 7999 },
    ]) expect(forecastSplitHasLocalHeadroom(input)).toBe(false);
  });
  it("normalizes current IPMA observations and bounded earthquake context", () => {
    const station = ipmaStationMappings.find(({ locationId }) => locationId === "pt-lisbon")!;
    const observations = parseIpmaObservations(ipmaObservationFixture, now);
    expect(observations.get("pt-lisbon")).toMatchObject({ stationId: station.stationId, sourceId: "ipma-observations",
      measurements: [{ metric: "temperature", value: 22.5, unit: "°C" }, { metric: "rainfall", value: 1.2, unit: "mm" }] });
    const altered = structuredClone(ipmaObservationFixture); Object.assign(altered.features[0].properties, { temperatura: -99, intensidadeVento: -99, precAcumulada: -99 });
    expect(parseIpmaObservations(altered, now).size).toBe(0);
    const future = structuredClone(ipmaObservationFixture); future.features[0].properties.time = "2026-08-31T20:00:00";
    expect(parseIpmaObservations(future, now).size).toBe(0);
    const moved = structuredClone(ipmaObservationFixture); moved.features[0].geometry.coordinates[0] += 1;
    expect(() => parseIpmaObservations(moved, now)).toThrow(/coordinates changed/);
    const feed = structuredClone(ipmaSeismicFixture);
    expect(parseIpmaEarthquakes([feed], now)["pt-lisbon"]).toEqual([expect.objectContaining({ id: "pt-test", magnitude: 3.4, sourceId: "ipma-seismic" })]);
    expect(parseIpmaEarthquakes([{ ...feed, data: [{ ...feed.data[0], time: "2026-08-29T16:00:00" }] }], now)["pt-lisbon"]).toBeUndefined();
  });
  it("requires exact switches and cannot enable an evidence-gated source", () => {
    expect(conditionSourceEnabled("open-meteo-weather", enabled)).toBe(true);
    expect(conditionSourceEnabled("rws-water", enabled)).toBe(true);
    expect(conditionSourceEnabled("ipma-observations", enabled)).toBe(true);
    expect(conditionSourceEnabled("ipma-seismic", enabled)).toBe(true);
    expect(conditionSourceEnabled("arso-hydro", enabled)).toBe(true);
    expect(conditionAttribution("rws-water").licenseUrl).toBe("https://www.rijkswaterstaat.nl/zakelijk/open-data");
    expect(conditionAttribution("arso-hydro").licenseUrl).toBe("https://eionet.arso.gov.si/pravna-podlaga");
    expect(conditionSourceEnabled("open-meteo-weather", { ...enabled, NONCOMMERCIAL_DATA_ENABLED: "TRUE" })).toBe(false);
    expect(conditionSourceEnabled("opw-hydro", enabled)).toBe(true);
    expect(conditionSourceEnabled("ign-seismic", enabled)).toBe(false);
    expect(() => conditionsDisabledSources("unknown")).toThrow();
    expect(() => conditionsDisabledSources("awc-metar,awc-metar")).toThrow();
  });
  it("accounts for location-weighted rolling quotas and failed-attempt reservations", () => {
    const state = createEmptyState(now);
    expect(availableForecastWeight(state, now)).toBe(400);
    state.conditions.reservations.push({ at: now.toISOString(), weight: 399 });
    expect(availableForecastWeight(state, now)).toBe(1);
    expect(forecastBatches(state, now, enabled).reduce((sum, batch) => sum + batch.ids.length, 0)).toBe(1);
    state.conditions.cooldownUntil = new Date(now.getTime() + 60_000).toISOString();
    expect(forecastBatches(state, now, enabled)).toEqual([]);
  });
  it("schedules no more than 400 weighted calls and prioritizes sparse islands", () => {
    const batches = forecastBatches(createEmptyState(now), now, enabled);
    expect(batches.reduce((total, batch) => total + batch.ids.length, 0)).toBe(400);
    expect(batches.every((batch) => batch.ids.length <= 40)).toBe(true);
    expect(batches[0].ids.slice(0, 5)).toContain("pt-santa-cruz-das-flores");
  });
  it("publishes exactly 503 IDs across 28 files without changing any alert result", () => {
    const state = createEmptyState(now); const before = buildSnapshot(state, now);
    state.conditions.locations["pt-horta"] = { ...emptyConditions(), weather: weather() as NonNullable<ReturnType<typeof emptyConditions>["weather"]> };
    const files = buildConditionsFiles(state, now, enabled);
    expect(files).toHaveLength(28);
    expect(files.flatMap((file) => Object.keys(file.locations))).toHaveLength(503);
    expect(buildSnapshot(state, now)).toEqual(before);
    expect(files.find((file) => file.countryCode === "PT")!.locations["pt-horta"].weather?.sourceId).toBe("open-meteo-weather");
    expect(() => ConditionsSchema.parse({ ...files[0], countryCode: "PT" })).toThrow(/country/);
  });
  it("rejects country-scoped records and health outside their reviewed country", () => {
    const observation = parseIpmaObservations(ipmaObservationFixture, now).get("pt-lisbon")!;
    const file = { schemaVersion: 2 as const, catalogVersion: 2 as const, countryCode: "ES", generatedAt: now.toISOString(), producerCommitSha: null,
      sources: { "ipma-observations": conditionAttribution("ipma-observations") }, sourceHealth: {},
      locations: { "es-madrid": { ...emptyConditions(), observations: [observation] } } };
    expect(() => ConditionsSchema.parse(file)).toThrow(/does not apply to country/);
    expect(() => ConditionsSchema.parse({ ...file, locations: { "es-madrid": emptyConditions() },
      sourceHealth: { "ipma-observations": { status: "ok", checkedAt: now.toISOString(), limitationCode: null } } })).toThrow(/does not apply to country/);
  });
  it("keeps aggregate forecast health private instead of copying it into every country", () => {
    const state = createEmptyState(now);
    state.conditions.health["open-meteo-marine"] = { checkedAt: now.toISOString(), status: "failed", matched: 130, code: "batch_failed" };
    state.conditions.health["met-norway"] = { checkedAt: now.toISOString(), status: "partial", matched: 1, code: "source_unavailable" };
    const files = buildConditionsFiles(state, now, enabled);
    expect(state.conditions.health["open-meteo-marine"]?.status).toBe("failed");
    expect(files.every((file) => file.sourceHealth["open-meteo-marine"] === undefined && file.sourceHealth["met-norway"] === undefined)).toBe(true);
  });
  it("ages forecasts locally and clips their remaining window without extending expiry", () => {
    const location = { ...emptyConditions(), weather: weather() as NonNullable<ReturnType<typeof emptyConditions>["weather"]> };
    const later = currentConditions(location, new Date(now.getTime() + 2 * 3_600_000));
    expect(later.weather?.temperature.length).toBe(22);
    expect(later.weather?.expiresAt).toBe(location.weather.expiresAt);
    expect(conditionRecords(currentConditions(location, new Date(now.getTime() + 6 * 3_600_000)))).toEqual([]);
  });
  it("upgrades and down-projects state without changing compatible alerts", () => {
    const original = createEmptyState(now); const old = downgradeIngestionStateV11(downgradeIngestionStateV12(projectLegacyState(original)));
    expect(old.schemaVersion).toBe(10);
    const upgraded = parseIngestionState(old);
    expect(upgraded.schemaVersion).toBe(12);
    expect(upgraded.events).toEqual(original.events);
    expect(upgraded.conditions.locations).toEqual({});
    expect(fitConditionsState(parseCatalogState(upgraded), now)).toEqual(parseCatalogState(upgraded));
  });
  it("evicts optional payload before controls and alert state", () => {
    const state = createEmptyState(now);
    const series = Array(25).fill(1.2345678901234567);
    const forecast = { ...weather(), temperature: series, wind: series, gusts: series, precipitation: series, precipitationProbability: series, weatherCode: Array(25).fill(3) } as NonNullable<ReturnType<typeof emptyConditions>["weather"]>;
    for (const location of locations) state.conditions.locations[location.id] = { ...emptyConditions(), weather: structuredClone(forecast),
      airQuality: { sourceId: "open-meteo-air", checkedAt: now.toISOString(), sourceUpdatedAt: null, expiresAt: forecast.expiresAt, startAt: forecast.startAt, stepMinutes: 60, aqi: series, pm25: series, pm10: series, dust: series, uv: series },
      marine: { sourceId: "open-meteo-marine", checkedAt: now.toISOString(), sourceUpdatedAt: null, expiresAt: forecast.expiresAt, startAt: forecast.startAt, stepMinutes: 60, waveHeight: series, wavePeriod: series, seaTemperature: series } };
    state.conditions.reservations = [{ at: now.toISOString(), weight: 400 }];
    state.conditions.lease = { id: "00000000-0000-4000-8000-000000000001", expiresAt: new Date(now.getTime() + 90000).toISOString() };
    const before = buildSnapshot(state, now);
    fitConditionsState(state, now);
    expect(Buffer.byteLength(JSON.stringify(state.conditions.locations))).toBeLessThanOrEqual(CONDITIONS_CACHE_LIMIT);
    expect(Object.keys(state.conditions.locations).length).toBeLessThan(503);
    expect(state.conditions.reservations).toHaveLength(1);
    expect(state.conditions.lease).not.toBeNull();
    expect(buildSnapshot(state, now)).toEqual(before);
  });
  it("makes no upstream requests when conditions are disabled", async () => {
    const fetchMock = vi.fn(); const publish = vi.fn(successfulPublish);
    await runConditions({ stateStore: new MemoryStateStore(createEmptyState(now)), fetch: fetchMock, publish, now, env: {} });
    expect(fetchMock).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0][0].locations["at-vienna"].limitations).toEqual(["disabled"]);
  });
  it("does not fetch or publish while another conditions worker owns the lease", async () => {
    const state = createEmptyState(now); state.conditions.lease = { id: "00000000-0000-4000-8000-000000000001", expiresAt: new Date(now.getTime() + 60000).toISOString() };
    const fetchMock = vi.fn(); const publish = vi.fn(successfulPublish);
    await expect(runConditions({ stateStore: new MemoryStateStore(state), fetch: fetchMock, publish, now, env: enabled })).resolves.toMatchObject({ code: "conditions_lease_held" });
    expect(fetchMock).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });
  it("rejects stale or structurally undocumented MET Norway responses", () => {
    expect(() => parseMetNorway({}, now)).toThrow();
    const parsed = parseMetNorway(metNorwayFixture, new Date("2026-08-31T18:48:22.850Z"));
    expect(parsed.sourceId).toBe("met-norway");
    expect(parsed.temperature.length).toBeGreaterThanOrEqual(18);
    expect(parsed.precipitationProbability.every((value) => value === null)).toBe(true);
    expect(() => parseMetNorway(metNorwayFixture, new Date("2026-09-03T12:00:00Z"))).toThrow(/Stale/);
  });
});


it("includes IPMA earthquakes within 100 km of a polygon edge, not just its vertices", () => {
  const feed = { idArea: 3, owner: "IPMA", updateDate: "2026-08-31T17:30:00", data: [
    { sismoId: "near-edge", time: "2026-08-31T17:00:00", lat: "36.1", lon: "-8.2", magnitud: "3.5" },
    { sismoId: "distant", time: "2026-08-31T17:00:00", lat: "35", lon: "-8.2", magnitud: "3.5" },
  ] };
  const result = parseIpmaEarthquakes([feed], now)["pt-algarve"];
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: "near-edge", distanceKm: expect.any(Number) });
  expect(result[0].distanceKm).toBeLessThan(90);
});
