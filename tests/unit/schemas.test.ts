import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CoverageMatrixSchema, HazardTypeSchema, IngestionStateSchema, LocationSchema, NormalizedEventSchema, PartitionedSourceResultSchema, SnapshotSchema, SourceResultSchema, parseIngestionState, parseSnapshot } from "@/lib/domain/schemas";
import { createLegacyState as createEmptyState } from "../fixtures/legacy-state";
import { CompleteSnapshotSchema } from "@/lib/snapshot-validation";
import { locations } from "@/lib/data";
import { locationCoveragePresentation } from "@/lib/coverage-presentation";

function withoutProvider<T extends { providerId?: unknown }>(value: T): Omit<T, "providerId"> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "providerId")) as Omit<T, "providerId">;
}

const legacyHealth = {
  status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null,
  nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: null,
} as const;
const legacyPublicProvider = {
  mode: "disabled", status: "disabled", lastSuccess: null, sourceUpdatedAt: null,
  nextExpectedUpdate: null, limitationCode: "not_enabled",
} as const;

const contextProviderIds = new Set(["eonet", "edo-drought", "fcdo-travel-advice"]);
const catalogV2LocationIds = ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"];

function removeContextHazards<T extends { locations: Record<string, { level: string; coverage: unknown; coverageGaps: unknown; hazards: Array<{ providerId?: string }> }> }>(snapshot: T): T {
  for (const id of catalogV2LocationIds) delete snapshot.locations[id];
  for (const [id, state] of Object.entries(snapshot.locations)) {
    const hazards = state.hazards.filter((hazard) => !contextProviderIds.has(String(hazard.providerId)));
    if (hazards.length === 0 && state.level !== "NORMAL" && state.level !== "UNKNOWN") {
      snapshot.locations[id] = { level: "NORMAL", coverage: state.coverage, coverageGaps: state.coverageGaps, hazards: [] } as typeof state;
    } else {
      state.hazards = hazards;
    }
  }
  return snapshot;
}

function addRemovedSnapshotProviders<T extends { providers: Record<string, unknown> }>(snapshot: T): T {
  if ("locations" in snapshot) removeContextHazards(snapshot as T & { locations: Record<string, { level: string; coverage: unknown; coverageGaps: unknown; hazards: Array<{ providerId?: string }> }> });
  delete snapshot.providers.eonet;
  delete snapshot.providers["edo-drought"];
  delete snapshot.providers["fcdo-travel-advice"];
  snapshot.providers["bbk-mowas"] = structuredClone(legacyPublicProvider);
  snapshot.providers.eurdep = structuredClone(legacyPublicProvider);
  return snapshot;
}

function addRemovedStateProviders(state: Record<string, unknown>) {
  const sources = state.sources as Record<string, unknown>;
  const providers = state.providers as Record<string, unknown>;
  for (const id of ["eonet", "edo-drought", "fcdo-travel-advice"]) {
    delete sources[id];
    delete providers[id];
  }
  sources["bbk-mowas"] = structuredClone(legacyHealth);
  sources.eurdep = structuredClone(legacyHealth);
  providers["bbk-mowas"] = structuredClone(legacyHealth);
  providers.eurdep = structuredClone(legacyHealth);
}

