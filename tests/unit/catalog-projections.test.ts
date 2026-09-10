import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogLocationsV3, CatalogLocationV3Schema } from "@/lib/catalog-data";
import { buildPendingCatalog3Snapshot, buildPendingCatalog3Conditions } from "@/lib/catalog-projections";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { projectCatalog2Snapshot } from "@/lib/risk-snapshot";
import { buildConditionsFiles, projectCatalog2Conditions } from "@/lib/conditions/state";
import { CollectionChangedError, IngestionStateV14Schema, type NormalizedEventV13 } from "@/lib/domain/catalog-state";
import { ConditionsV2Schema, conditionRecords, emptyConditions } from "@/lib/domain/conditions";
import { SnapshotV11Schema, ConditionsV3Schema, PublicCatalogV3Schema, catalogLocationState } from "@/lib/domain/catalog-public";
import { applySnapshotStaleness } from "@/lib/snapshot-health";
import { locationCoveragePresentation } from "@/lib/coverage-presentation";
import { locations } from "@/lib/data";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
import candidates from "../../data/review-inputs/europe-expansion-catalog.json";

const now = new Date("2026-08-25T12:00:00Z");
const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: "a".repeat(40) };
const addedIds = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
const oldCountries = [...new Set(release2.locationIds.map((id) => id.slice(0, 2).toUpperCase()))];
const addedCountries = [...new Set(addedIds.map((id) => id.slice(0, 2).toUpperCase()))];
function event(id: string, geometry: NormalizedEventV13["geometry"]): NormalizedEventV13 {
  return { id, sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Earthquake reported nearby.", explanation: "Preliminary earthquake evidence.", action: "Check official advice.", affectedArea: "Reported area",
    geometry, startsAt: now.toISOString(), endsAt: "2026-08-25T14:00:00Z", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
    expiresAt: "2026-08-25T14:00:00Z", sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM" };
}
function populated() {
  const state = createEmptyState(now);
  for (const health of [...Object.values(state.sources), ...Object.values(state.sourcePartitions).flatMap(Object.values)]) Object.assign(health, {
    status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(), nextExpectedUpdate: "2026-08-25T12:10:00Z", error: null,
  });
  state.events = [event("usgs:legacy", { kind: "locations", ids: ["at-vienna"] })];
  for (const code of ["AT", "FI", "PL"]) Object.assign(state.conditions.locations,
    ConditionsV2Schema.parse(JSON.parse(readFileSync(`public/conditions/v2/${code}.json`, "utf8"))).locations);
  state.conditions.reservations = [{ at: now.toISOString(), weight: 200 }]; state.fingerprints.retained = now.toISOString();
  return IngestionStateV14Schema.parse(state);
}

describe("inactive shared catalog3 data", () => {
  it("contains exact679 frozen IDs and preserves all old503 full records", () => {
    expect(catalogLocationsV3.map(({ id }) => id).sort()).toEqual([...release3.locationIds].sort());
    expect(new Set(catalogLocationsV3.map(({ countryCode }) => countryCode)).size).toBe(45);
    for (const location of locations) expect(catalogLocationsV3.find(({ id }) => id === location.id)).toEqual(location);
    for (const candidate of candidates.locations) expect(catalogLocationsV3.find(({ id }) => id === candidate.id)).toMatchObject({ centroid: candidate.centroid, geometry: candidate.geometry, sourceRegionCodes: candidate.sourceRegionCodes });
    const withoutMeteo = structuredClone(catalogLocationsV3.find(({ id }) => id === "gb-london")!);
    withoutMeteo.sourceRegionCodes.meteoalarm = [];
    expect(CatalogLocationV3Schema.safeParse(withoutMeteo).success).toBe(true);
    expect(PublicCatalogV3Schema.parse(catalogLocationsV3)).toHaveLength(679);
  });

  it("matches the generated public artifact exactly and excludes private matching fields", () => {
    const publicCatalog = PublicCatalogV3Schema.parse(catalogLocationsV3);
    const bytes = readFileSync("public/catalogs/3/locations.json", "utf8");
    expect(bytes).toBe(`${JSON.stringify(publicCatalog)}\n`); expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(150000);
    const allowed = ["id", "name", "aliases", "country", "countryCode", "type", "centroid", "isCoastal", "timezone", "scope", "scopeNote"];
    for (const location of publicCatalog) expect(Object.keys(location).every((key) => allowed.includes(key))).toBe(true);
    const legacyPublic = JSON.parse(readFileSync("public/locations.json", "utf8"));
    expect(publicCatalog.filter(({ id }) => release2.locationIds.includes(id))).toEqual(legacyPublic);
  });
});

describe("pure pending catalog projections", () => {
  it.each([2, 3] as const)("preserves legacy snapshot and condition payloads from collection%s without state mutation", (catalogVersion) => {
    const state = populated(); const expected = buildSnapshot(state, now); const expectedConditions = buildConditionsFiles(state, now, env);
    state.collection = { catalogVersion, revision: 7 }; const before = structuredClone(state);
    const legacy = projectCatalog2Snapshot(state, now); const legacyConditions = projectCatalog2Conditions(state, now, env);
    expect(legacy).toEqual(expected); expect(legacyConditions).toEqual(expectedConditions);
    const expanded = buildPendingCatalog3Snapshot(state, now); const conditionFiles = buildPendingCatalog3Conditions(state, now, env);
    expect(SnapshotV11Schema.parse(expanded)).toEqual(expanded); expect(conditionFiles).toHaveLength(45);
    for (const id of release2.locationIds) expect(expanded.locations[id]).toEqual(expected.locations[id]);
    for (const file of expectedConditions) expect(conditionFiles.find(({ countryCode }) => countryCode === file.countryCode)).toEqual({ ...file, schemaVersion: 3, catalogVersion: 3 });
    for (const file of conditionFiles) expect(ConditionsV3Schema.parse(file)).toEqual(file);
    expect(state).toEqual(before);
    if (catalogVersion === 3) {
      expect(() => buildSnapshot(state, now)).toThrow(CollectionChangedError);
      expect(() => buildConditionsFiles(state, now, env)).toThrow(CollectionChangedError);
    }
  });

  it("keeps every new destination pending despite healthy global sources and matching global/cross-border events", () => {
    const state = populated(); state.collection = { catalogVersion: 3, revision: 1 };
    state.events.push(event("usgs:cross-border", { kind: "locations", ids: ["at-vienna", "gb-london"] }),
      event("usgs:global", { kind: "polygon", coordinates: [[[-30, 25], [45, 25], [45, 72], [-30, 72], [-30, 25]]] }),
      event("usgs:new-country", { kind: "regions", countryCode: "GB", codes: ["GB:country"] }));
    expect(IngestionStateV14Schema.safeParse(state).success).toBe(true);
    const before = structuredClone(state); const snapshot = buildPendingCatalog3Snapshot(state, now);
    expect(snapshot.locations["at-vienna"].hazards.length).toBeGreaterThan(0);
    for (const id of addedIds) {
      const selected = catalogLocationState(snapshot, id); expect(selected.updatePending).toBe(true);
      expect(snapshot.locations[id]).toMatchObject({ updatePending: true });
      expect(selected.state).toMatchObject({ level: "UNKNOWN", coverage: "partial", hazards: [], delayedHazards: [] });
      const location = catalogLocationsV3.find((location) => location.id === id)!;
      const coverage = locationCoveragePresentation({ location, state: selected.state, snapshot, now });
      expect(coverage.freshness.status).toBe("unavailable");
      expect(coverage.fullyChecked).toEqual([]);
    }
    for (const id of ["meteoalarm", "eea-aqi", "national-civil-alerts"] as const) for (const code of addedCountries) {
      const partition = Object.entries(snapshot.providers[id].partitions!).find(([country]) => country === code)![1];
      expect(partition).toMatchObject({ status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, limitationCode: "catalog_update_pending" });
    }
    expect(state).toEqual(before);
  });

  it.each([2 * 3600000, 2 * 3600000 + 1])("preserves explicit pending destinations through snapshot staleness at age%s", (age) => {
    const source = buildPendingCatalog3Snapshot(populated(), now); const before = structuredClone(source);
    const aged = applySnapshotStaleness(source, new Date(now.getTime() + age), catalogLocationsV3);
    expect(aged.dataHealth).toBe(age > 2 * 3600000 ? "stale" : "delayed");
    for (const id of addedIds) {
      expect(aged.locations[id]).toEqual(source.locations[id]);
      const selected = catalogLocationState(aged, id);
      expect(selected.updatePending).toBe(true);
      expect(selected.state).toMatchObject({ level: "UNKNOWN", coverage: "partial", hazards: [], delayedHazards: [] });
    }
    if (age > 2 * 3600000) expect(aged.locations["at-vienna"].coverage).toBe("delayed");
    expect(source).toEqual(before);
  });

  it.each(["false flag", "normal", "complete coverage", "delayed hazards", "hazards"])("rejects pending location with %s", (mode) => {
    const snapshot = buildPendingCatalog3Snapshot(populated(), now); const location = snapshot.locations["gb-london"];
    const invalid = { ...location };
    if (mode === "false flag") Object.assign(invalid, { updatePending: false });
    if (mode === "normal") Object.assign(invalid, { level: "NORMAL" });
    if (mode === "complete coverage") Object.assign(invalid, { coverage: "complete" });
    if (mode === "delayed hazards") Object.assign(invalid, { delayedHazards: ["earthquake"] });
    if (mode === "hazards") Object.assign(invalid, { ...snapshot.locations["at-vienna"], updatePending: true });
    expect(() => SnapshotV11Schema.parse({ ...snapshot, locations: { ...snapshot.locations, "gb-london": invalid } })).toThrow();
  });

  it("never publishes cached new-location conditions or aggregate healthy sources for pending countries", () => {
    const state = populated(); state.collection = { catalogVersion: 3, revision: 1 };
    const record = state.conditions.locations["at-vienna"];
    expect(conditionRecords(record).length).toBeGreaterThan(0);
    for (const id of addedIds) state.conditions.locations[id] = structuredClone(record);
    state.conditions.health["open-meteo-weather"] = { status: "ok", checkedAt: now.toISOString(), matched: 679, code: null };
    const before = structuredClone(state); const files = buildPendingCatalog3Conditions(state, now, env);
    for (const file of files.filter(({ countryCode }) => addedCountries.includes(countryCode))) {
      expect(file.sources).toEqual({}); expect(file.sourceHealth).toEqual({});
      for (const location of Object.values(file.locations)) expect(location).toEqual({ ...emptyConditions(), limitations: ["update-pending"] });
    }
    expect(state).toEqual(before);
  });

  it("scopes catalog2 partition aggregates to the original28 countries when collection3 has new-country failures", () => {
    const state = populated(); state.collection = { catalogVersion: 3, revision: 1 };
    const baseline = projectCatalog2Snapshot(state, now);
    for (const group of Object.values(state.sourcePartitions)) for (const [code, health] of Object.entries(group)) if (!oldCountries.includes(code)) Object.assign(health, {
      status: "failed", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, error: "New country unavailable", consecutiveFailures: 3,
    });
    for (const id of ["meteoalarm", "eea", "national-civil-alerts"] as const) Object.assign(state.sources[id], { status: "failed", error: "Expanded aggregate failed", consecutiveFailures: 3 });
    expect(projectCatalog2Snapshot(state, now)).toEqual(baseline);
  });
});
