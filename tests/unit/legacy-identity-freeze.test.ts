import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLegacyState as createEmptyState } from "../fixtures/legacy-state";
import { downgradeIngestionStateV12, NormalizedEventV12Schema, parseIngestionState, parseSnapshot } from "@/lib/domain/schemas";
import { ConditionsV2Schema } from "@/lib/domain/conditions";

const snapshot = JSON.parse(readFileSync("public/demo-snapshot.json", "utf8"));
const state = createEmptyState(new Date("2026-09-08T12:00:00Z"));
const parsedSnapshot = parseSnapshot(snapshot);
const parsedState = parseIngestionState(state);
const conditions = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/AT.json", "utf8")));
const event = NormalizedEventV12Schema.parse({
  id: "legacy-weather", sourceId: "meteoalarm", providerId: "meteoalarm", type: "severe-weather", level: "HIGH", timing: "ACTIVE",
  headline: "Severe weather", explanation: "Official warning retained", action: "Check official updates", affectedArea: "Austria",
  geometry: { kind: "regions", countryCode: "AT", codes: ["AT001"] },
  startsAt: "2026-09-08T11:00:00Z", endsAt: "2026-09-08T18:00:00Z", sourceUpdatedAt: state.updatedAt,
  checkedAt: state.updatedAt, expiresAt: "2026-09-08T18:00:00Z", sourceName: "Meteoalarm", sourceUrl: "https://meteoalarm.org/", confidence: "HIGH",
});

async function withProspectiveIdentities() {
  vi.resetModules();
  vi.doMock("@/lib/domain/contract-identities", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/lib/domain/contract-identities")>();
    return { ...original,
      countryCodes: [...original.countryCodes, "GB"],
      sourceIds: [...original.sourceIds, "future-source"],
      providerIds: [...original.providerIds, "future-provider"],
      conditionSourceIds: [...original.conditionSourceIds, "future-condition"],
    };
  });
  return import("@/lib/domain/schemas");
}

afterEach(() => { vi.doUnmock("@/lib/domain/contract-identities"); vi.doUnmock("@/lib/data"); vi.resetModules(); });