describe("published contracts", () => {
  it("validates all committed locations", async () => {
    const locations = JSON.parse(await readFile("data/locations.json", "utf8"));
    expect(LocationSchema.array().parse(locations)).toHaveLength(503);
  });

  it("validates the demo snapshot", async () => {
    const snapshot = CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    expect(Object.keys(snapshot.locations)).toHaveLength(503);
    expect(snapshot.providers.meteoalarm.partitions && Object.keys(snapshot.providers.meteoalarm.partitions)).toHaveLength(28);
    expect(snapshot.providers["national-civil-alerts"].status).toBe("ok");
    expect(snapshot.providers["national-civil-alerts"].partitions?.SE).toMatchObject({ status: "ok", limitationCode: null });
    expect(snapshot.providers["eea-aqi"].partitions?.AT.nextExpectedUpdate).toBe("2026-08-25T13:00:00.000Z");
  });

  it("upgrades Snapshot V9 and state V9 to V10 without inventing live Azores results", async () => {
    const current = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const legacySnapshot = { ...current, schemaVersion: 9 as const } as Record<string, unknown>;
    delete legacySnapshot.catalogVersion;
    const legacyLocations = legacySnapshot.locations as Record<string, unknown>;
    for (const id of ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"]) delete legacyLocations[id];
    const upgraded = parseSnapshot(legacySnapshot);
    expect(upgraded).toMatchObject({ schemaVersion: 10, catalogVersion: 2 });
    expect(upgraded.locations["pt-horta"]).toMatchObject({ level: "UNKNOWN", delayedHazards: [...HazardTypeSchema.options] });
    for (const id of catalogV2LocationIds) {
      const location = locations.find((candidate) => candidate.id === id)!;
      const presentation = locationCoveragePresentation({ location, state: upgraded.locations[id], snapshot: upgraded, now: new Date(upgraded.generatedAt) });
      expect(presentation.categories.flatMap(({ subchecks }) => subchecks).every(({ freshnessStatus }) => freshnessStatus === "delayed")).toBe(true);
    }

    const currentState = createEmptyState(new Date("2026-08-30T10:00:00Z"));
    const legacyState = { ...currentState, schemaVersion: 9 as const } as Record<string, unknown>;
    delete legacyState.partitionTransports;
    const upgradedState = parseIngestionState(legacyState);
    expect(upgradedState).toMatchObject({ schemaVersion: 12, partitionTransports: { meteoalarm: {}, nationalCivilAlerts: {}, eea: {} } });
  });

  it("requires all partitioned providers in the current snapshot", async () => {
    const snapshot = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    Reflect.deleteProperty(snapshot.providers.meteoalarm, "partitions");
    expect(() => SnapshotSchema.parse(snapshot)).toThrow(/must publish all covered countries/);
  });

  it("upgrades an existing Snapshot V2 to the current snapshot", async () => {
    const current = addRemovedSnapshotProviders(structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")))) as unknown as {
      schemaVersion: number;
      providers: Record<string, { partitions?: Record<string, Record<string, unknown>> }>;
    });
    current.schemaVersion = 2;
    Reflect.deleteProperty(current.providers, "national-civil-alerts");
    Reflect.deleteProperty(current.providers, "vigicrues");
    Reflect.deleteProperty(current.providers, "foen-flood");
    Reflect.deleteProperty(current.providers, "ehyd-flood");
    Reflect.deleteProperty(current.providers["eea-aqi"], "partitions");
    for (const partition of Object.values(current.providers.meteoalarm.partitions || {})) Reflect.deleteProperty(partition, "limitationCode");

    const upgraded = parseSnapshot(current);
    expect(upgraded.schemaVersion).toBe(10);
    expect(Object.keys(upgraded.providers.meteoalarm.partitions || {})).toHaveLength(28);
    expect(Object.keys(upgraded.providers["eea-aqi"].partitions || {})).toHaveLength(28);
    expect(Object.values(upgraded.providers["national-civil-alerts"].partitions || {}).every(({ status }) => status === "disabled")).toBe(true);
  });

  it("keeps old Snapshot V3 clients readable across the V4 provider cutover", async () => {
    const legacy = addRemovedSnapshotProviders(structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")))) as unknown as {
      schemaVersion: number; providers: Record<string, unknown>;
    });
    legacy.schemaVersion = 3;
    delete legacy.providers.vigicrues;
    delete legacy.providers["foen-flood"];
    delete legacy.providers["ehyd-flood"];
    const upgraded = parseSnapshot(legacy);
    expect(upgraded.schemaVersion).toBe(10);
    expect(upgraded.providers.vigicrues).toMatchObject({ status: "disabled", limitationCode: "not_yet_checked" });
    expect(upgraded.providers["foen-flood"]).toMatchObject({ status: "disabled", limitationCode: "not_yet_checked" });
    expect(upgraded.providers["ehyd-flood"]).toMatchObject({ status: "disabled", limitationCode: "not_yet_checked" });
  });

  it("adds eHYD conservatively while migrating Snapshot V4 to V5", async () => {
    const legacy = addRemovedSnapshotProviders(structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")))) as unknown as {
      schemaVersion: number; providers: Record<string, unknown>;
    });
    legacy.schemaVersion = 4;
    delete legacy.providers["ehyd-flood"];
    const upgraded = parseSnapshot(legacy);
    expect(upgraded.schemaVersion).toBe(10);
    expect(upgraded.providers["ehyd-flood"]).toMatchObject({ status: "disabled", limitationCode: "not_yet_checked" });
  });

  it("migrates Snapshot V6 to V7 with disabled context providers", async () => {
    const legacy = removeContextHazards(structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))))) as unknown as {
      schemaVersion: number; providers: Record<string, unknown>; locations: Record<string, { level: string; coverage: unknown; coverageGaps: unknown; hazards: Array<{ providerId?: string }> }>;
    };
    legacy.schemaVersion = 6;
    delete legacy.providers.eonet;
    delete legacy.providers["edo-drought"];
    delete legacy.providers["fcdo-travel-advice"];
    const upgraded = parseSnapshot(legacy);
    expect(upgraded.schemaVersion).toBe(10);
    expect(upgraded.providers.eonet).toMatchObject({ status: "disabled", limitationCode: "not_available_in_snapshot_v6" });
    expect(upgraded.providers["edo-drought"]).toMatchObject({ status: "disabled" });
    expect(upgraded.providers["fcdo-travel-advice"]).toMatchObject({ status: "disabled" });
  });

  it("rejects invalid or misplaced public provider partitions", async () => {
    const snapshot = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const partitions = snapshot.providers.meteoalarm.partitions!;
    const invalidCountry = structuredClone(snapshot) as unknown as { providers: { meteoalarm: { partitions: Record<string, unknown> } } };
    invalidCountry.providers.meteoalarm.partitions.NO = structuredClone(partitions.AT);
    expect(() => SnapshotSchema.parse(invalidCountry)).toThrow();

    const missingCountry = structuredClone(snapshot) as unknown as { providers: { meteoalarm: { partitions: Record<string, unknown> } } };
    Reflect.deleteProperty(missingCountry.providers.meteoalarm.partitions, "AT");
    expect(() => SnapshotSchema.parse(missingCountry)).toThrow();

    const misplaced = structuredClone(snapshot) as unknown as { providers: { usgs: { partitions: unknown } } };
    misplaced.providers.usgs.partitions = structuredClone(partitions);
    expect(() => SnapshotSchema.parse(misplaced)).toThrow(/does not support country partitions/);

    const privatePartitionField = structuredClone(snapshot) as unknown as {
      providers: { meteoalarm: { partitions: Record<string, Record<string, unknown>> } };
    };
    privatePartitionField.providers.meteoalarm.partitions.AT.error = "private upstream failure";
    expect(() => SnapshotSchema.parse(privatePartitionField)).toThrow(/Unrecognized key/);

    const privateProviderField = structuredClone(snapshot) as unknown as {
      providers: { meteoalarm: Record<string, unknown> };
    };
    privateProviderField.providers.meteoalarm.itemCount = 28;
    expect(() => SnapshotSchema.parse(privateProviderField)).toThrow(/Unrecognized key/);
    expect(JSON.stringify(partitions)).not.toMatch(/error|itemCount|fingerprint/i);
  });

  it("upgrades Snapshot V1 alerts without requiring the V2 provider field", async () => {
    const current = removeContextHazards(structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")))));
    const sources = Object.fromEntries(Object.entries(createEmptyState(new Date(current.generatedAt)).sources)
      .filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id)));
    sources.eurdep = structuredClone(legacyHealth);
    const locations = Object.fromEntries(Object.entries(current.locations).map(([id, state]) => [
      id,
      state.level === "NORMAL" || state.level === "UNKNOWN"
        ? state
        : { ...state, hazards: state.hazards.map(withoutProvider) },
    ]));

    const upgraded = parseSnapshot({ schemaVersion: 1, generatedAt: current.generatedAt, valid: true, dataHealth: current.dataHealth, sources, locations });
    const hazard = Object.values(upgraded.locations).find((state) => state.hazards.length)?.hazards[0];
    expect(upgraded.schemaVersion).toBe(10);
    expect(hazard?.providerId).toBe("effis-fire-danger");
  });

  it("upgrades Snapshot V8 delays conservatively without deleting permanent gaps", async () => {
    const current = structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const legacy = {
      ...current,
      schemaVersion: 8,
      locations: Object.fromEntries(Object.entries(current.locations).map(([id, state]) => {
        const rest = { ...state } as Partial<typeof state>;
        delete rest.delayedHazards;
        return [id, rest];
      })),
    };
    for (const id of catalogV2LocationIds) delete legacy.locations[id];
    const delayedId = Object.keys(current.locations).find((id) => current.locations[id].coverage === "delayed")!;
    const upgraded = parseSnapshot(legacy);
    expect(upgraded.schemaVersion).toBe(10);
    expect(upgraded.locations[delayedId].delayedHazards).toEqual(upgraded.locations[delayedId].coverageGaps);
  });

  it("uses V8 partition health and the coverage matrix to narrow delayed hazards", async () => {
    const current = structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    current.providers["national-civil-alerts"].partitions!.PL.status = "partial";
    current.locations["pl-bydgoszcz"] = {
      level: "UNKNOWN", coverage: "delayed", coverageGaps: ["flood", "wildfire", "civil-emergency"], delayedHazards: ["flood"], hazards: [],
    };
    const legacy = {
      ...current,
      schemaVersion: 8,
      locations: Object.fromEntries(Object.entries(current.locations).map(([id, state]) => {
        const rest = { ...state } as Partial<typeof state>;
        delete rest.delayedHazards;
        return [id, rest];
      })),
    };
    for (const id of catalogV2LocationIds) delete legacy.locations[id];
    const upgraded = parseSnapshot(legacy);
    expect(upgraded.locations["pl-bydgoszcz"].coverageGaps).toEqual(["flood", "wildfire", "civil-emergency"]);
    expect(upgraded.locations["pl-bydgoszcz"].delayedHazards).toEqual(["flood"]);
  });

  it("rejects malformed Snapshot V9 delayed-hazard arrays", async () => {
    const current = structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const locationId = Object.keys(current.locations)[0];
    const malformed = structuredClone(current) as unknown as { locations: Record<string, { delayedHazards: unknown }> };
    malformed.locations[locationId].delayedHazards = "flood";
    expect(() => parseSnapshot(malformed)).toThrow();
  });

  it("rejects catalog V2 locations mislabeled as a legacy snapshot", async () => {
    const current = structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")))) as unknown as Record<string, unknown>;
    current.schemaVersion = 9;
    delete current.catalogVersion;
    expect(() => parseSnapshot(current)).toThrow(/500 locations/);
  });

  it("rejects an unrecognized legacy hazard source instead of misattributing it", async () => {
    const current = removeContextHazards(structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")))));
    const sources = Object.fromEntries(Object.entries(createEmptyState(new Date(current.generatedAt)).sources)
      .filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id)));
    sources.eurdep = structuredClone(legacyHealth);
    const locations = Object.fromEntries(Object.entries(current.locations).map(([id, state]) => [
      id,
      state.level === "NORMAL" || state.level === "UNKNOWN"
        ? state
        : { ...state, hazards: state.hazards.map((hazard) => ({ ...withoutProvider(hazard), sourceName: "Unknown publisher" })) },
    ]));
    expect(() => parseSnapshot({ schemaVersion: 1, generatedAt: current.generatedAt, valid: true, dataHealth: current.dataHealth, sources, locations }))
      .toThrow(/Unsupported legacy hazard source/);
  });

  it("rejects an incomplete snapshot", async () => {
    const snapshot = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    Reflect.deleteProperty(snapshot.locations, Object.keys(snapshot.locations)[0]);
    expect(() => CompleteSnapshotSchema.parse(snapshot)).toThrow(/exactly the configured locations/);
  });

  it("rejects a snapshot with the right count but the wrong location ids", async () => {
    const snapshot = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const replaced = Object.keys(snapshot.locations)[0];
    snapshot.locations["not-in-the-catalog"] = snapshot.locations[replaced];
    Reflect.deleteProperty(snapshot.locations, replaced);
    expect(() => CompleteSnapshotSchema.parse(snapshot)).toThrow(/exactly the configured locations/);
  });

  it("rejects an alert summary that disagrees with its leading hazard", async () => {
    const snapshot = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const alert = Object.values(snapshot.locations).find((value) => value.hazards.length)!;
    alert.level = alert.level === "SEVERE" ? "ELEVATED" : "SEVERE";
    expect(() => SnapshotSchema.parse(snapshot)).toThrow(/leading hazard/);
  });

  it("rejects alert timing that disagrees with its leading hazard", async () => {
    const snapshot = structuredClone(CompleteSnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const alert = Object.values(snapshot.locations).find((value) => value.hazards.length)!;
    if (!("timing" in alert)) throw new Error("Demo snapshot has no alert");
    alert.timing = alert.timing === "ACTIVE" ? "UPCOMING" : "ACTIVE";
    expect(() => SnapshotSchema.parse(snapshot)).toThrow(/leading hazard/);
  });

  it("rejects a normal location that leaks hazards", async () => {
    const valid = SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    const snapshot = structuredClone(valid) as unknown as { locations: Record<string, { level: string; hazards: unknown[] }> };
    const normal = Object.values(snapshot.locations).find((value) => value.level === "NORMAL")!;
    const hazard = Object.values(snapshot.locations).find((value) => value.hazards.length)!.hazards[0];
    normal.hazards = [hazard];
    expect(() => SnapshotSchema.parse(snapshot)).toThrow();
  });

  it("rejects executable source-link schemes", async () => {
    const snapshot = structuredClone(SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8"))));
    const hazard = Object.values(snapshot.locations).find((value) => value.hazards.length)!.hazards[0];
    hazard.sourceUrl = "javascript:alert(1)";
    expect(() => SnapshotSchema.parse(snapshot)).toThrow();
  });

  it("rejects normalized events that end before they start", async () => {
    const snapshot = SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    const hazard = Object.values(snapshot.locations).find((value) => value.hazards.length)!.hazards[0];
    const event = {
      ...hazard, sourceId: "usgs", providerId: "usgs", affectedArea: hazard.affectedArea.label,
      geometry: { kind: "locations", ids: ["at-vienna"] },
    };
    expect(() => NormalizedEventSchema.parse(event)).not.toThrow();
    expect(() => NormalizedEventSchema.parse(withoutProvider(event))).toThrow();
    expect(() => NormalizedEventSchema.parse({ ...event, providerId: "gdacs" })).toThrow(/provider must match/i);
    expect(() => NormalizedEventSchema.parse({ ...event, endsAt: event.startsAt })).toThrow(/after its start time/);
  });

  it("rejects a coverage matrix with a missing hazard", async () => {
    const coverage = JSON.parse(await readFile("data/coverage.json", "utf8"));
    delete coverage.countries.AT.hazards.earthquake;
    expect(() => CoverageMatrixSchema.parse(coverage)).toThrow();
  });

  it("validates transport-owned events even when aggregate events are empty", async () => {
    const snapshot = SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    const hazard = Object.values(snapshot.locations).find((value) => value.hazards.length)!.hazards[0];
    const event = NormalizedEventSchema.parse({ ...hazard, sourceId: "meteoalarm", providerId: "meteoalarm",
      transportId: "meteoalarm-primary", affectedArea: hazard.affectedArea.label, geometry: { kind: "locations", ids: ["at-vienna"] } });
    const partition = { status: "ok" as const, sourceUpdatedAt: event.sourceUpdatedAt, error: null, events: [],
      transports: { "meteoalarm-primary": { status: "ok" as const, sourceUpdatedAt: event.sourceUpdatedAt, error: null, events: [event],
        checkedLocationIds: ["at-vienna"], unavailableLocationIds: [] as string[] } } };
    const result = { sourceId: "meteoalarm", checkedAt: snapshot.generatedAt, partitions: { AT: partition } };
    // The source contract requires every country, even in isolated transport tests.
    for (const code of Object.keys(snapshot.providers.meteoalarm.partitions!)) if (code !== "AT") Object.assign(result.partitions, { [code]: { status: "ok", sourceUpdatedAt: null, events: [], error: null } });
    expect(PartitionedSourceResultSchema.safeParse(result).success).toBe(true);
    for (const patch of [{ transportId: "fmi-cap" }, { sourceId: "usgs", providerId: "usgs" }, { geometry: { kind: "locations", ids: ["de-berlin"] } }]) {
      const invalid = structuredClone(result);
      Object.assign(invalid.partitions.AT.transports["meteoalarm-primary"].events[0], patch);
      expect(PartitionedSourceResultSchema.safeParse(invalid).success).toBe(false);
    }
    partition.transports["meteoalarm-primary"].unavailableLocationIds = ["at-vienna"];
    expect(PartitionedSourceResultSchema.safeParse(result).success).toBe(false);
  });

  it("rejects an open catalog polygon before geospatial matching", async () => {
    const catalog = JSON.parse(await readFile("data/locations.json", "utf8"));
    const location = structuredClone(catalog.find((candidate: { geometry: { kind: string } }) => candidate.geometry.kind === "polygon"));
    const ring = location.geometry.coordinates[0];
    ring[ring.length - 1] = [ring[0][0] + 0.1, ring[0][1]];
    expect(() => LocationSchema.parse(location)).toThrow(/closed/);
  });

  it("validates all country partitions in private state V7", () => {
    const state = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    expect(Object.keys(IngestionStateSchema.parse(state).sourcePartitions.meteoalarm)).toHaveLength(28);
    expect(Object.keys(IngestionStateSchema.parse(state).sourcePartitions.eea)).toHaveLength(28);
    expect(Object.keys(IngestionStateSchema.parse(state).sourcePartitions.nationalCivilAlerts)).toHaveLength(28);
    const missingProvider = structuredClone(state) as typeof state & { providers: Record<string, unknown> };
    Reflect.deleteProperty(missingProvider.providers, "emsc");
    expect(() => IngestionStateSchema.parse(missingProvider)).toThrow();
    const incomplete = structuredClone(state) as typeof state & { sourcePartitions: { meteoalarm: Record<string, unknown> } };
    Reflect.deleteProperty(incomplete.sourcePartitions.meteoalarm, "AT");
    expect(() => IngestionStateSchema.parse(incomplete)).toThrow();
    const extra = structuredClone(state) as typeof state & { sourcePartitions: { meteoalarm: Record<string, unknown> } };
    extra.sourcePartitions.meteoalarm.NO = structuredClone(state.sourcePartitions.meteoalarm.AT);
    expect(() => IngestionStateSchema.parse(extra)).toThrow();
  });

  it("migrates healthy V1 MeteoAlarm health to every country", () => {
    const current = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    current.sources.meteoalarm = {
      status: "ok", lastAttempt: "2026-08-25T10:00:00Z", lastSuccess: "2026-08-25T10:00:00Z",
      sourceUpdatedAt: "2026-08-25T09:59:00Z", nextExpectedUpdate: "2026-08-25T10:10:00Z",
      itemCount: 4, consecutiveFailures: 0, error: null,
    };
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(legacy, "sourcePartitions");
    legacy.sources = Object.fromEntries(Object.entries(current.sources).filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id)));
    (legacy.sources as Record<string, unknown>).eurdep = structuredClone(legacyHealth);
    legacy.schemaVersion = 1;
    const migrated = parseIngestionState(legacy);
    expect(Object.values(migrated.sourcePartitions.meteoalarm).every((health) => (
      health.status === "ok" && health.itemCount === 4 && health.lastSuccess === "2026-08-25T10:00:00Z"
    ))).toBe(true);
    expect(migrated.providers.meteoalarm).toMatchObject({ status: "ok", itemCount: 4 });
  });

  it("migrates V1 ingestion health conservatively", () => {
    const current = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    current.sources.meteoalarm.status = "delayed";
    current.sources.meteoalarm.consecutiveFailures = 2;
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(legacy, "sourcePartitions");
    legacy.sources = Object.fromEntries(Object.entries(current.sources).filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id)));
    (legacy.sources as Record<string, unknown>).eurdep = structuredClone(legacyHealth);
    legacy.schemaVersion = 1;
    const migrated = parseIngestionState(legacy);
    expect(migrated.schemaVersion).toBe(12);
    expect(Object.values(migrated.sourcePartitions.meteoalarm)).toHaveLength(28);
    expect(Object.values(migrated.sourcePartitions.meteoalarm).every((health) => health.status === "delayed" && health.consecutiveFailures === 2)).toBe(true);
  });

  it("adds provider attribution while migrating a V2 event", () => {
    const current = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    const event = {
      id: "legacy", sourceId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
      headline: "Earthquake reported nearby.", explanation: "A preliminary earthquake was reported nearby.",
      action: "Check official local advice.", affectedArea: "Vienna", geometry: { kind: "locations", ids: ["at-vienna"] },
      startsAt: "2026-08-25T09:00:00Z", endsAt: "2026-08-25T11:00:00Z", sourceUpdatedAt: "2026-08-25T09:00:00Z",
      checkedAt: "2026-08-25T10:00:00Z", expiresAt: "2026-08-25T11:00:00Z", sourceName: "USGS",
      sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM",
    };
    const sources = Object.fromEntries(Object.entries(current.sources)
      .filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id)));
    sources.eurdep = structuredClone(legacyHealth);
    const legacy = {
      schemaVersion: 2, updatedAt: current.updatedAt, events: [event], sources,
      sourcePartitions: { meteoalarm: current.sourcePartitions.meteoalarm }, fingerprints: {},
    };
    expect(parseIngestionState(legacy).events[0].providerId).toBe("usgs");
  });

  it("preserves provider health while migrating private state V3", () => {
    const current = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    const emscHealth = {
      status: "ok" as const,
      lastAttempt: "2026-08-25T10:00:00Z",
      lastSuccess: "2026-08-25T10:00:00Z",
      sourceUpdatedAt: "2026-08-25T09:59:00Z",
      nextExpectedUpdate: "2026-08-25T10:10:00Z",
      itemCount: 3,
      consecutiveFailures: 0,
      error: null,
    };
    current.sources.emsc = structuredClone(emscHealth);
    current.providers.emsc = structuredClone(emscHealth);
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    legacy.sources = Object.fromEntries(Object.entries(current.sources).filter(([id]) => !["national-civil-alerts", "vigicrues", "foen-flood", "ehyd-flood"].includes(id)));
    legacy.providers = Object.fromEntries(Object.entries(current.providers).filter(([id]) => !["national-civil-alerts", "vigicrues", "foen-flood", "ehyd-flood"].includes(id)));
    addRemovedStateProviders(legacy);
    legacy.sourcePartitions = { meteoalarm: current.sourcePartitions.meteoalarm, bbk: {} };
    Reflect.deleteProperty(legacy, "providerCoverage");

    expect(parseIngestionState(legacy).providers.emsc).toEqual(emscHealth);
  });

  it("adds new providers conservatively while migrating private state V4 to V5", () => {
    const current = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    const legacy = structuredClone(current) as unknown as Record<string, unknown> & { sources: Record<string, unknown>; providers: Record<string, unknown> };
    legacy.schemaVersion = 4;
    delete legacy.sources.vigicrues;
    delete legacy.sources["foen-flood"];
    delete legacy.sources["ehyd-flood"];
    delete legacy.providers.vigicrues;
    delete legacy.providers["foen-flood"];
    delete legacy.providers["ehyd-flood"];
    addRemovedStateProviders(legacy);
    const migrated = parseIngestionState(legacy);
    expect(migrated.schemaVersion).toBe(12);
    expect(migrated.providers.vigicrues).toMatchObject({ status: "not_monitored", error: "not_yet_checked" });
    expect(migrated.providers["foen-flood"]).toMatchObject({ status: "not_monitored", error: "not_yet_checked" });
    expect(migrated.providers["ehyd-flood"]).toMatchObject({ status: "not_monitored", error: "not_yet_checked" });
  });

  it("adds eHYD conservatively while migrating private state V5 to current V7", () => {
    const current = createEmptyState(new Date("2026-08-25T10:00:00Z"));
    const legacy = structuredClone(current) as unknown as Record<string, unknown> & { sources: Record<string, unknown>; providers: Record<string, unknown> };
    legacy.schemaVersion = 5;
    delete legacy.sources["ehyd-flood"];
    delete legacy.providers["ehyd-flood"];
    addRemovedStateProviders(legacy);
    const migrated = parseIngestionState(legacy);
    expect(migrated.schemaVersion).toBe(12);
    expect(migrated.providers["ehyd-flood"]).toMatchObject({ status: "not_monitored", error: "not_yet_checked" });
  });

  it("migrates private state V7 to V8 without activating context feeds", () => {
    const legacy = structuredClone(createEmptyState(new Date("2026-08-25T10:00:00Z"))) as unknown as Record<string, unknown> & { schemaVersion: number; sources: Record<string, unknown>; providers: Record<string, unknown> };
    legacy.schemaVersion = 7;
    for (const id of ["eonet", "edo-drought", "fcdo-travel-advice"]) {
      delete legacy.sources[id];
      delete legacy.providers[id];
    }
    const migrated = parseIngestionState(legacy);
    expect(migrated.schemaVersion).toBe(12);
    expect(migrated.sources.eonet).toMatchObject({ status: "not_monitored", error: "not_yet_checked" });
    expect(migrated.providers["edo-drought"]).toMatchObject({ status: "not_monitored" });
  });

  it("rejects unknown ingestion-state versions", () => {
    expect(() => parseIngestionState({ schemaVersion: 99 })).toThrow(/Unsupported/);
  });

  it("requires MeteoAlarm results to use country partitions", () => {
    expect(() => SourceResultSchema.parse({
      sourceId: "meteoalarm", checkedAt: "2026-08-25T10:00:00Z", sourceUpdatedAt: null,
      events: [], status: "ok", error: null,
    })).toThrow();
  });
});
