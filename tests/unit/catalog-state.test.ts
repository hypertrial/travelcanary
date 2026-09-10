import { describe, expect, it } from "vitest";
import * as legacy from "@/lib/domain/schemas";
import { readFileSync } from "node:fs";
import { ConditionsV2Schema, emptyConditions } from "@/lib/domain/conditions";
import release3 from "../../data/catalog-releases/3.json";
import { catalogV2CountryCodes, catalogV3CountryCodes, snapshotV10ProviderIds, conditionsV2SourceIds } from "@/lib/domain/contract-identities";
import { IngestionStateV13Schema, parseCatalogStateV13 as parseCatalogState } from "@/lib/domain/catalog-state";
import { createLegacyState as createEmptyState } from "../fixtures/legacy-state";

// Based on the V2 migration event in schemas.test.ts. Old timestamps deliberately
// prove this reader does not expire or renew accepted persisted evidence.
const timestamp = "2026-08-25T10:00:00Z";
const event = legacy.NormalizedEventV12Schema.parse({
  id: "legacy", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
  headline: "Earthquake reported nearby.", explanation: "A preliminary earthquake was reported nearby.",
  action: "Check official local advice.", affectedArea: "Vienna", geometry: { kind: "locations", ids: ["opaque retired destination"] },
  startsAt: "2026-08-25T09:00:00Z", endsAt: "2026-08-25T11:00:00Z", sourceUpdatedAt: "2026-08-25T09:00:00Z",
  checkedAt: timestamp, expiresAt: "2026-08-25T11:00:00Z", sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM",
});
function populatedState() {
  const state = createEmptyState(new Date(timestamp));
  state.events = [event];
  state.fingerprints = { "retired/arbitrary fingerprint": timestamp };
  state.candidates = [legacy.DiscoveryCandidateSchema.parse({
    providerId: "gdacs", externalId: "legacy-candidate", hazardType: "earthquake", geometry: { type: "Point", coordinates: [16, 48] },
    startsAt: event.startsAt, endsAt: event.endsAt, sourceUpdatedAt: timestamp, expiresAt: event.expiresAt, officialUrl: "https://gdacs.org/",
  })];
  state.conditions.locations["zz-retired-place"] = emptyConditions();
  state.conditions.attempts["opaque-legacy-attempt"] = timestamp;
  state.conditions.cacheUntil["opaque-legacy-cache"] = timestamp;
  state.conditions.reservations = [{ at: timestamp, weight: 400 }];
  state.conditions.cooldownUntil = timestamp;
  state.conditions.lease = { id: "123e4567-e89b-42d3-a456-426614174000", expiresAt: timestamp };
  state.conditions.health["open-meteo-weather"] = { checkedAt: timestamp, status: "ok", matched: 600, code: null };
  state.providerCoverage.usgs = { checkedAt: timestamp, checkedLocationIds: ["opaque retired destination"], unavailableLocationIds: [] };
  return legacy.IngestionStateV12Schema.parse(state);
}
const schemas = [legacy.IngestionStateV1Schema, legacy.IngestionStateV2Schema, legacy.IngestionStateV3Schema,
  legacy.IngestionStateV4Schema, legacy.IngestionStateV5Schema, legacy.IngestionStateV6Schema, legacy.IngestionStateV7Schema,
  legacy.IngestionStateV8Schema, legacy.IngestionStateV9Schema, legacy.IngestionStateV10Schema, legacy.IngestionStateV11Schema, legacy.IngestionStateV12Schema];

// Historical schemas choose their own identity sets; every fixture is validated
// against its actual wire schema before it is used as a migration input.
function fixture(version: number) {
  const schema = schemas[version - 1];
  const state = populatedState();
  const old = version === 11 ? legacy.downgradeIngestionStateV12(state) : state;
  const sourceNames = schema.shape.sources.keyType.options;
  const providerNames = "providers" in schema.shape ? schema.shape.providers.keyType.options : [];
  return schema.parse({ ...old, schemaVersion: version,
    sources: Object.fromEntries(sourceNames.map((id) => [id, state.sources[id as keyof typeof state.sources] || state.sources.meteoalarm])),
    providers: Object.fromEntries(providerNames.map((id) => [id, state.providers[id as keyof typeof state.providers] || state.providers.meteoalarm])),
    sourcePartitions: { ...state.sourcePartitions, bbk: {} },
  });
}
const ids = (count: number) => Array.from({ length: count }, (_, index) => `zz-place-${index}`);