describe("legacy identity boundaries", () => {
  it("preserves snapshot10 and state12 when current identities expand", async () => {
    const future = await withProspectiveIdentities();
    expect(future.CountryCodeSchema.parse("GB")).toBe("GB");
    expect(future.ProviderIdSchema.parse("future-provider")).toBe("future-provider");
    expect(future.parseSnapshot(snapshot)).toEqual(parsedSnapshot);
    expect(future.parseIngestionState(state)).toEqual(parsedState);
  });

  it("rejects prospective identities nested inside old public and private records", async () => {
    const future = await withProspectiveIdentities();
    const extraCountry = structuredClone(snapshot);
    extraCountry.providers.meteoalarm.partitions.GB = extraCountry.providers.meteoalarm.partitions.AT;
    expect(future.SnapshotV10Schema.safeParse(extraCountry).success).toBe(false);
    const extraEvidence = structuredClone(snapshot);
    const alert = Object.values(extraEvidence.locations).find((value) => (value as { hazards: unknown[] }).hazards.length) as { hazards: { evidence: { providerId: string }[] }[] };
    alert.hazards[0].evidence[0].providerId = "future-provider";
    expect(future.SnapshotV10Schema.safeParse(extraEvidence).success).toBe(false);
    const extraTransport = structuredClone(state) as unknown as { partitionTransports: { meteoalarm: Record<string, unknown> } };
    extraTransport.partitionTransports.meteoalarm.GB = {};
    expect(future.IngestionStateV12Schema.safeParse(extraTransport).success).toBe(false);
  });

  it("keeps legacy500-key parsing separate from exact release2 publication membership", async () => {
    const future = await withProspectiveIdentities();
    const legacy = { ...snapshot, schemaVersion: 9, locations: Object.fromEntries(
      Object.values(snapshot.locations).slice(0, 500).map((value, index) => [`legacy-${index}`, value]),
    ) };
    expect(future.SnapshotV9Schema.safeParse(legacy).success).toBe(true);
    const upgraded = future.parseSnapshot(legacy);
    expect(Object.keys(upgraded.locations)).toHaveLength(503);
    const { CompleteSnapshotSchema } = await import("@/lib/snapshot-validation");
    expect(CompleteSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(CompleteSnapshotSchema.safeParse(upgraded).success).toBe(false);
  });

  it.each(["country", "source", "provider"] as const)("rejects a prospective %s inside an otherwise valid private event", async (identity) => {
    const future = await withProspectiveIdentities();
    const valid = { ...structuredClone(state), events: [structuredClone(event)] };
    expect(future.parseIngestionState(valid).events).toEqual([event]);
    const invalid = structuredClone(valid);
    if (identity === "country") Object.assign(invalid.events[0].geometry, { countryCode: "GB" });
    else Object.assign(invalid.events[0], identity === "source" ? { sourceId: "future-source" } : { providerId: "future-provider" });
    expect(future.IngestionStateV12Schema.safeParse(invalid).success).toBe(false);
  });

  it("retains legacy conditions and rejects prospective sources in records and private health", async () => {
    const populated = structuredClone(state);
    populated.conditions.locations = structuredClone(conditions.locations);
    populated.conditions.health["open-meteo-weather"] = { checkedAt: state.updatedAt, status: "ok", matched: 1, code: null };
    const expected = parseIngestionState(populated);
    const future = await withProspectiveIdentities();
    expect(future.parseIngestionState(populated)).toEqual(expected);
    const futureConditions = await import("@/lib/domain/conditions");
    expect(futureConditions.ConditionsV2Schema.parse(conditions)).toEqual(conditions);
    const invalidPublic = structuredClone(conditions);
    Object.assign(invalidPublic.sources, { "future-condition": conditions.sources["open-meteo-weather"] });
    expect(futureConditions.ConditionsV2Schema.safeParse(invalidPublic).success).toBe(false);
    const invalidRecord = structuredClone(populated);
    const weather = Object.values(invalidRecord.conditions.locations).find((value) => value.weather)!.weather!;
    Object.assign(weather, { sourceId: "future-condition" });
    expect(future.IngestionStateV12Schema.safeParse(invalidRecord).success).toBe(false);
    const invalidHealth = structuredClone(populated);
    Object.assign(invalidHealth.conditions.health, { "future-condition": populated.conditions.health["open-meteo-weather"] });
    expect(future.IngestionStateV12Schema.safeParse(invalidHealth).success).toBe(false);
  });

  it("migrates old state without losing events, health, fingerprints, or adding prospective partitions", async () => {
    const sourceHealth = { ...state.sources.meteoalarm, status: "ok", lastSuccess: state.updatedAt, itemCount: 1 };
    const legacy = {
      schemaVersion: 1, updatedAt: state.updatedAt, events: [{ ...event, providerId: undefined }],
      sources: Object.fromEntries(["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].map((id) => [id, sourceHealth])),
      fingerprints: { "legacy-weather": state.updatedAt },
    };
    const expected = parseIngestionState(legacy);
    const future = await withProspectiveIdentities();
    const migrated = future.parseIngestionState(legacy);
    expect(migrated).toEqual(expected);
    expect(migrated.events).toEqual([event]);
    expect(migrated.fingerprints).toEqual(legacy.fingerprints);
    expect(migrated.sources.meteoalarm).toEqual(sourceHealth);
    for (const partitions of [...Object.values(migrated.sourcePartitions), ...Object.values(migrated.partitionTransports)]) {
      expect(Object.keys(partitions).sort()).toEqual(Object.keys(state.sourcePartitions.meteoalarm).sort());
      expect(Object.keys(partitions)).toHaveLength(28);
    }
    expect(migrated.providers).not.toHaveProperty("future-provider");
  });

  it("preserves populated conditions and quota controls across state11 migration under prospective identities", async () => {
    const populated = structuredClone(state);
    populated.events = [event];
    populated.conditions.locations = structuredClone(conditions.locations);
    populated.conditions.reservations = [{ at: state.updatedAt, weight: 400 }];
    populated.conditions.attempts = { "weather:at-vienna": state.updatedAt };
    populated.conditions.cooldownUntil = "2026-09-08T13:00:00Z";
    const legacy = downgradeIngestionStateV12(populated);
    const expected = parseIngestionState(legacy);
    const future = await withProspectiveIdentities();
    expect(future.parseIngestionState(legacy)).toEqual(expected);
    expect(expected.conditions.locations).toEqual(populated.conditions.locations);
    expect(expected.conditions.reservations).toEqual(populated.conditions.reservations);
    expect(expected.conditions.attempts).toEqual(populated.conditions.attempts);
    expect(expected.conditions.cooldownUntil).toBe(populated.conditions.cooldownUntil);
  });

  it("validates exact snapshot10 membership independently of the active catalog", async () => {
    await withProspectiveIdentities();
    vi.doMock("@/lib/data", () => ({ locations: [{ id: "gb-london" }] }));
    const { CompleteSnapshotV10Schema } = await import("@/lib/snapshot-validation");
    expect(CompleteSnapshotV10Schema.safeParse(snapshot).success).toBe(true);
    const swapped = structuredClone(snapshot);
    const id = Object.keys(swapped.locations)[0];
    swapped.locations["gb-london"] = swapped.locations[id];
    delete swapped.locations[id];
    expect(Object.keys(swapped.locations)).toHaveLength(503);
    expect(CompleteSnapshotV10Schema.safeParse(swapped).success).toBe(false);
  });
});
