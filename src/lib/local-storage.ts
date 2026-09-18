import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { CatalogPublicationStores } from "./catalog-publication";
import { captureStateControl, assertStateControlChange } from "./publication-control";
import { createEmptyState } from "./risk";
import { IngestionStateV15Schema, IngestionStateV16Schema, parseCatalogState, type IngestionState } from "./domain/catalog-state";
import { PRIVATE_STATE_HARD_LIMIT_BYTES } from "./ingestion/limits";
import { ConcurrencyError, type StateStore, type Versioned } from "./state-store";
import { disabledLocalPolicy, LocalRuntimePolicySchema, type LocalRuntimePolicy } from "./local-policy";
import type { PublicationStore } from "./publication-store";
import { runtimePaths } from "./runtime-paths";

const objectKey = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.split("/").includes(".."), "Object keys cannot traverse namespaces");
const namespace = z.literal("private");
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATE_KEY = "ingestion/state.json";
export const POLICY_KEY = "runtime/policy.json";
export const COLLECTOR_STATUS_KEY = "runtime/collector-status.json";

type Namespace = z.infer<typeof namespace>;
type ObjectRow = { value: Uint8Array | string; revision: number; updated_at: string };
export type LocalObject = { value: string; revision: number; updatedAt: string };

export function localDataDirectory(environment: Record<string, string | undefined> = process.env) {
  return runtimePaths(environment, true).privateRoot;
}

export function localDatabasePath(environment: Record<string, string | undefined> = process.env) {
  const directory = localDataDirectory(environment);
  if (!isAbsolute(directory)) throw new Error("TRAVELCANARY_DATA_DIR must resolve to an absolute path");
  return resolve(directory, "travelcanary.db");
}

function text(row: ObjectRow): string {
  return typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
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
        namespace TEXT NOT NULL CHECK(namespace = 'private'),
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
    const raw = JSON.parse(row.value) as { schemaVersion?: unknown };
    const data = parseCatalogState(raw);
    const legacy = raw.schemaVersion === 15 ? { schemaVersion: 15, raw: row.value } : undefined;
    return { data, etag: String(row.revision), legacy, ...captureStateControl(data) };
  }
  async write(state: IngestionState, expected: Versioned<IngestionState>) {
    const validated = IngestionStateV16Schema.parse({ ...state, stateRevision: state.stateRevision + 1 });
    assertStateControlChange(validated, expected);
    const value = JSON.stringify(validated);
    if (expected.legacy?.schemaVersion === 15) {
      const backup = JSON.stringify(IngestionStateV15Schema.parse(JSON.parse(expected.legacy.raw)));
      const existing = this.database.read("private", "ingestion/state-v15-backup.json");
      if (existing) {
        const existingBody = JSON.stringify(IngestionStateV15Schema.parse(JSON.parse(existing.value)));
        if (existingBody !== backup) throw new ConcurrencyError("V15 backup does not match the state being migrated");
      } else {
        const revisions = this.database.compareAndSwapBatch([
          { scope: "private", key: "ingestion/state-v15-backup.json", value: backup, expectedRevision: null, maxBytes: PRIVATE_STATE_HARD_LIMIT_BYTES },
          { scope: "private", key: STATE_KEY, value, expectedRevision: Number(expected.etag), maxBytes: PRIVATE_STATE_HARD_LIMIT_BYTES },
        ]);
        return { etag: String(revisions[1]) };
      }
    }
    const revision = this.database.compareAndSwap("private", STATE_KEY, value, Number(expected.etag), PRIVATE_STATE_HARD_LIMIT_BYTES);
    return { etag: String(revision) };
  }
}

export function localStores(database: LocalDatabase, publicationStore: PublicationStore) {
  const stateStore = new LocalStateStore(database);
  const catalogPublication: CatalogPublicationStores = { publicationStore };
  return { stateStore, catalogPublication };
}

export function readLocalPolicy(database: LocalDatabase): { policy: LocalRuntimePolicy; revision: number | null } {
  const row = database.read("private", POLICY_KEY);
  return row ? { policy: LocalRuntimePolicySchema.parse(JSON.parse(row.value)), revision: row.revision }
    : { policy: disabledLocalPolicy(), revision: null };
}

export function writeLocalPolicy(database: LocalDatabase, policy: LocalRuntimePolicy, expectedRevision: number | null) {
  return database.compareAndSwap("private", POLICY_KEY, JSON.stringify(LocalRuntimePolicySchema.parse(policy)), expectedRevision, 4096);
}

export function initializeLocalRuntime(database: LocalDatabase, now = new Date()) {
  const state = createEmptyState(now);
  const validatedState = IngestionStateV16Schema.parse(state);
  const entries = [
    { namespace: "private" as const, key: STATE_KEY, value: JSON.stringify(validatedState), maxBytes: PRIVATE_STATE_HARD_LIMIT_BYTES },
    { namespace: "private" as const, key: POLICY_KEY, value: JSON.stringify(disabledLocalPolicy()), maxBytes: 4096 },
  ];
  const initialized = database.initialize(entries);
  const stored = database.read("private", STATE_KEY);
  const complete = stored && database.read("private", POLICY_KEY);
  if (!complete || parseCatalogState(JSON.parse(stored.value)).collection.catalogVersion !== 3) {
    throw new Error("Local runtime is partially initialized");
  }
  return { initialized, catalogVersion: 3 as const, destinations: 679 };
}