function expectOnlyMigrationChanges(actual: ReturnType<typeof parseCatalogState>, prior: ReturnType<typeof legacy.parseIngestionState>) {
  const projected = structuredClone(actual);
  for (const partitions of [...Object.values(projected.sourcePartitions), ...Object.values(projected.partitionTransports)]) {
    expect(Object.keys(partitions).sort()).toEqual([...catalogV3CountryCodes].sort());
    for (const code of catalogV3CountryCodes) if (!(catalogV2CountryCodes as readonly string[]).includes(code)) delete partitions[code];
  }
  const { collection, ...body } = projected;
  expect(collection).toEqual({ catalogVersion: 2, revision: 0 });
  expect({ ...body, schemaVersion: 12 }).toEqual(prior);
}

describe("inactive catalog state reader", () => {
  it("uses exactly the frozen release3 countries without changing current legacy aliases", () => {
    const expected = [...new Set(release3.locationIds.map((id) => id.split("-")[0].toUpperCase()))].sort();
    expect([...catalogV3CountryCodes].sort()).toEqual(expected);
    expect(new Set(catalogV3CountryCodes).size).toBe(catalogV3CountryCodes.length);
    parseCatalogState(populatedState());
    expect(legacy.countryCodes).toEqual(catalogV2CountryCodes);
    expect(legacy.countryCodes).toHaveLength(28);
    expect(legacy.providerIds).toEqual(snapshotV10ProviderIds);
  });

  it("preserves actual cached forecasts, incidents, system conditions, earthquake identities, and transport evidence", () => {
    const input = populatedState();
    for (const country of ["FI", "PL"]) {
      const file = ConditionsV2Schema.parse(JSON.parse(readFileSync(`public/conditions/v2/${country}.json`, "utf8")));
      Object.assign(input.conditions.locations, file.locations);
    }
    expect(input.conditions.locations["fi-helsinki"].weather?.temperature.length).toBeGreaterThan(0);
    expect(input.conditions.locations["fi-helsinki"].infrastructureIncidents.length).toBeGreaterThan(0);
    expect(input.conditions.locations["pl-warsaw"].systemConditions.length).toBeGreaterThan(0);
    input.events[0] = { ...input.events[0], transportId: "legacy-transport", earthquake: { ids: ["us-old", "emsc-old"], coordinates: [16.37, 48.2], magnitude: 5.6 } };
    input.partitionTransports.meteoalarm.AT["legacy-transport"] = {
      ...input.sources.meteoalarm, status: "partial", lastAttempt: timestamp, lastSuccess: timestamp,
      sourceUpdatedAt: timestamp, error: "historical failure", consecutiveFailures: 2,
      checkedLocationIds: ["opaque retired destination"], unavailableLocationIds: ["other legacy destination"],
    };
    const accepted = legacy.IngestionStateV12Schema.parse(input);
    const migrated = parseCatalogState(accepted);
    expectOnlyMigrationChanges(migrated, accepted);
    expect(migrated.conditions).toEqual(accepted.conditions);
    expect(migrated.events).toEqual(accepted.events);
    expect(migrated.partitionTransports.meteoalarm.AT).toEqual(accepted.partitionTransports.meteoalarm.AT);
    // Mutating the returned reader value must not mutate the accepted input or
    // accidentally share a new country's health record with another country.
    migrated.conditions.locations["fi-helsinki"].weather!.temperature[0] = 65;
    migrated.sourcePartitions.meteoalarm.GB.itemCount = 1;
    expect(input).toEqual(accepted);
    expect(migrated.sourcePartitions.meteoalarm.IS.itemCount).toBe(0);
  });

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))("migrates valid V%i without changing accepted legacy content", (version) => {
    const input = fixture(version);
    const before = structuredClone(input);
    expectOnlyMigrationChanges(parseCatalogState(input), legacy.parseIngestionState(input));
    expect(input).toEqual(before);
  });

  it("adds exactly17 inactive countries and empty transports without granting new provider/source identities", () => {
    const state = parseCatalogState(populatedState());
    const additions = catalogV3CountryCodes.filter((code) => !(catalogV2CountryCodes as readonly string[]).includes(code));
    expect(additions).toHaveLength(17);
    expect(catalogV3CountryCodes).toHaveLength(45);
    expect(Object.keys(state.providers).sort()).toEqual([...snapshotV10ProviderIds].sort());
    expect(snapshotV10ProviderIds).toHaveLength(19);
    expect(conditionsV2SourceIds).toHaveLength(24);
    for (const code of additions) {
      for (const countries of Object.values(state.sourcePartitions)) expect(countries[code]).toMatchObject({ status: "not_monitored", itemCount: 0, lastAttempt: null, lastSuccess: null });
      for (const countries of Object.values(state.partitionTransports)) expect(countries[code]).toEqual({});
    }
  });

  it("preserves an existing V13 collection3 revision idempotently", () => {
    const input = parseCatalogState(populatedState());
    input.collection = { catalogVersion: 3, revision: Number.MAX_SAFE_INTEGER };
    expect(parseCatalogState(input)).toEqual(input);
    expect(parseCatalogState(parseCatalogState(input))).toEqual(input);
    expect(legacy.IngestionStateV12Schema.safeParse(input).success).toBe(false);
    expect(() => legacy.parseIngestionState(input)).toThrow();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null])("rejects invalid revision %s", (revision) => {
    const input = parseCatalogState(populatedState());
    Object.assign(input.collection, { revision });
    expect(IngestionStateV13Schema.safeParse(input).success).toBe(false);
  });

  it.each([1, 4, "3", null])("rejects unsupported collection %s", (catalogVersion) => {
    const input = parseCatalogState(populatedState());
    Object.assign(input.collection, { catalogVersion });
    expect(IngestionStateV13Schema.safeParse(input).success).toBe(false);
  });

  it.each([679, 680])("enforces expanded679 bounds at %i", (count) => {
    const base = parseCatalogState(populatedState());
    const valid = count === 679;
    const mutations: Array<(state: typeof base) => void> = [
      (s) => { s.conditions.locations = Object.fromEntries(ids(count).map((id) => [id, emptyConditions()])); },
      (s) => { s.conditions.cacheUntil = Object.fromEntries(ids(count).map((id) => [id, timestamp])); },
      (s) => { s.conditions.health["open-meteo-weather"]!.matched = count; },
      (s) => { s.providerCoverage.usgs!.checkedLocationIds = ids(count); },
      (s) => { s.providerCoverage.usgs = { checkedAt: timestamp, checkedLocationIds: [], unavailableLocationIds: ids(count) }; },
      (s) => { s.partitionTransports.meteoalarm.GB = { test: { ...s.sources.meteoalarm, checkedLocationIds: ids(count), unavailableLocationIds: [] } }; },
      (s) => { s.partitionTransports.meteoalarm.GB = { test: { ...s.sources.meteoalarm, checkedLocationIds: [], unavailableLocationIds: ids(count) } }; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const input = structuredClone(base); mutate(input);
      expect(IngestionStateV13Schema.safeParse(input).success, `bound ${index}`).toBe(valid);
    }
  });

  it("retains event country/source/provider/time and coverage disjointness refinements", () => {
    const base = parseCatalogState(populatedState());
    base.events[0].geometry = { kind: "regions", countryCode: "GB", codes: ["GB01"] };
    expect(IngestionStateV13Schema.safeParse(base).success).toBe(true);
    const mutations: Array<(state: typeof base) => void> = [
      (s) => { Object.assign(s.events[0].geometry, { countryCode: "ZZ" }); },
      (s) => { Object.assign(s.events[0], { sourceId: "future-source" }); },
      (s) => { s.events[0].providerId = "emsc"; },
      (s) => { s.events[0].endsAt = s.events[0].startsAt; },
      (s) => { s.providerCoverage.usgs!.unavailableLocationIds = [...s.providerCoverage.usgs!.checkedLocationIds]; },
      (s) => { Object.assign(s.sourcePartitions.meteoalarm, { ZZ: s.sources.meteoalarm }); },
      (s) => { Object.assign(s.conditions.health, { "future-condition": s.conditions.health["open-meteo-weather"] }); },
      (s) => { Object.assign(s.providers, { "future-provider": s.providers.usgs }); },
    ];
    for (const mutate of mutations) { const input = structuredClone(base); mutate(input); expect(IngestionStateV13Schema.safeParse(input).success).toBe(false); }
  });

  it("preserves unexpanded quota, lease, transport, attempt, and candidate bounds", () => {
    const base = parseCatalogState(populatedState());
    const mutations: Array<(state: typeof base) => void> = [
      (s) => { s.conditions.reservations[0].weight = 401; },
      (s) => { s.conditions.lease!.id = "not-a-uuid"; },
      (s) => { s.conditions.attempts = Object.fromEntries(ids(4001).map((id) => [id, timestamp])); },
      (s) => { s.candidates = Array.from({ length: 401 }, () => s.candidates[0]); },
      (s) => { s.partitionTransports.meteoalarm.GB = Object.fromEntries(ids(5).map((id) => [id, { ...s.sources.meteoalarm, checkedLocationIds: [], unavailableLocationIds: [] }])); },
    ];
    for (const mutate of mutations) { const input = structuredClone(base); mutate(input); expect(IngestionStateV13Schema.safeParse(input).success).toBe(false); }
  });
});
