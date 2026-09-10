import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
import candidates from "../../data/review-inputs/europe-expansion-catalog.json";
import { locationCoveragePresentation } from "@/lib/coverage-presentation";
import { initialSafetyDataState, safetyDataReducer } from "@/lib/safety-data-state";
import { SnapshotV11Schema, ConditionsV3Schema, PublicCatalogV3Schema, parseCatalogSnapshot, catalogLocationState } from "@/lib/domain/catalog-public";
import { SnapshotV10Schema, PublicLocationSchema, parseSnapshot } from "@/lib/domain/schemas";
import ipmaObservationFixture from "../fixtures/conditions/ipma-observations.json";
import { parseIpmaObservations } from "@/lib/conditions/ipma";
import { conditionAttribution } from "@/lib/conditions/sources";
import { ConditionsV2Schema, emptyConditions } from "@/lib/domain/conditions";

const legacy = SnapshotV10Schema.parse(JSON.parse(readFileSync("public/demo-snapshot.json", "utf8")));
const countries = [...new Set(release3.locationIds.map((id) => id.slice(0, 2).toUpperCase()))].sort();
const addedIds = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
const partitioned = ["meteoalarm", "eea-aqi", "national-civil-alerts"] as const;
function snapshot3() {
  const providers = structuredClone(legacy.providers);
  for (const id of partitioned) providers[id].partitions = Object.fromEntries(countries.map((code) => [code,
    structuredClone(providers[id].partitions!.AT)])) as typeof providers[typeof id]["partitions"];
  return { ...structuredClone(legacy), schemaVersion: 11, catalogVersion: 3, providers,
    locations: { ...structuredClone(legacy.locations), ...Object.fromEntries(addedIds.map((id) => [id, { level: "UNKNOWN" as const, coverage: "partial" as const, coverageGaps: [], delayedHazards: [], hazards: [] }])) } };
}
function conditions3(countryCode = "AT") {
  const legacyCountry = release2.locationIds.some((id) => id.startsWith(`${countryCode.toLowerCase()}-`));
  const file = ConditionsV2Schema.parse(JSON.parse(readFileSync(`public/conditions/v2/${legacyCountry ? countryCode : "AT"}.json`, "utf8")));
  return { ...file, schemaVersion: 3, catalogVersion: 3, countryCode,
    locations: Object.fromEntries(release3.locationIds.filter((id) => id.startsWith(`${countryCode.toLowerCase()}-`)).map((id) => [id, legacyCountry ? file.locations[id] : emptyConditions()])) };
}
function catalog3() {
  return [...JSON.parse(readFileSync("public/locations.json", "utf8")), ...candidates.locations];
}

