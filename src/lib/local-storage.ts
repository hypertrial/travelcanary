import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { buildCatalog3Conditions, buildCatalog3Snapshot } from "./catalog-projections";
import type { CatalogPublicationStores } from "./catalog-publication";
import { catalog3ConditionsCountryLimit } from "./conditions/publication-budget";
import { serializeCatalog3Conditions } from "./conditions/serialization";
import { captureStateControl, assertStateControlChange } from "./publication-control";
import { createEmptyState } from "./risk";
import { IngestionStateV14Schema, parseCatalogState, type IngestionStateV14 } from "./domain/catalog-state";
import { CONDITIONS_COUNTRY_LIMIT, CONDITIONS_TOTAL_LIMIT, ConditionsSchema, type Conditions } from "./domain/conditions";
import { ConditionsV3Schema, SnapshotV11Schema } from "./domain/catalog-public";
import { catalogV3CountryCodes } from "./domain/contract-identities";
import { CompleteSnapshotSchema } from "./snapshot-validation";
import { parseSnapshot, type Snapshot } from "./domain/schemas";
import { PRIVATE_STATE_HARD_LIMIT_BYTES } from "./ingestion/limits";
import { catalogV2Paths, catalogV3Paths } from "./catalog-paths";
import { ConcurrencyError, type ConditionsPublicationResult, type SnapshotStore, type StateStore, type Versioned } from "./storage";
import { disabledLocalPolicy, LocalRuntimePolicySchema, type LocalRuntimePolicy } from "./local-policy";
import catalogV2 from "../../data/catalog-releases/2.json";

const objectKey = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.split("/").includes(".."), "Object keys cannot traverse namespaces");
const namespace = z.enum(["private", "public"]);
const SNAPSHOT_LIMIT_BYTES = 500_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATE_KEY = "ingestion/state.json";
export const POLICY_KEY = "runtime/policy.json";
export const COLLECTOR_STATUS_KEY = "runtime/collector-status.json";

type Namespace = z.infer<typeof namespace>;
type ObjectRow = { value: Uint8Array | string; revision: number; updated_at: string };
export type LocalObject = { value: string; revision: number; updatedAt: string };

export function localDataDirectory(environment: Record<string, string | undefined> = process.env) {
  const configured = environment.TRAVELCANARY_DATA_DIR?.trim();
  return resolve(/* turbopackIgnore: true */ configured || ".travelcanary");
}

export function localDatabasePath(environment: Record<string, string | undefined> = process.env) {
  const directory = localDataDirectory(environment);
  if (!isAbsolute(directory)) throw new Error("TRAVELCANARY_DATA_DIR must resolve to an absolute path");
  return resolve(directory, "travelcanary.db");
}

function text(row: ObjectRow): string {
  return typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
}

export function publicObjectLimit(key: string) {
  if (key === catalogV3Paths.snapshot || key === catalogV3Paths.previousSnapshot
    || key === catalogV2Paths.snapshot || key === catalogV2Paths.previousSnapshot) return SNAPSHOT_LIMIT_BYTES;
  const v3 = key.match(/^catalogs\/3\/conditions\/v3\/([A-Z]{2})\.json$/);
  if (v3) return catalog3ConditionsCountryLimit(v3[1] as Parameters<typeof catalog3ConditionsCountryLimit>[0]);
  if (/^conditions\/v2\/[A-Z]{2}\.json$/.test(key)) return CONDITIONS_COUNTRY_LIMIT;
  throw new Error("Public object key is not allowlisted");
}

export function isAllowlistedPublicObjectKey(key: string) {
  try { publicObjectLimit(key); return true; } catch { return false; }
}

