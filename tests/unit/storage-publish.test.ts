import { describe, expect, it } from "vitest";
import { BlobNotFoundError, BlobPreconditionFailedError, type get, type head, type put } from "@vercel/blob";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { BlobSnapshotStore, BlobStateStore, ConcurrencyError, publishConditionsFiles } from "@/lib/storage";
import { buildConditionsFiles } from "@/lib/conditions/state";
import { createLegacyState, projectLegacyState } from "../fixtures/legacy-state";
import { downgradeIngestionStateV12 } from "@/lib/domain/schemas";

function memoryPublicStore() {
  const values = new Map<string, { body: string; etag: string }>();
  const writes: string[] = [];
  const reads: string[] = [];
  const heads: string[] = [];
  let failLatest = false;
  const getBlob = (async (pathname: string) => {
    const key = pathname.startsWith("http") ? new URL(pathname).pathname.slice(1) : pathname;
    reads.push(key);
    const current = values.get(key);
    if (!current) return null;
    return {
      statusCode: 200 as const, stream: new Blob([current.body]).stream(), headers: new Headers(),
      blob: { url: `https://blob.example/${key}`, downloadUrl: `https://blob.example/${key}`, pathname: key, contentDisposition: "inline", cacheControl: "60", uploadedAt: new Date(), etag: current.etag, contentType: "application/json", size: current.body.length },
    };
  }) as typeof get;
  const headBlob = (async (pathname: string) => {
    heads.push(pathname);
    const current = values.get(pathname);
    if (!current) throw new BlobNotFoundError();
    return { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname, contentDisposition: "inline", cacheControl: "60", uploadedAt: new Date(), etag: current.etag, contentType: "application/json", size: current.body.length };
  }) as typeof head;
  const putBlob = (async (pathname: string, body: unknown, options: Parameters<typeof put>[2]) => {
    writes.push(pathname);
    const current = values.get(pathname);
    if (options.ifMatch && current?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
    if (options.allowOverwrite === false && current) throw new BlobPreconditionFailedError();
    if (pathname === "latest.json" && failLatest) {
      failLatest = false;
      throw new Error("public latest write failed");
    }
    const value = typeof body === "string" ? body : await new Response(body as BodyInit).text();
    const etag = String(writes.length);
    values.set(pathname, { body: value, etag });
    return { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname, contentType: "application/json", contentDisposition: "inline", etag };
  }) as typeof put;
  return {
    values, writes, reads, heads, getBlob, headBlob, putBlob,
    seed(pathname: string, body: unknown, etag: string) {
      values.set(pathname, { body: JSON.stringify(body), etag });
    },
    failNextLatest() { failLatest = true; },
  };
}

const legacyHealth = {
  status: "not_monitored", lastAttempt: null, lastSuccess: null, sourceUpdatedAt: null,
  nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: null,
};
const legacyPublicProvider = {
  mode: "disabled", status: "disabled", lastSuccess: null, sourceUpdatedAt: null,
  nextExpectedUpdate: null, limitationCode: "not_enabled",
};

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
  return state;
}

