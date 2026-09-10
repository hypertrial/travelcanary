import { describe, expect, it } from "vitest";
import { buildCatalog3Conditions } from "@/lib/catalog-projections";
import { currentConditions } from "@/lib/conditions/presentation";
import { projectCatalog2Conditions } from "@/lib/conditions/state";
import { createEmptyState } from "@/lib/risk-state";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { conditionRecords, LocationConditionsV2Schema } from "@/lib/domain/conditions";
import { marineConditionEligible } from "@/lib/conditions/marine";
import fixture from "../fixtures/europe-expansion/conditions-populated-capacity.json";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";

const now = new Date("2026-09-08T21:27:00Z");
const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: "b".repeat(40) };
const added = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
function forecasts() {
  const retime = (record: object, hours: number) => ({ ...record, checkedAt: now.toISOString(), sourceUpdatedAt: null,
    startAt: now.toISOString(), expiresAt: new Date(now.getTime() + hours * 3600000).toISOString() });
  return LocationConditionsV2Schema.parse({ weather: retime(fixture.forecastSamples.weather, 6), airQuality: retime(fixture.forecastSamples.airQuality, 12), marine: retime(fixture.forecastSamples.marine, 12) });
}
function populated() {
  const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
  for (const [id, data] of Object.entries(fixture.locations)) state.conditions.locations[id] = LocationConditionsV2Schema.parse(data);
  for (const id of added) state.conditions.locations[id] = forecasts();
  return state;
}
function decoded(state = populated(), at = now, settings = env) { return buildCatalog3Conditions(state, at, settings).map((file) => ConditionsV3Schema.parse(JSON.parse(serializeCatalog3Conditions(file)))); }

