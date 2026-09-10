import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialCollector } from "@/lib/collector";
import { catalogV3Paths } from "@/lib/catalog-paths";
import { SnapshotV11Schema } from "@/lib/domain/catalog-public";
import { catalogV3CountryCodes } from "@/lib/domain/contract-identities";
import { collectorEnvironment, disabledLocalPolicy, restrictedSourceManifestDigest, restrictedSourcesActive } from "@/lib/local-policy";
import { conditionAttribution } from "@/lib/conditions/sources";
import {
  initializeLocalRuntime, LocalCatalog3SnapshotStore, LocalDatabase, localStores,
  publicObjectLimit, readLocalPolicy, writeLocalPolicy,
} from "@/lib/local-storage";
import { localPluginSummary } from "@/lib/local-status";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "travelcanary-sqlite-"));
  const path = join(directory, "travelcanary.db");
  return { directory, path, database: new LocalDatabase(path) };
}

describe("local SQLite runtime", () => {
  it("initializes catalog 3 directly with 679 UNKNOWN destinations and isolated keys", () => {
    const { path, database } = temporaryDatabase();
    expect(initializeLocalRuntime(database)).toEqual({ initialized: true, catalogVersion: 3, destinations: 679 });
    const snapshot = SnapshotV11Schema.parse(JSON.parse(database.readPublic(catalogV3Paths.snapshot)!.value));
    expect(Object.keys(snapshot.locations)).toHaveLength(679);
    expect(new Set(Object.values(snapshot.locations).map(({ level }) => level))).toEqual(new Set(["UNKNOWN"]));
    expect(() => database.readPublic("ingestion/state.json")).toThrow(/allowlisted/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    database.close();
    const reopened = new LocalDatabase(path);
    expect(initializeLocalRuntime(reopened).initialized).toBe(false);
    expect(localPluginSummary(reopened).freshness).toBe("warming");
    reopened.close();
  });

  it("enforces CAS revisions, size limits, and transaction rollback", async () => {
    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const { stateStore } = localStores(database);
    const first = await stateStore.read(); const stale = await stateStore.read();
    first.data.updatedAt = new Date(Date.parse(first.data.updatedAt) + 1).toISOString();
    await stateStore.write(first.data, first);
    await expect(stateStore.write(stale.data, stale)).rejects.toThrow(/changed/);
    expect(() => database.compareAndSwap("private", "test/oversized", "x".repeat(10), null, 5)).toThrow(/size/);
    database.close();

    const rolledBack = temporaryDatabase().database;
    expect(() => rolledBack.initialize([
      { namespace: "private", key: "test/first", value: "{}", maxBytes: 10 },
      { namespace: "private", key: "test/second", value: "too-large", maxBytes: 2 },
    ])).toThrow(/size/);
    expect(rolledBack.read("private", "test/first")).toBeUndefined();
    rolledBack.close();
  });

  it("retains the previous public snapshot when latest advances", async () => {
    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const store = new LocalCatalog3SnapshotStore(database);
    const first = (await store.readLatest())!;
    const next = structuredClone(first.data);
    next.generatedAt = new Date(Date.parse(first.data.generatedAt) + 1_000).toISOString();
    await store.publish(next, first, new Date(next.generatedAt));
    const previous = SnapshotV11Schema.parse(JSON.parse(database.readPublic(catalogV3Paths.previousSnapshot)!.value));
    expect(previous.generatedAt).toBe(first.data.generatedAt);
    expect((await store.readLatest())!.data.generatedAt).toBe(next.generatedAt);
    database.close();
  });

  it("rejects duplicate collector ownership until the lease expires", () => {
    const { database } = temporaryDatabase();
    database.acquireCollector("collector-one", 1_000, 30_000);
    expect(() => database.acquireCollector("collector-two", 2_000, 30_000)).toThrow(/Another collector/);
    expect(database.acquireCollector("collector-two", 31_001, 30_000)).toBeTruthy();
    database.close();
  });

  it("binds restricted acceptance to the current manifest digest", () => {
    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const current = readLocalPolicy(database);
    const accepted = { schemaVersion: 1 as const, restrictedSources: "accepted" as const,
      acceptedManifestDigest: restrictedSourceManifestDigest, acceptedAt: new Date().toISOString() };
    writeLocalPolicy(database, accepted, current.revision);
    expect(restrictedSourcesActive(readLocalPolicy(database).policy)).toBe(true);
    expect(collectorEnvironment(disabledLocalPolicy()).NONCOMMERCIAL_DATA_ENABLED).toBe("false");
    expect(collectorEnvironment(accepted).NONCOMMERCIAL_DATA_ENABLED).toBe("true");
    expect(collectorEnvironment(accepted)).toMatchObject({
      CONTEXT_FEEDS_ENABLED: "false", GDELT_ENABLED: "false", GFM_ENABLED: "false",
      GLOFAS_TARGETING_ENABLED: "false", IFRC_FALLBACK_ENABLED: "false",
    });
    expect(restrictedSourcesActive({ ...accepted, acceptedManifestDigest: "0".repeat(64) })).toBe(false);
    database.close();
  });

  it("keeps the disclosure active while published restricted data remains", () => {
    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const key = "catalogs/3/conditions/v3/PT.json";
    const row = database.readPublic(key)!;
    const conditions = JSON.parse(row.value);
    conditions.sources["ipma-observations"] = conditionAttribution("ipma-observations");
    conditions.sourceHealth["ipma-observations"] = { status: "ok", checkedAt: conditions.generatedAt, limitationCode: null };
    database.compareAndSwap("public", key, JSON.stringify(conditions), row.revision, publicObjectLimit(key));

    const summary = localPluginSummary(database);
    expect(readLocalPolicy(database).policy).toEqual(disabledLocalPolicy());
    expect(summary.restrictedSources.active).toBe(true);
    expect(summary.restrictedSources.disclosure).toMatch(/published data still includes restricted/i);
    database.close();
  });

  it("rejects partial initialization and incomplete catalog-3 conditions generations", async () => {
    const partial = temporaryDatabase().database;
    partial.compareAndSwap("private", "test/partial", "{}", null, 10);
    expect(() => initializeLocalRuntime(partial)).toThrow(/partially initialized/);
    partial.close();

    const { database } = temporaryDatabase(); initializeLocalRuntime(database);
    const publication = localStores(database).catalogPublication;
    const onlyCountry = JSON.parse(database.readPublic("catalogs/3/conditions/v3/AL.json")!.value);
    await expect(publication.publishCatalog3Conditions([onlyCountry], true, new Date())).rejects.toThrow(/all 45 countries/);
    const files = catalogV3CountryCodes.map((country) => JSON.parse(database.readPublic(`catalogs/3/conditions/v3/${country}.json`)!.value));
    for (const file of files) file.generatedAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(publication.publishCatalog3Conditions(files, true, new Date())).rejects.toThrow(/future/);
    database.close();
  });

  it("creates private backups and restores a validated database", () => {
    const { directory, path, database } = temporaryDatabase(); initializeLocalRuntime(database); database.close();
    const backupPath = join(directory, "private-backup.db");
    const environment = { ...process.env, TRAVELCANARY_DATA_DIR: directory };
    const command = join(process.cwd(), "scripts", "travelcanary-cli.ts");
    execFileSync(process.execPath, ["--import", "tsx", command, "backup", backupPath], { cwd: process.cwd(), env: environment });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const replacement = new LocalDatabase(path); const policy = readLocalPolicy(replacement);
    writeLocalPolicy(replacement, { schemaVersion: 1, restrictedSources: "accepted", acceptedManifestDigest: restrictedSourceManifestDigest, acceptedAt: new Date().toISOString() }, policy.revision);
    replacement.close();
    execFileSync(process.execPath, ["--import", "tsx", command, "restore", backupPath], { cwd: process.cwd(), env: environment });
    const restored = new LocalDatabase(path);
    expect(readLocalPolicy(restored).policy).toEqual(disabledLocalPolicy());
    expect(readFileSync(backupPath).byteLength).toBeGreaterThan(0);
    restored.close();
  }, 20_000);

  it("rejects an integrity-valid backup missing required public objects", () => {
    const { directory, path, database } = temporaryDatabase(); initializeLocalRuntime(database); database.close();
    const incompleteBackup = join(directory, "incomplete-backup.db");
    copyFileSync(path, incompleteBackup);
    const candidate = new DatabaseSync(incompleteBackup);
    candidate.prepare("DELETE FROM objects WHERE namespace='public' AND key='catalogs/3/conditions/v3/PT.json'").run();
    candidate.close();
    const environment = { ...process.env, TRAVELCANARY_DATA_DIR: directory };
    const command = join(process.cwd(), "scripts", "travelcanary-cli.ts");

    expect(() => execFileSync(process.execPath, ["--import", "tsx", command, "restore", incompleteBackup], {
      cwd: process.cwd(), env: environment, stdio: "pipe",
    })).toThrow();
    const original = new LocalDatabase(path);
    expect(original.readPublic("catalogs/3/conditions/v3/PT.json")).toBeDefined();
    original.close();
  }, 20_000);
});

describe("collector serialization", () => {
  afterEach(() => vi.useRealTimers());

  it("runs overlapping work one at a time in enqueue order", async () => {
    const events: string[] = [];
    const collector = new SerialCollector(async (operation) => {
      events.push(`start:${operation}`); await Promise.resolve(); events.push(`end:${operation}`);
    });
    await Promise.all([collector.enqueue("fast"), collector.enqueue("conditions"), collector.enqueue("maintenance")]);
    await collector.stop();
    expect(events).toEqual(["start:fast", "end:fast", "start:conditions", "end:conditions", "start:maintenance", "end:maintenance"]);
  });

  it("queues all six cadences at startup and stops cleanly", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const collector = new SerialCollector(async (operation) => { operations.push(operation); });
    await collector.start();
    expect(operations).toEqual(["fast", "slow", "conditions", "satellite", "daily", "maintenance"]);
    await collector.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(operations).toHaveLength(6);
  });
});