function removeCatalogV2Locations(snapshot: { locations?: Record<string, unknown> }) {
  for (const id of ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"]) delete snapshot.locations?.[id];
}

function addRemovedSnapshotProviders(snapshot: { providers: Record<string, unknown>; locations?: Record<string, unknown> }) {
  removeCatalogV2Locations(snapshot);
  delete snapshot.providers.eonet;
  delete snapshot.providers["edo-drought"];
  delete snapshot.providers["fcdo-travel-advice"];
  snapshot.providers["bbk-mowas"] = structuredClone(legacyPublicProvider);
  snapshot.providers.eurdep = structuredClone(legacyPublicProvider);
}

describe("public snapshot publication", () => {
  it("publishes a fresh generation heartbeat and never overwrites a newer generation", async () => {
    const blob = memoryPublicStore(); const now = new Date("2026-08-31T12:00:00Z");
    const [file] = buildConditionsFiles(createEmptyState(now), now, {});
    expect(await publishConditionsFiles([{ ...file, privateEndpoint: "must not be public" } as typeof file], "public", blob))
      .toEqual({ published: [file.countryCode], unchanged: [], failed: [] });
    const key = `conditions/v2/${file.countryCode}.json`;
    expect(blob.values.get(key)!.body).not.toContain("privateEndpoint");
    const original = blob.values.get(key)!.body;
    expect(await publishConditionsFiles([{ ...file, generatedAt: "2026-08-31T11:00:00Z" }], "public", blob))
      .toEqual({ published: [], unchanged: [file.countryCode], failed: [] });
    expect(await publishConditionsFiles([{ ...file, generatedAt: "2026-08-31T13:00:00Z" }], "public", blob))
      .toEqual({ published: [file.countryCode], unchanged: [], failed: [] });
    const refreshed = blob.values.get(key)!.body;
    expect(refreshed).not.toBe(original);
    expect(JSON.parse(refreshed).generatedAt).toBe("2026-08-31T13:00:00Z");
    expect(await publishConditionsFiles([{ ...file, generatedAt: "2026-08-31T13:00:00Z" }], "public", blob))
      .toEqual({ published: [], unchanged: [file.countryCode], failed: [] });
    expect(blob.writes).toHaveLength(2);
  });
  it("retries bounded transient country writes before reporting failure", async () => {
    const blob = memoryPublicStore(); const now = new Date("2026-08-31T12:00:00Z");
    const [file] = buildConditionsFiles(createEmptyState(now), now, {}); let calls = 0;
    const putBlob = (async (...args: Parameters<typeof put>) => {
      calls += 1;
      if (calls < 3) throw new Error("Transient Blob failure");
      return blob.putBlob(...args);
    }) as typeof put;
    await expect(publishConditionsFiles([file], "public", { ...blob, putBlob }))
      .resolves.toEqual({ published: [file.countryCode], unchanged: [], failed: [] });
    expect(calls).toBe(3);
  });
  it("re-reads a concurrent first creation and preserves the newer country file", async () => {
    const blob = memoryPublicStore(); const now = new Date("2026-08-31T12:00:00Z");
    const [file] = buildConditionsFiles(createEmptyState(now), now, {});
    let calls = 0;
    const putBlob = (async (path: string) => {
      calls += 1;
      blob.seed(path, { ...file, generatedAt: "2026-08-31T12:01:00Z" }, "concurrent");
      throw new Error("Blob already exists");
    }) as typeof put;
    expect(await publishConditionsFiles([file], "public", { ...blob, putBlob }))
      .toEqual({ published: [], unchanged: [file.countryCode], failed: [] });
    expect(calls).toBe(1);
    expect(JSON.parse(blob.values.get(`conditions/v2/${file.countryCode}.json`)!.body).generatedAt).toBe("2026-08-31T12:01:00Z");
  });
  it.each([["BE"], ["BE", "CH"]])("finishes every country write and repairs failures on the next pass (%s)", async (...countries) => {
    const blob = memoryPublicStore(); const files = buildConditionsFiles(createEmptyState(new Date("2026-08-31T12:00:00Z")), new Date("2026-08-31T12:00:00Z"), {});
    const blocked = new Set(countries.map((country) => `conditions/v2/${country}.json`));
    const putBlob = (async (...args: Parameters<typeof put>) => {
      if (blocked.has(args[0])) throw new Error("Country write failed");
      return blob.putBlob(...args);
    }) as typeof put;
    const first = await publishConditionsFiles(files, "public", { ...blob, putBlob });
    expect(first.published).toHaveLength(28 - countries.length);
    expect(first.failed).toEqual(countries.map((countryCode) => ({ countryCode, code: "write_failed" })));
    expect(blob.values.size).toBe(28 - countries.length);
    blocked.clear();
    const retry = await publishConditionsFiles(files, "public", { ...blob, putBlob });
    expect(retry).toEqual({ published: countries, unchanged: files.map(({ countryCode }) => countryCode).filter((country) => !countries.includes(country)).sort(), failed: [] });
    expect(blob.values.size).toBe(28);
  });
  it("rejects incomplete or duplicate country catalogs before any write", async () => {
    const blob = memoryPublicStore(); const now = new Date("2026-08-31T12:00:00Z");
    const [file] = buildConditionsFiles(createEmptyState(now), now, {});
    await expect(publishConditionsFiles([file, file], "public", blob)).rejects.toThrow(/Duplicate/);
    delete file.locations[Object.keys(file.locations)[0]];
    await expect(publishConditionsFiles([file], "public", blob)).rejects.toThrow(/catalog/);
    expect(blob.writes).toEqual([]);
  });
  it("preserves the first V11 private state immutably before V12 writes", async () => {
    const blob = memoryPublicStore(); const old = downgradeIngestionStateV12(projectLegacyState(createEmptyState()));
    blob.seed("ingestion-state.json", old, "initial");
    const store = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const initial = await store.read(); expect(initial.data.schemaVersion).toBe(14);
    await store.write(initial.data, initial);
    const backup = blob.values.get("ingestion-state-v11-backup.json")!.body;
    expect(JSON.parse(backup)).toEqual(old);
    await store.write((await store.read()).data, await store.read());
    expect(blob.values.get("ingestion-state-v11-backup.json")!.body).toBe(backup);
    expect(blob.writes.filter((path) => path === "ingestion-state-v11-backup.json")).toHaveLength(1);
  });
  const previousSnapshot = buildSnapshot(createEmptyState(new Date("2026-08-25T09:00:00Z")), new Date("2026-08-25T09:00:00Z"));
  const currentSnapshot = buildSnapshot(createEmptyState(new Date("2026-08-25T10:00:00Z")), new Date("2026-08-25T10:00:00Z"));
  const nextSnapshot = buildSnapshot(createEmptyState(new Date("2026-08-25T11:00:00Z")), new Date("2026-08-25T11:00:00Z"));
  const newestSnapshot = buildSnapshot(createEmptyState(new Date("2026-08-25T12:00:00Z")), new Date("2026-08-25T12:00:00Z"));

  it("preserves immutable rollback inputs before the first schema cutover", async () => {
    const blob = memoryPublicStore();
    const state = createLegacyState(new Date("2026-08-25T10:00:00Z"));
    const legacyState = { ...state, schemaVersion: 2, sources: Object.fromEntries(Object.entries(state.sources).filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id))), sourcePartitions: { meteoalarm: state.sourcePartitions.meteoalarm } } as Record<string, unknown>;
    (legacyState.sources as Record<string, unknown>).eurdep = structuredClone(legacyHealth);
    delete legacyState.candidates; delete legacyState.providers;
    const legacySnapshot = { schemaVersion: 1, generatedAt: currentSnapshot.generatedAt, valid: true, dataHealth: currentSnapshot.dataHealth,
      sources: legacyState.sources, locations: Object.fromEntries(Object.entries(currentSnapshot.locations)
        .filter(([id]) => !["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"].includes(id))
        .map(([id, value]) => [id, value.level === "NORMAL" || value.level === "UNKNOWN" ? value : { ...value, hazards: value.hazards.map((hazard) => Object.fromEntries(Object.entries(hazard).filter(([key]) => key !== "providerId"))) }])) };
    blob.seed("ingestion-state.json", legacyState, "state-v2");
    blob.seed("latest.json", legacySnapshot, "snapshot-v1"); blob.seed("previous.json", legacySnapshot, "previous-v1");

    const migrated = await new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob).read();
    await new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob).write(migrated.data, migrated);
    const publicStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    await publicStore.publish(nextSnapshot, await publicStore.readLatest());

    expect(JSON.parse(blob.values.get("ingestion-state-v2-backup.json")!.body).schemaVersion).toBe(2);
    expect(JSON.parse(blob.values.get("snapshot-v1-backup.json")!.body).schemaVersion).toBe(1);

    const originalBackup = blob.values.get("ingestion-state-v2-backup.json")!.body;
    blob.seed("ingestion-state.json", { ...legacyState, updatedAt: "2026-08-25T10:30:00Z" }, "state-v2-again");
    const reread = await new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob).read();
    await new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob).write(reread.data, reread);
    expect(blob.values.get("ingestion-state-v2-backup.json")!.body).toBe(originalBackup);
  });

  it("preserves the immediate V4 state and V3 snapshot before the V5/V4 cutover", async () => {
    const blob = memoryPublicStore();
    const state = createLegacyState(new Date("2026-08-25T10:00:00Z"));
    const legacyState = {
      ...state,
      schemaVersion: 4,
      sources: Object.fromEntries(Object.entries(state.sources).filter(([id]) => !["vigicrues", "foen-flood", "ehyd-flood"].includes(id))),
      providers: Object.fromEntries(Object.entries(state.providers).filter(([id]) => !["vigicrues", "foen-flood", "ehyd-flood"].includes(id))),
    } as Record<string, unknown>;
    addRemovedStateProviders(legacyState);
    const legacySnapshot = structuredClone(currentSnapshot) as Record<string, unknown> & {
      providers: Record<string, { partitions?: unknown }>;
    };
    addRemovedSnapshotProviders(legacySnapshot);
    legacySnapshot.schemaVersion = 3;
    delete legacySnapshot.providers.vigicrues;
    delete legacySnapshot.providers["foen-flood"];
    delete legacySnapshot.providers["ehyd-flood"];

    blob.seed("ingestion-state.json", legacyState, "state-v4");
    blob.seed("latest.json", legacySnapshot, "snapshot-v3");
    blob.seed("previous.json", legacySnapshot, "previous-v3");

    const stateStore = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const migrated = await stateStore.read();
    await stateStore.write(migrated.data, migrated);
    const publicStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    await publicStore.publish(nextSnapshot, await publicStore.readLatest());

    expect(JSON.parse(blob.values.get("ingestion-state-v4-backup.json")!.body).schemaVersion).toBe(4);
    expect(JSON.parse(blob.values.get("snapshot-v3-backup.json")!.body).schemaVersion).toBe(3);
  });

  it("preserves the immediate V5 state and V4 snapshot before the V6/V5 cutover", async () => {
    const blob = memoryPublicStore();
    const state = createLegacyState(new Date("2026-08-25T10:00:00Z"));
    const legacyState = {
      ...state,
      schemaVersion: 5,
      sources: Object.fromEntries(Object.entries(state.sources).filter(([id]) => id !== "ehyd-flood")),
      providers: Object.fromEntries(Object.entries(state.providers).filter(([id]) => id !== "ehyd-flood")),
    } as Record<string, unknown>;
    addRemovedStateProviders(legacyState);
    const legacySnapshot = structuredClone(currentSnapshot) as Record<string, unknown> & {
      providers: Record<string, unknown>;
    };
    addRemovedSnapshotProviders(legacySnapshot);
    legacySnapshot.schemaVersion = 4;
    delete legacySnapshot.providers["ehyd-flood"];

    blob.seed("ingestion-state.json", legacyState, "state-v5");
    blob.seed("latest.json", legacySnapshot, "snapshot-v4");
    blob.seed("previous.json", legacySnapshot, "previous-v4");

    const stateStore = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const migrated = await stateStore.read();
    await stateStore.write(migrated.data, migrated);
    const publicStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    await publicStore.publish(nextSnapshot, await publicStore.readLatest());

    expect(JSON.parse(blob.values.get("ingestion-state-v5-backup.json")!.body).schemaVersion).toBe(5);
    expect(JSON.parse(blob.values.get("snapshot-v4-backup.json")!.body).schemaVersion).toBe(4);
  });

  it("backs up V6/V5 data while removing permission-gated providers", async () => {
    const blob = memoryPublicStore();
    const legacyState = addRemovedStateProviders({
      ...structuredClone(createLegacyState(new Date("2026-08-25T10:00:00Z"))),
      schemaVersion: 6,
    });
    const legacySnapshot = structuredClone(currentSnapshot) as unknown as Record<string, unknown> & { providers: Record<string, unknown> };
    legacySnapshot.schemaVersion = 5;
    addRemovedSnapshotProviders(legacySnapshot);
    blob.seed("ingestion-state.json", legacyState, "state-v6");
    blob.seed("latest.json", legacySnapshot, "snapshot-v5");
    blob.seed("previous.json", legacySnapshot, "previous-v5");

    const stateStore = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const migrated = await stateStore.read();
    await stateStore.write(migrated.data, migrated);
    const publicStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    await publicStore.publish(nextSnapshot, await publicStore.readLatest());

    expect(JSON.parse(blob.values.get("ingestion-state-v6-backup.json")!.body).providers).toHaveProperty("bbk-mowas");
    expect(JSON.parse(blob.values.get("snapshot-v5-backup.json")!.body).providers).toHaveProperty("eurdep");
    expect(migrated.data.providers).not.toHaveProperty("bbk-mowas");
    expect(migrated.data.providers).not.toHaveProperty("eurdep");
  });

  it("creates immutable V8 state and V8 snapshot backups on the V9 cutover", async () => {
    const blob = memoryPublicStore();
    const legacyState = { ...structuredClone(createLegacyState(new Date("2026-08-25T10:00:00Z"))), schemaVersion: 8 };
    const legacySnapshot = {
      ...structuredClone(currentSnapshot),
      schemaVersion: 8,
      locations: Object.fromEntries(Object.entries(currentSnapshot.locations).map(([id, location]) => {
        const rest = { ...location } as Partial<typeof location>;
        delete rest.delayedHazards;
        return [id, rest];
      })),
    };
    removeCatalogV2Locations(legacySnapshot);
    blob.seed("ingestion-state.json", legacyState, "state-v8");
    blob.seed("latest.json", legacySnapshot, "snapshot-v8");
    blob.seed("previous.json", legacySnapshot, "previous-v8");

    const stateStore = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const migrated = await stateStore.read();
    await stateStore.write(migrated.data, migrated);
    const snapshotStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    await snapshotStore.publish(nextSnapshot, await snapshotStore.readLatest());

    expect(JSON.parse(blob.values.get("ingestion-state-v8-backup.json")!.body).schemaVersion).toBe(8);
    expect(JSON.parse(blob.values.get("snapshot-v8-backup.json")!.body).schemaVersion).toBe(8);
    const stateBackup = blob.values.get("ingestion-state-v8-backup.json")!.body;
    blob.seed("ingestion-state.json", { ...legacyState, updatedAt: "2026-08-25T10:30:00Z" }, "state-v8-again");
    const reread = await stateStore.read();
    await stateStore.write(reread.data, reread);
    expect(blob.values.get("ingestion-state-v8-backup.json")!.body).toBe(stateBackup);
  });

  it("creates immutable V9 state and snapshot backups on the V10 catalog cutover", async () => {
    const blob = memoryPublicStore();
    const currentState = structuredClone(createLegacyState(new Date("2026-08-25T10:00:00Z")));
    const legacyState = { ...currentState, schemaVersion: 9 } as Record<string, unknown>;
    delete legacyState.partitionTransports;
    const legacySnapshot = { ...structuredClone(currentSnapshot), schemaVersion: 9 } as Record<string, unknown>;
    delete legacySnapshot.catalogVersion;
    const legacyLocations = legacySnapshot.locations as Record<string, unknown>;
    for (const id of ["pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"]) delete legacyLocations[id];
    blob.seed("ingestion-state.json", legacyState, "state-v9");
    blob.seed("latest.json", legacySnapshot, "snapshot-v9");
    blob.seed("previous.json", legacySnapshot, "previous-v9");

    const stateStore = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const migrated = await stateStore.read();
    await stateStore.write(migrated.data, migrated);
    const snapshotStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    await snapshotStore.publish(nextSnapshot, await snapshotStore.readLatest());

    expect(JSON.parse(blob.values.get("ingestion-state-v9-backup.json")!.body).schemaVersion).toBe(9);
    expect(JSON.parse(blob.values.get("snapshot-v9-backup.json")!.body).schemaVersion).toBe(9);
  });

  it("rejects a malformed pre-existing rollback backup", async () => {
    const blob = memoryPublicStore();
    const state = createLegacyState(new Date("2026-08-25T10:00:00Z"));
    const legacyState = { ...state, schemaVersion: 2, sources: Object.fromEntries(Object.entries(state.sources).filter(([id]) => ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "eurdep"].includes(id))), sourcePartitions: { meteoalarm: state.sourcePartitions.meteoalarm } } as Record<string, unknown>;
    (legacyState.sources as Record<string, unknown>).eurdep = structuredClone(legacyHealth);
    delete legacyState.candidates; delete legacyState.providers;
    blob.seed("ingestion-state.json", legacyState, "state-v2");
    blob.seed("ingestion-state-v2-backup.json", { schemaVersion: 2 }, "bad-backup");
    const store = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const migrated = await store.read();

    await expect(store.write(migrated.data, migrated)).rejects.toThrow();
    expect(blob.writes).toEqual([]);
  });

  it("converts weak content ETags into strong conditional-write ETags", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, 'W/"current"');
    blob.seed("ingestion-state.json", createEmptyState(new Date("2026-08-25T10:00:00Z")), 'W/"state"');

    await expect(new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob).readLatest())
      .resolves.toMatchObject({ etag: '"current"' });
    await expect(new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob).read())
      .resolves.toMatchObject({ etag: '"state"' });
  });

  it("refuses an unconditional write when Blob omits the ETag", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "");

    await expect(new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob).readLatest())
      .rejects.toThrow("Blob read did not return an ETag");
  });

  it("does not overwrite previous.json when the latest write fails", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    blob.failNextLatest();
    const store = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" })).rejects.toThrow("public latest write failed");
    expect(blob.writes).toEqual(["latest.json"]);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(previousSnapshot.generatedAt);
    expect(JSON.parse(blob.values.get("latest.json")!.body).generatedAt).toBe(currentSnapshot.generatedAt);
  });

  it("writes latest.json before copying the prior snapshot to previous.json", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    const store = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" })).resolves.toMatchObject({ url: "https://blob.example/latest.json" });
    expect(blob.writes).toEqual(["latest.json", "previous.json"]);
    expect(JSON.parse(blob.values.get("latest.json")!.body).generatedAt).toBe(nextSnapshot.generatedAt);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(currentSnapshot.generatedAt);
  });

  it("recreates a missing rollback snapshot and keeps rotating it", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    const store = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" })).resolves.toBeDefined();
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(currentSnapshot.generatedAt);

    await expect(store.publish(newestSnapshot, await store.readLatest())).resolves.toBeDefined();
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(nextSnapshot.generatedAt);
  });

  it("accepts a concurrent rollback-snapshot recreation", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    const originalPut = blob.putBlob;
    let raced = false;
    const putBlob = (async (pathname: string, body: Parameters<typeof put>[1], options: Parameters<typeof put>[2]) => {
      if (pathname === "previous.json" && options.allowOverwrite === false && !raced) {
        raced = true;
        blob.seed("previous.json", currentSnapshot, "concurrent");
        throw new BlobPreconditionFailedError();
      }
      return originalPut(pathname, body, options);
    }) as typeof put;

    await expect(new BlobSnapshotStore("public", blob.getBlob, putBlob, blob.headBlob)
      .publish(nextSnapshot, { data: currentSnapshot, etag: "current" })).resolves.toBeDefined();
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(currentSnapshot.generatedAt);
  });

  it("reuses versioned reads during current-schema publication", async () => {
    const blob = memoryPublicStore();
    blob.seed("ingestion-state.json", createEmptyState(new Date("2026-08-25T10:00:00Z")), "state");
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    const stateStore = new BlobStateStore("private", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const snapshotStore = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);
    const state = await stateStore.read();
    const snapshot = await snapshotStore.readLatest();
    blob.reads.length = 0;
    blob.heads.length = 0;
    blob.writes.length = 0;

    await stateStore.write(state.data, state);
    await snapshotStore.publish(nextSnapshot, snapshot);

    expect(blob.reads).toEqual(["previous.json"]);
    expect(blob.heads).toEqual(["latest.json", "previous.json"]);
    expect(blob.writes).toEqual(["ingestion-state.json", "latest.json", "previous.json"]);
  });

  it("uses versioned public reads so a cached pre-write response cannot block rollback rotation", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    const getBlob = (async (pathname: string, options: Parameters<typeof get>[1]) => {
      if (pathname === "latest.json") {
        return {
          statusCode: 200 as const, stream: new Blob([JSON.stringify(previousSnapshot)]).stream(), headers: new Headers(),
          blob: { url: "https://blob.example/latest.json", downloadUrl: "https://blob.example/latest.json", pathname: "latest.json", contentDisposition: "inline", cacheControl: "60", uploadedAt: new Date(), etag: "cached", contentType: "application/json", size: 1 },
        };
      }
      return blob.getBlob(pathname, options);
    }) as typeof get;
    const store = new BlobSnapshotStore("public", getBlob, blob.putBlob, blob.headBlob);

    await store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" });
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(currentSnapshot.generatedAt);
  });

  it("skips previous.json when another publish already replaced latest.json", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    const originalPut = blob.putBlob;
    const putBlob = (async (pathname: string, body: Parameters<typeof put>[1], options: Parameters<typeof put>[2]) => {
      const result = await originalPut(pathname, body, options);
      if (pathname === "latest.json") blob.seed("latest.json", nextSnapshot, "newer-job");
      return result;
    }) as typeof put;
    const store = new BlobSnapshotStore("public", blob.getBlob, putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" })).resolves.toMatchObject({ url: "https://blob.example/latest.json" });
    expect(blob.writes.filter((pathname) => pathname === "previous.json")).toEqual([]);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(previousSnapshot.generatedAt);
  });

  it("does not let an older overlapping publisher regress previous.json", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    const originalPut = blob.putBlob;
    let overlap = true;
    const putBlob = (async (pathname: string, body: Parameters<typeof put>[1], options: Parameters<typeof put>[2]) => {
      if (pathname === "previous.json" && overlap) {
        overlap = false;
        await store.publish(newestSnapshot, { data: nextSnapshot, etag: blob.values.get("latest.json")!.etag });
      }
      return originalPut(pathname, body, options);
    }) as typeof put;
    const store = new BlobSnapshotStore("public", blob.getBlob, putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" })).resolves.toBeDefined();
    expect(JSON.parse(blob.values.get("latest.json")!.body).generatedAt).toBe(newestSnapshot.generatedAt);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(nextSnapshot.generatedAt);
  });

  it("bounds previous.json retries under persistent contention", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "current");
    blob.seed("previous.json", previousSnapshot, "previous");
    let attempts = 0;
    const putBlob = (async (pathname: string, body: Parameters<typeof put>[1], options: Parameters<typeof put>[2]) => {
      if (pathname === "previous.json") { attempts += 1; throw new BlobPreconditionFailedError(); }
      return blob.putBlob(pathname, body, options);
    }) as typeof put;
    const store = new BlobSnapshotStore("public", blob.getBlob, putBlob, blob.headBlob);

    const failure = store.publish(nextSnapshot, { data: currentSnapshot, etag: "current" });
    await expect(failure).rejects.toThrow("Rollback snapshot changed after latest publication");
    await expect(failure).rejects.not.toBeInstanceOf(ConcurrencyError);
    expect(attempts).toBe(2);
    expect(JSON.parse(blob.values.get("latest.json")!.body).generatedAt).toBe(nextSnapshot.generatedAt);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(previousSnapshot.generatedAt);
  });

  it("does not rotate an implausibly future-dated snapshot into rollback storage", async () => {
    const blob = memoryPublicStore();
    const poisoned = buildSnapshot(createEmptyState(new Date("2099-01-01T00:00:00Z")), new Date("2099-01-01T00:00:00Z"));
    blob.seed("latest.json", poisoned, "poisoned");
    blob.seed("previous.json", previousSnapshot, "previous");
    const store = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: poisoned, etag: "poisoned" })).resolves.toBeDefined();

    expect(JSON.parse(blob.values.get("latest.json")!.body).generatedAt).toBe(nextSnapshot.generatedAt);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(previousSnapshot.generatedAt);
  });

  it("leaves previous.json untouched when the latest ETag already changed", async () => {
    const blob = memoryPublicStore();
    blob.seed("latest.json", currentSnapshot, "newer");
    blob.seed("previous.json", previousSnapshot, "previous");
    const store = new BlobSnapshotStore("public", blob.getBlob, blob.putBlob, blob.headBlob);

    await expect(store.publish(nextSnapshot, { data: currentSnapshot, etag: "stale" })).rejects.toBeInstanceOf(ConcurrencyError);
    expect(blob.writes).toEqual(["latest.json"]);
    expect(JSON.parse(blob.values.get("previous.json")!.body).generatedAt).toBe(previousSnapshot.generatedAt);
  });
});