describe("approved catalog3 conditions projection", () => {
  it("preserves legacy503 after wire decode and emits exact679 IDs in45 coherent country files without state mutation", () => {
    const state = populated(); const before = structuredClone(state); const legacy = projectCatalog2Conditions(state, now, env); const files = decoded(state);
    expect(files).toHaveLength(45);
    expect(files.flatMap(({ locations }) => Object.keys(locations)).sort()).toEqual([...release3.locationIds].sort());
    for (const file of files) {
      expect(file.generatedAt).toBe(now.toISOString()); expect(file.producerCommitSha).toBe(env.VERCEL_GIT_COMMIT_SHA);
      expect(Object.keys(file.locations).sort()).toEqual(release3.locationIds.filter((id) => id.startsWith(`${file.countryCode.toLowerCase()}-`)).sort());
    }
    for (const old of legacy) expect(files.find(({ countryCode }) => countryCode === old.countryCode)).toEqual({ ...old, schemaVersion: 3, catalogVersion: 3 });
    expect(state).toEqual(before);
  });

  it("publishes only approved forecast products for additions and all30 eligible marine destinations", () => {
    const files = decoded(); const entries = Object.assign({}, ...files.map(({ locations }) => locations)); let marineCount = 0;
    for (const id of added) {
      expect(entries[id].weather).toEqual(forecasts().weather); expect(entries[id].airQuality).toEqual(forecasts().airQuality);
      if (marineConditionEligible(id, 3)) { expect(entries[id].marine).toEqual(forecasts().marine); marineCount += 1; }
      else expect(entries[id].marine).toBeUndefined();
      if (catalogLocationsV3.find((location) => location.id === id)!.isCoastal && !marineConditionEligible(id, 3)) expect(entries[id].limitations).toContain("outside-product");
    }
    expect(marineCount).toBe(30);
  });

  it("discards fresh cached specialists, MET Norway, and healthy global metadata from unsupported expanded scopes", () => {
    const state = populated(); const target = "gb-london";
    const specialists = Object.values(fixture.locations).map((value) => LocationConditionsV2Schema.parse(value));
    const mixed = forecasts();
    for (const field of ["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions"] as const) {
      const item = specialists.map((value) => value[field][0]).find(Boolean);
      if (item) Object.assign(mixed, { [field]: [{ ...item, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3600000).toISOString() }] });
    }
    expect(mixed.observations.length).toBeGreaterThan(0); expect(mixed.rivers.length).toBeGreaterThan(0);
    expect(mixed.infrastructureIncidents.length).toBeGreaterThan(0); expect(mixed.systemConditions.length).toBeGreaterThan(0);
    mixed.earthquakes = [{ sourceId: "ipma-seismic", id: "ipma:cached", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(), occurredAt: now.toISOString(), magnitude: 3, distanceKm: 0, sourceUrl: "https://www.ipma.pt/" }];
    const stillCurrent = currentConditions(mixed, now);
    for (const field of ["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions"] as const) expect(stillCurrent[field]).toHaveLength(1);
    mixed.weather!.sourceId = "met-norway"; state.conditions.locations[target] = mixed;
    for (const source of ["open-meteo-weather", "awc-metar", "rws-water", "digitraffic"] as const) state.conditions.health[source] = { status: "ok", checkedAt: now.toISOString(), matched: 679, code: null };
    const file = decoded(state).find(({ countryCode }) => countryCode === "GB")!; const data = file.locations[target];
    expect(data.weather).toBeUndefined(); expect(data.marine).toBeUndefined(); expect(conditionRecords(data).map(({ sourceId }) => sourceId)).toEqual(["open-meteo-air"]);
    for (const field of ["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions"] as const) expect(data[field]).toEqual([]);
    expect(file.sourceHealth).toEqual({}); expect(Object.keys(file.sources).sort()).toEqual(["open-meteo-air", "open-meteo-marine", "open-meteo-weather"]);
    expect(data.limitations).toContain("partial-data");
  });

  it("rejects forecast-shaped records carrying an unapproved source for that product", () => {
    const state = populated(); const id = added.find((id) => marineConditionEligible(id, 3))!;
    const data = state.conditions.locations[id];
    data.weather!.sourceId = "met-norway"; data.airQuality!.sourceId = "open-meteo-weather"; data.marine!.sourceId = "open-meteo-air";
    const file = decoded(state).find(({ locations }) => id in locations)!;
    expect(conditionRecords(file.locations[id])).toEqual([]);
    expect(file.locations[id].limitations).toEqual(["update-pending"]);
  });

  it.each([{ LOCAL_CONDITIONS_ENABLED: "false" }, { NONCOMMERCIAL_DATA_ENABLED: "false" }, { CONDITIONS_DISABLED_SOURCES: "open-meteo-weather,open-meteo-air,open-meteo-marine" }])("applies disabled and noncommercial gates: %j", (override) => {
    const files = decoded(populated(), now, { ...env, ...override });
    for (const file of files.filter(({ countryCode }) => added.some((id) => id.startsWith(`${countryCode.toLowerCase()}-`)))) {
      expect(file.sources).toEqual({}); expect(file.sourceHealth).toEqual({});
      for (const entry of Object.values(file.locations)) { expect(conditionRecords(entry)).toEqual([]); expect(entry.limitations).toEqual(["disabled"]); }
    }
  });

  it("expires records at their exact boundary and preserves the longer-lived AQ and marine products", () => {
    const state = populated();
    for (const [hours, weatherPresent, otherPresent] of [[6 - 1 / 3600000, true, true], [6, false, true], [12, false, false]] as const) {
      const files = decoded(state, new Date(now.getTime() + hours * 3600000)); const entries = Object.assign({}, ...files.map(({ locations }) => locations));
      for (const id of added) {
        expect(Boolean(entries[id].weather)).toBe(weatherPresent); expect(Boolean(entries[id].airQuality)).toBe(otherPresent);
        expect(Boolean(entries[id].marine)).toBe(otherPresent && marineConditionEligible(id, 3));
        if (!otherPresent) expect(entries[id].limitations).toContain("update-pending");
      }
    }
  });
});