describe("catalog3 public snapshot contract", () => {
  it("accepts exact679 identities,19 providers and45 partitions without rewriting legacy evidence", () => {
    const input = snapshot3(); const parsed = SnapshotV11Schema.parse(input);
    expect(Object.keys(parsed.locations).sort()).toEqual([...release3.locationIds].sort());
    expect(Object.keys(parsed.providers)).toHaveLength(19);
    expect(countries).toHaveLength(45);
    for (const id of partitioned) expect(Object.keys(parsed.providers[id].partitions!).sort()).toEqual(countries);
    for (const id of release2.locationIds) expect(parsed.locations[id]).toEqual(legacy.locations[id]);
    expect(parseCatalogSnapshot(input)).toEqual(parsed);
    expect(() => SnapshotV10Schema.parse(input)).toThrow(); expect(() => parseSnapshot(input)).toThrow();
  });

  it.each(["missing", "extra", "same-count substitute"])("rejects %s snapshot membership", (mode) => {
    const input = snapshot3(); const id = release3.locationIds[0];
    if (mode !== "missing") input.locations["gb-unreviewed"] = input.locations[id];
    if (mode !== "extra") delete input.locations[id];
    if (mode === "same-count substitute") expect(Object.keys(input.locations)).toHaveLength(679);
    expect(() => SnapshotV11Schema.parse(input)).toThrow();
  });

  it.each(["missing provider", "unknown provider", "missing country", "unknown country", "missing partition", "unexpected partition"])("rejects %s", (mode) => {
    const input = snapshot3();
    if (mode === "missing provider") Reflect.deleteProperty(input.providers, "usgs");
    if (mode === "unknown provider") Object.assign(input.providers, { future: input.providers.usgs });
    if (mode === "missing country") Reflect.deleteProperty(input.providers.meteoalarm.partitions!, "GB");
    if (mode === "unknown country") Object.assign(input.providers.meteoalarm.partitions!, { ZZ: input.providers.meteoalarm.partitions!.AT });
    if (mode === "missing partition") delete input.providers.meteoalarm.partitions;
    if (mode === "unexpected partition") input.providers.usgs.partitions = input.providers.meteoalarm.partitions;
    expect(() => SnapshotV11Schema.parse(input)).toThrow();
  });

  it("retains leading-hazard level and timing refinements", () => {
    const input = snapshot3(); const id = Object.keys(input.locations).find((id) => input.locations[id].hazards.length)!;
    expect(id).toBeTruthy();
    const existing = input.locations[id];
    expect(() => SnapshotV11Schema.parse({ ...input, locations: { ...input.locations, [id]: { ...existing, level: existing.level === "SEVERE" ? "ELEVATED" : "SEVERE" } } })).toThrow();
    expect(() => SnapshotV11Schema.parse({ ...input, locations: { ...input.locations, [id]: { ...existing, timing: existing.hazards[0].timing === "ACTIVE" ? "FORECAST" : "ACTIVE" } } })).toThrow();
  });

  it("preserves actual V10 identity and evidence while all176 missing additions remain unknown and pending", () => {
    const parsed = parseCatalogSnapshot(legacy);
    expect(parsed).toEqual(legacy); expect(parsed.schemaVersion).toBe(10); expect(parsed.catalogVersion).toBe(2);
    expect(Object.keys(parsed.locations)).toHaveLength(503); expect(addedIds).toHaveLength(176);
    for (const id of addedIds) expect(catalogLocationState(parsed, id)).toEqual({ updatePending: true,
      state: { level: "UNKNOWN", coverage: "partial", coverageGaps: [], delayedHazards: [], hazards: [] } });
    for (const id of release2.locationIds) expect(catalogLocationState(parsed, id)).toEqual({ state: legacy.locations[id], updatePending: false });
    expect(catalogLocationState(null, "gb-london").updatePending).toBe(true);
    const fresh = SnapshotV11Schema.parse(snapshot3());
    expect(catalogLocationState(fresh, "gb-london").updatePending).toBe(false);
  });

  it("keeps missing new destinations pending through refresh loading and failure while retaining old evidence", () => {
    const loaded = safetyDataReducer(initialSafetyDataState, { type: "snapshot-ready", request: 1,
      snapshot: parseCatalogSnapshot(legacy), receivedAt: Date.parse(legacy.generatedAt) });
    const loading = safetyDataReducer(loaded, { type: "snapshot-loading", request: 2 });
    const failed = safetyDataReducer(loading, { type: "snapshot-failed", request: 2 });
    for (const value of [loaded, loading, failed]) {
      expect(value.snapshot).toEqual(legacy);
      for (const id of addedIds) {
        const result = catalogLocationState(value.snapshot, id);
        expect(result.updatePending).toBe(true); expect(result.state.level).toBe("UNKNOWN"); expect(result.state.hazards).toEqual([]);
      }
    }
    expect(failed.snapshotError).toMatch(/Previously loaded alerts remain visible/);
  });

  it("does not claim freshness or fully checked coverage for new countries from healthy legacy provider aggregates", () => {
    const snapshot = structuredClone(legacy);
    for (const provider of Object.values(snapshot.providers)) {
      provider.status = "ok"; provider.lastSuccess = snapshot.generatedAt; provider.sourceUpdatedAt = snapshot.generatedAt;
      provider.nextExpectedUpdate = new Date(Date.parse(snapshot.generatedAt) + 3600000).toISOString();
    }
    const roster = PublicCatalogV3Schema.parse(catalog3());
    for (const countryCode of [...new Set(addedIds.map((id) => id.slice(0, 2).toUpperCase()))]) {
      const location = roster.find((location) => location.countryCode === countryCode)!;
      const state = catalogLocationState(snapshot, location.id).state;
      const result = locationCoveragePresentation({ location, state, snapshot, now: new Date(snapshot.generatedAt) });
      expect(result.freshness.status).toBe("unavailable");
      expect(result.counts.available).toBe(0); expect(result.fullyChecked).toEqual([]);
      expect(result.contextProviders.every((provider) => provider.updateLabel === null && provider.status !== "available")).toBe(true);
      const subchecks = result.categories.flatMap(({ subchecks }) => subchecks);
      const earthquake = subchecks.find(({ hazard }) => hazard === "earthquake")!;
      expect(earthquake.coverageStatus).not.toBe("not_monitored"); expect(earthquake.freshnessStatus).toBe("delayed");
      expect(subchecks.filter(({ hazard }) => hazard !== "earthquake" && !(location.id === "li-malbun" && hazard === "avalanche"))
        .every(({ coverageStatus }) => coverageStatus === "not_monitored")).toBe(true);
    }
  });

  it("rejects a same-count legacy ID substitution and mismatched wire versions", () => {
    const value = structuredClone(legacy); value.locations["gb-london"] = value.locations[release2.locationIds[0]]; delete value.locations[release2.locationIds[0]];
    expect(() => parseCatalogSnapshot(value)).toThrow();
    expect(() => parseCatalogSnapshot({ ...legacy, catalogVersion: 3 })).toThrow();
    expect(() => parseCatalogSnapshot({ ...snapshot3(), catalogVersion: 2 })).toThrow();
  });
});