export class LocalDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path = localDatabasePath(), busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS) {
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 100 || busyTimeoutMs > 30_000) throw new Error("SQLite busy timeout must be between 100 and 30000 ms");
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!lstatSync(dirname(this.path)).isDirectory()) throw new Error("SQLite parent is not a directory");
    try { if (!lstatSync(this.path).isFile()) throw new Error("SQLite path must be a regular file"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    this.database = new DatabaseSync(this.path);
    this.database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        namespace TEXT NOT NULL CHECK(namespace IN ('private','public')),
        key TEXT NOT NULL,
        value BLOB NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collector_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `);
    this.secureFiles();
  }

  close() { this.database.close(); }

  private secureFiles() {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(`${this.path}${suffix}`, 0o600); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }

  read(scope: Namespace, key: string): LocalObject | undefined {
    namespace.parse(scope); objectKey.parse(key);
    const row = this.database.prepare("SELECT value, revision, updated_at FROM objects WHERE namespace = ? AND key = ?")
      .get(scope, key) as ObjectRow | undefined;
    return row ? { value: text(row), revision: Number(row.revision), updatedAt: row.updated_at } : undefined;
  }

  readPublic(key: string) {
    publicObjectLimit(key);
    const result = this.read("public", key);
    if (result && Buffer.byteLength(result.value) > publicObjectLimit(key)) throw new Error("Stored public object exceeds its size limit");
    return result;
  }

  compareAndSwap(scope: Namespace, key: string, value: string, expectedRevision: number | null, maxBytes: number) {
    return this.compareAndSwapBatch([{ scope, key, value, expectedRevision, maxBytes }])[0];
  }

  compareAndSwapBatch(entries: Array<{ scope: Namespace; key: string; value: string; expectedRevision: number | null; maxBytes: number }>) {
    if (!entries.length) return [];
    for (const { scope, key, value, maxBytes } of entries) {
      namespace.parse(scope); objectKey.parse(key);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(value) > maxBytes) throw new Error("Object exceeds its size limit");
    }
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const revisions: number[] = [];
      for (const { scope, key, value, expectedRevision } of entries) {
        const current = this.database.prepare("SELECT revision FROM objects WHERE namespace = ? AND key = ?").get(scope, key) as { revision: number } | undefined;
        if ((expectedRevision === null && current) || (expectedRevision !== null && Number(current?.revision) !== expectedRevision)) {
          throw new ConcurrencyError("SQLite object changed during update");
        }
        const revision = current ? Number(current.revision) + 1 : 1;
        this.database.prepare(`INSERT INTO objects(namespace, key, value, revision, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, revision=excluded.revision, updated_at=excluded.updated_at`)
          .run(scope, key, Buffer.from(value), revision, now);
        revisions.push(revision);
      }
      this.database.exec("COMMIT"); this.secureFiles();
      return revisions;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  initialize(entries: Array<{ namespace: Namespace; key: string; value: string; maxBytes: number }>) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = Number((this.database.prepare("SELECT COUNT(*) AS count FROM objects").get() as { count: number }).count);
      if (existing) { this.database.exec("ROLLBACK"); return false; }
      const insert = this.database.prepare("INSERT INTO objects(namespace, key, value, revision, updated_at) VALUES (?, ?, ?, 1, ?)");
      const now = new Date().toISOString();
      for (const entry of entries) {
        namespace.parse(entry.namespace); objectKey.parse(entry.key);
        if (Buffer.byteLength(entry.value) > entry.maxBytes) throw new Error(`${entry.key} exceeds its size limit`);
        insert.run(entry.namespace, entry.key, Buffer.from(entry.value), now);
      }
      this.database.exec("COMMIT"); this.secureFiles(); return true;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  acquireCollector(owner: string, now = Date.now(), ttlMs = 90_000) {
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(owner) || ttlMs < 30_000 || ttlMs > 300_000) throw new Error("Invalid collector lease");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT owner, expires_at FROM collector_lease WHERE singleton=1").get() as { owner: string; expires_at: number } | undefined;
      if (current && current.owner !== owner && Number(current.expires_at) > now) throw new Error("Another collector owns this database");
      this.database.prepare(`INSERT INTO collector_lease(singleton, owner, expires_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at`).run(owner, now + ttlMs);
      this.database.exec("COMMIT"); return new Date(now + ttlMs).toISOString();
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  releaseCollector(owner: string) {
    this.database.prepare("DELETE FROM collector_lease WHERE singleton=1 AND owner=?").run(owner);
  }
}

export class LocalStateStore implements StateStore {
  constructor(private readonly database: LocalDatabase) {}
  async read() {
    const row = this.database.read("private", STATE_KEY);
    if (!row) throw new Error("Local ingestion state is not initialized");
    if (Buffer.byteLength(row.value) > PRIVATE_STATE_HARD_LIMIT_BYTES) throw new Error("Private ingestion state exceeds 5 MB hard limit");
    const data = parseCatalogState(JSON.parse(row.value));
    return { data, etag: String(row.revision), ...captureStateControl(data) };
  }
  async write(state: IngestionStateV14, expected: Versioned<IngestionStateV14>) {
    const validated = IngestionStateV14Schema.parse(state);
    assertStateControlChange(validated, expected);
    const value = JSON.stringify(validated);
    const revision = this.database.compareAndSwap("private", STATE_KEY, value, Number(expected.etag), PRIVATE_STATE_HARD_LIMIT_BYTES);
    return { etag: String(revision) };
  }
}

export class LocalSnapshotStore implements SnapshotStore {
  constructor(private readonly database: LocalDatabase) {}
  async readLatest() {
    const row = this.database.readPublic(catalogV2Paths.snapshot);
    if (!row) throw new Error("Legacy local snapshot is not initialized");
    return { data: CompleteSnapshotSchema.parse(parseSnapshot(JSON.parse(row.value))), etag: String(row.revision) };
  }
  async publish(snapshot: Snapshot, expected: Versioned<Snapshot>) {
    const value = JSON.stringify(CompleteSnapshotSchema.parse(snapshot));
    const revision = this.database.compareAndSwap("public", catalogV2Paths.snapshot, value, Number(expected.etag), SNAPSHOT_LIMIT_BYTES);
    return { etag: String(revision) };
  }
}

type SnapshotV11 = z.infer<typeof SnapshotV11Schema>;
export class LocalCatalog3SnapshotStore {
  constructor(private readonly database: LocalDatabase) {}
  async readLatest(): Promise<Versioned<SnapshotV11> | undefined> {
    const row = this.database.readPublic(catalogV3Paths.snapshot);
    return row ? { data: SnapshotV11Schema.parse(JSON.parse(row.value)), etag: String(row.revision) } : undefined;
  }
  async publish(snapshot: SnapshotV11, expected?: Versioned<SnapshotV11>, now = new Date()) {
    const candidate = SnapshotV11Schema.parse(snapshot);
    const futureCutoff = now.getTime() + 5 * 60_000;
    if (!Number.isFinite(now.getTime()) || Date.parse(candidate.generatedAt) > futureCutoff) throw new Error("Snapshot generation is in the future");
    if (expected && Date.parse(expected.data.generatedAt) <= futureCutoff && Date.parse(expected.data.generatedAt) >= Date.parse(candidate.generatedAt)) {
      return { etag: expected.etag, status: "unchanged" as const };
    }
    const value = JSON.stringify(candidate);
    const writes: Parameters<LocalDatabase["compareAndSwapBatch"]>[0] = [];
    if (expected) {
      const prior = this.database.readPublic(catalogV3Paths.previousSnapshot);
      if (!prior || Date.parse(JSON.parse(prior.value).generatedAt) < Date.parse(expected.data.generatedAt)) {
        writes.push({ scope: "public", key: catalogV3Paths.previousSnapshot, value: JSON.stringify(expected.data), expectedRevision: prior?.revision ?? null, maxBytes: SNAPSHOT_LIMIT_BYTES });
      }
    }
    writes.push({ scope: "public", key: catalogV3Paths.snapshot, value, expectedRevision: expected ? Number(expected.etag) : null, maxBytes: SNAPSHOT_LIMIT_BYTES });
    const revision = this.database.compareAndSwapBatch(writes).at(-1)!;
    return { etag: String(revision), url: `/live/${catalogV3Paths.snapshot}`, status: "published" as const };
  }
}

type CatalogConditions = Conditions | z.infer<typeof ConditionsV3Schema>;
async function publishConditions(database: LocalDatabase, files: CatalogConditions[], version: 2 | 3, exact: boolean, now: Date): Promise<ConditionsPublicationResult> {
  const parse = (value: unknown) => version === 3 ? ConditionsV3Schema.parse(value) : ConditionsSchema.parse(value);
  const paths = version === 3 ? catalogV3Paths : catalogV2Paths;
  const entries = files.map((input) => {
    const file = parse(input); const body = version === 3 ? serializeCatalog3Conditions(file) : JSON.stringify(file);
    return { file, body, key: `${paths.conditions}${file.countryCode}.json` };
  });
  if (new Set(entries.map(({ file }) => file.countryCode)).size !== entries.length) throw new Error("Duplicate conditions country");
  const cutoff = now.getTime() + 5 * 60_000;
  if (!Number.isFinite(cutoff) || entries.some(({ file }) => Date.parse(file.generatedAt) > cutoff)) throw new Error("Conditions generation is in the future");
  if (version === 3) {
    if (entries.length !== catalogV3CountryCodes.length) throw new Error("Conditions publication requires all 45 countries");
    if (new Set(entries.map(({ file }) => file.generatedAt)).size !== 1
      || new Set(entries.map(({ file }) => "producerCommitSha" in file ? file.producerCommitSha : null)).size !== 1) {
      throw new Error("Conditions publication must be one producer generation");
    }
  } else for (const { file } of entries) {
    const expected = catalogV2.locationIds.filter((id) => id.startsWith(`${file.countryCode.toLowerCase()}-`)).sort();
    if (!expected.length || expected.join(",") !== Object.keys(file.locations).sort().join(",")) throw new Error("Conditions publication catalog mismatch");
  }
  if (entries.reduce((sum, { body }) => sum + Buffer.byteLength(body), 0) > CONDITIONS_TOTAL_LIMIT) throw new Error("Conditions publication exceeds size limits");
  const result: ConditionsPublicationResult = { published: [], unchanged: [], failed: [] };
  const writes: Parameters<LocalDatabase["compareAndSwapBatch"]>[0] = [];
  for (const { file, body, key } of entries) {
    const prior = database.readPublic(key);
    if (prior) {
      const stored = parse(JSON.parse(prior.value));
      if (stored.countryCode !== file.countryCode) throw new Error("Stored conditions country does not match pathname");
      if (Date.parse(stored.generatedAt) <= cutoff && Date.parse(stored.generatedAt) >= Date.parse(file.generatedAt)) {
        if (exact && JSON.stringify(stored) !== JSON.stringify(file)) result.failed.push({ countryCode: file.countryCode, code: "concurrent_update" });
        else result.unchanged.push(file.countryCode);
        continue;
      }
    }
    writes.push({ scope: "public", key, value: body, expectedRevision: prior?.revision ?? null, maxBytes: publicObjectLimit(key) });
    result.published.push(file.countryCode);
  }
  database.compareAndSwapBatch(writes);
  return result;
}

export function localStores(database: LocalDatabase) {
  const stateStore = new LocalStateStore(database);
  const snapshotStore = new LocalSnapshotStore(database);
  const catalog3SnapshotStore = new LocalCatalog3SnapshotStore(database);
  const catalogPublication: CatalogPublicationStores = {
    snapshotStore,
    catalog3SnapshotStore,
    publishLegacyConditions: (files, exact, now) => publishConditions(database, files, 2, exact, now),
    publishCatalog3Conditions: (files, exact, now) => publishConditions(database, files, 3, exact, now),
  };
  return { stateStore, snapshotStore, catalogPublication };
}

export function readLocalPolicy(database: LocalDatabase): { policy: LocalRuntimePolicy; revision: number | null } {
  const row = database.read("private", POLICY_KEY);
  return row ? { policy: LocalRuntimePolicySchema.parse(JSON.parse(row.value)), revision: row.revision }
    : { policy: disabledLocalPolicy(), revision: null };
}

export function writeLocalPolicy(database: LocalDatabase, policy: LocalRuntimePolicy, expectedRevision: number | null) {
  return database.compareAndSwap("private", POLICY_KEY, JSON.stringify(LocalRuntimePolicySchema.parse(policy)), expectedRevision, 4096);
}

export function initializeLocalRuntime(database: LocalDatabase, now = new Date(), environment: Record<string, string | undefined> = process.env) {
  const state = createEmptyState(now);
  state.collection = { catalogVersion: 3, revision: 1 };
  state.publicationTransition = null;
  const validatedState = IngestionStateV14Schema.parse(state);
  const snapshot = buildCatalog3Snapshot(validatedState, now);
  const conditionEnv = { ...environment, LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "false" };
  const conditions = buildCatalog3Conditions(validatedState, now, conditionEnv);
  const entries = [
    { namespace: "private" as const, key: STATE_KEY, value: JSON.stringify(validatedState), maxBytes: PRIVATE_STATE_HARD_LIMIT_BYTES },
    { namespace: "private" as const, key: POLICY_KEY, value: JSON.stringify(disabledLocalPolicy()), maxBytes: 4096 },
    { namespace: "public" as const, key: catalogV3Paths.snapshot, value: JSON.stringify(snapshot), maxBytes: SNAPSHOT_LIMIT_BYTES },
    { namespace: "public" as const, key: catalogV3Paths.previousSnapshot, value: JSON.stringify(snapshot), maxBytes: SNAPSHOT_LIMIT_BYTES },
    ...conditions.map((file) => ({ namespace: "public" as const, key: `${catalogV3Paths.conditions}${file.countryCode}.json`, value: serializeCatalog3Conditions(file), maxBytes: publicObjectLimit(`${catalogV3Paths.conditions}${file.countryCode}.json`) })),
  ];
  const initialized = database.initialize(entries);
  const stored = database.read("private", STATE_KEY);
  const complete = stored && database.read("private", POLICY_KEY)
    && database.readPublic(catalogV3Paths.snapshot) && database.readPublic(catalogV3Paths.previousSnapshot)
    && conditions.every((file) => database.readPublic(`${catalogV3Paths.conditions}${file.countryCode}.json`));
  if (!complete || parseCatalogState(JSON.parse(stored.value)).collection.catalogVersion !== 3) {
    throw new Error("Local runtime is partially initialized");
  }
  return { initialized, catalogVersion: 3 as const, destinations: Object.keys(snapshot.locations).length };
}