describe("catalog3 country conditions contract", () => {
  it("accepts every exact country roster and preserves real legacy payloads", () => {
    for (const code of countries) {
      const file = conditions3(code); const parsed = ConditionsV3Schema.parse(file);
      expect(Object.keys(parsed.locations).sort()).toEqual(release3.locationIds.filter((id) => id.startsWith(`${code.toLowerCase()}-`)).sort());
      expect(parsed).toEqual(file);
    }
    expect(() => ConditionsV2Schema.parse(conditions3())).toThrow();
  });

  it.each(["missing", "extra", "same-count substitute", "wrong country", "unknown country"])("rejects %s country membership", (mode) => {
    const file = conditions3("GB"); const id = Object.keys(file.locations)[0];
    if (mode === "missing" || mode === "same-count substitute") delete file.locations[id];
    if (mode === "extra" || mode === "same-count substitute") file.locations["gb-unreviewed"] = emptyConditions();
    if (mode === "wrong country") file.locations["at-vienna"] = emptyConditions();
    if (mode === "unknown country") file.countryCode = "ZZ";
    expect(() => ConditionsV3Schema.parse(file)).toThrow();
  });

  it.each(["missing attribution", "unknown source", "expiry", "future checked", "future source", "misaligned series", "forecast horizon", "wrong country source"])("preserves %s refinement", (mode) => {
    const file = conditions3(); const weather = file.locations["at-vienna"].weather!;
    expect(weather).toBeTruthy();
    if (mode === "missing attribution") delete file.sources[weather.sourceId];
    if (mode === "unknown source") Object.assign(file.sources, { future: file.sources[weather.sourceId] });
    if (mode === "expiry") weather.expiresAt = weather.checkedAt;
    if (mode === "future checked") weather.checkedAt = "2099-01-01T00:00:00Z";
    if (mode === "future source") weather.sourceUpdatedAt = "2099-01-01T00:00:00Z";
    if (mode === "misaligned series") weather.temperature.pop();
    if (mode === "forecast horizon") weather.startAt = "2099-01-01T00:00:00Z";
    if (mode === "wrong country source") {
      const observation = parseIpmaObservations(ipmaObservationFixture, new Date("2026-08-31T17:45:00Z")).get("pt-lisbon")!;
      expect(observation).toBeTruthy();
      // Use a valid empty country file at the observation's clock, so country applicability is the failing invariant.
      file.generatedAt = observation.checkedAt;
      file.locations = Object.fromEntries(Object.keys(file.locations).map((id) => [id, emptyConditions()]));
      file.locations["at-vienna"].observations = [observation]; file.sources["ipma-observations"] = conditionAttribution("ipma-observations");
      const control = { ...file, countryCode: "PT", locations: { "pt-lisbon": file.locations["at-vienna"] } };
      expect(ConditionsV2Schema.safeParse({ ...control, schemaVersion: 2, catalogVersion: 2 }).success).toBe(true);
    }
    expect(() => ConditionsV3Schema.parse(file)).toThrow();
  });
});

describe("catalog3 public roster", () => {
  it("accepts the reviewed679 roster with local-area scope labels while legacy countries remain frozen", () => {
    const parsed = PublicCatalogV3Schema.parse(catalog3());
    expect(parsed.map(({ id }) => id).sort()).toEqual([...release3.locationIds].sort());
    const scoped = candidates.locations.filter((location) => "scope" in location);
    expect(scoped.length).toBeGreaterThan(0);
    for (const location of scoped) expect(parsed.find(({ id }) => id === location.id)).toMatchObject({ scope: location.scope, scopeNote: location.scopeNote });
    expect(() => PublicLocationSchema.parse(parsed.find(({ id }) => id === "gb-london"))).toThrow();
  });

  it("requires reviewed scope labels for newly added local-area entries", () => {
    const input = PublicCatalogV3Schema.parse(catalog3());
    const location = input.find((location) => addedIds.includes(location.id) && location.scope === "local-area")!;
    expect(location).toBeTruthy(); delete location.scope; delete location.scopeNote;
    expect(() => PublicCatalogV3Schema.parse(input)).toThrow();
  });

  it.each(["missing", "duplicate", "same-count substitute", "country mismatch", "scope only", "note only"])("rejects %s roster entries", (mode) => {
    const input = PublicCatalogV3Schema.parse(catalog3());
    if (mode === "missing") input.pop();
    if (mode === "duplicate") input[input.length - 1] = input[0];
    if (mode === "same-count substitute") input[0].id = "ad-unreviewed";
    if (mode === "country mismatch") input[0].countryCode = input[0].countryCode === "GB" ? "AT" : "GB";
    if (mode === "scope only") { input[0].scope = "local-area"; delete input[0].scopeNote; }
    if (mode === "note only") { input[0].scopeNote = "A local radius."; delete input[0].scope; }
    expect(() => PublicCatalogV3Schema.parse(input)).toThrow();
  });
});
