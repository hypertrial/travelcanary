import { catalog3ConditionsCountryLimit } from "./conditions/publication-budget";
import { serializeCatalog3Conditions } from "./conditions/serialization";
import { assertStateControlChange, captureStateControl, type CapturedStateControl } from "./publication-control";
import { IngestionStateV13Schema, IngestionStateV14Schema, parseCatalogState, type IngestionStateV14 as IngestionState } from "./domain/catalog-state";
import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from "@vercel/blob";
import {
  IngestionStateV1Schema,
  IngestionStateV2Schema,
  IngestionStateV3Schema,
  IngestionStateV4Schema,
  IngestionStateV5Schema,
  IngestionStateV6Schema,
  IngestionStateV7Schema,
  IngestionStateV8Schema,
  IngestionStateV9Schema,
  IngestionStateV10Schema,
  IngestionStateV11Schema,
  IngestionStateV12Schema,
  SnapshotV2Schema,
  SnapshotV3Schema,
  SnapshotV4Schema,
  SnapshotV5Schema,
  SnapshotV6Schema,
  SnapshotV7Schema,
  SnapshotV8Schema,
  SnapshotV9Schema,
  parseSnapshot,
  type Snapshot,
} from "./domain/schemas";
import { CompleteSnapshotSchema } from "./snapshot-validation";
import { CONDITIONS_COUNTRY_LIMIT, CONDITIONS_TOTAL_LIMIT, ConditionsSchema, type Conditions } from "./domain/conditions";
import { mapConcurrent, readBytesWithLimit } from "./ingestion/fetch";
import { ConditionsV3Schema, SnapshotV11Schema, type CatalogSnapshot } from "./domain/catalog-public";
import { PRIVATE_STATE_HARD_LIMIT_BYTES } from "./ingestion/limits";
import catalogV2 from "../../data/catalog-releases/2.json";
import { catalogV3CountryCodes } from "./domain/contract-identities";
import { catalogV2Paths, catalogV3Paths } from "./catalog-paths";

export type Versioned<T> = CapturedStateControl & {
  data: T;
  etag: string;
  legacy?: { schemaVersion: number; raw: string };
};
export type WriteResult = { etag: string; url?: string };

export interface StateStore {
  read(): Promise<Versioned<IngestionState>>;
  write(state: IngestionState, expected: Versioned<IngestionState>): Promise<WriteResult>;
}
export interface SnapshotStore {
  readLatest(): Promise<Versioned<Snapshot>>;
  publish(snapshot: Snapshot, expected: Versioned<Snapshot>): Promise<WriteResult>;
}

export class ConcurrencyError extends Error {}

type GetBlob = typeof get;
type HeadBlob = typeof head;
type PutBlob = typeof put;

function conditionalEtag(etag: string) {
  // Blob content responses can expose the current object ETag as a weak HTTP
  // validator. If-Match uses strong comparison, so sending the `W/` prefix
  // makes every otherwise-valid conditional write fail.
  const normalized = etag.startsWith("W/") ? etag.slice(2) : etag;
  if (!normalized) throw new Error("Blob read did not return an ETag");
  return normalized;
}

function legacyJson(value: unknown, raw: string, versions: readonly number[]) {
  const schemaVersion = typeof value === "object" && value !== null && "schemaVersion" in value
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  return typeof schemaVersion === "number" && versions.includes(schemaVersion)
    ? { schemaVersion, raw }
    : undefined;
}

async function readBlobJson<T>(pathname: string, token: string, access: "public" | "private", parse: (value: unknown) => T, legacyVersions: readonly number[], getBlob: GetBlob = get): Promise<Versioned<T>> {
  const result = await getBlob(pathname, { token, access, useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) throw new BlobNotFoundError();
  const text = await new Response(result.stream).text();
  const value = JSON.parse(text);
  return { data: parse(value), etag: conditionalEtag(result.blob.etag), legacy: legacyJson(value, text, legacyVersions) };
}

async function readPublicBlobJson<T>(pathname: string, token: string, parse: (value: unknown) => T, getBlob: GetBlob, headBlob: HeadBlob, legacyVersions: readonly number[] = [], maxBytes?: number): Promise<Versioned<T>> {
  const metadata = await headBlob(pathname, { token });
  const etag = conditionalEtag(metadata.etag);
  const url = new URL(metadata.url);
  url.searchParams.set("etag", etag);
  const result = await getBlob(url.toString(), { token, access: "public" });
  if (!result || result.statusCode !== 200 || !result.stream) throw new BlobNotFoundError();
  if (conditionalEtag(result.blob.etag) !== etag) throw new ConcurrencyError("Public snapshot changed during read");
  const response = new Response(result.stream);
  const text = maxBytes === undefined ? await response.text() : new TextDecoder().decode(await readBytesWithLimit(response, maxBytes));
  const value = JSON.parse(text);
  return { data: parse(value), etag, legacy: legacyJson(value, text, legacyVersions) };
}

async function preserveJsonBackup(options: {
  pathname: string;
  raw: string;
  token: string;
  access: "public" | "private";
  validate: (value: unknown) => unknown;
  getBlob: GetBlob;
  putBlob: PutBlob;
}) {
  const validExistingBackup = async () => {
    const existing = await options.getBlob(options.pathname, { token: options.token, access: options.access, useCache: false });
    if (!existing || existing.statusCode !== 200 || !existing.stream) return false;
    options.validate(JSON.parse(await new Response(existing.stream).text()));
    return true;
  };
  if (await validExistingBackup()) return;
  try {
    await options.putBlob(options.pathname, options.raw, { token: options.token, access: options.access, allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 });
  } catch (error) {
    // A concurrent cutover may create the immutable object between the read
    // and write. Accept only a subsequently readable, schema-valid backup.
    if (await validExistingBackup()) return;
    throw error;
  }
}

function stateForWrite(state: IngestionState, before: CapturedStateControl) {
  const next = IngestionStateV14Schema.parse(state);
  assertStateControlChange(next, before);
  if (Buffer.byteLength(JSON.stringify(next)) > PRIVATE_STATE_HARD_LIMIT_BYTES) throw new Error("Private ingestion state exceeds 5 MB hard limit");
  return next;
}

export class BlobStateStore implements StateStore {
  constructor(private token: string, private pathname = "ingestion-state.json", private getBlob: GetBlob = get, private putBlob: PutBlob = put) {}
  async read() {
    const state = await readBlobJson(this.pathname, this.token, "private", parseCatalogState, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], this.getBlob);
    return { ...state, ...captureStateControl(state.data) };
  }
  async write(state: IngestionState, expected: Versioned<IngestionState>) {
    const validated = stateForWrite(state, expected);
    try {
      if (expected.legacy) {
        const { schemaVersion: version, raw } = expected.legacy;
        const pathname = `ingestion-state-v${version}-backup.json`;
        const validate = version === 13 ? IngestionStateV13Schema.parse : version === 12 ? IngestionStateV12Schema.parse : version === 11 ? IngestionStateV11Schema.parse : version === 10 ? IngestionStateV10Schema.parse : version === 9 ? IngestionStateV9Schema.parse : version === 8 ? IngestionStateV8Schema.parse : version === 7 ? IngestionStateV7Schema.parse : version === 6 ? IngestionStateV6Schema.parse : version === 5 ? IngestionStateV5Schema.parse : version === 4 ? IngestionStateV4Schema.parse : version === 3 ? IngestionStateV3Schema.parse : version === 2 ? IngestionStateV2Schema.parse : IngestionStateV1Schema.parse;
        await preserveJsonBackup({ pathname, raw, token: this.token, access: "private", validate, getBlob: this.getBlob, putBlob: this.putBlob });
      }
      const result = await this.putBlob(this.pathname, JSON.stringify(validated), { token: this.token, access: "private", allowOverwrite: true, ifMatch: expected.etag, contentType: "application/json", cacheControlMaxAge: 60 });
      return { etag: result.etag, url: result.url };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConcurrencyError("Private state changed during ingestion");
      throw error;
    }
  }
}

async function advancePreviousSnapshot<T extends CatalogSnapshot>(snapshot: T, pathname: string, token: string,
  parse: (value: unknown) => T, getBlob: GetBlob, putBlob: PutBlob, headBlob: HeadBlob, maxBytes?: number, futureCutoff?: number) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let previous: Versioned<T>;
    try {
      previous = await readPublicBlobJson(pathname, token, parse, getBlob, headBlob, [], maxBytes);
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) throw error;
      try {
        await putBlob(pathname, JSON.stringify(snapshot), { token, access: "public", allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 });
        return;
      } catch (creationError) {
        if (!(creationError instanceof BlobPreconditionFailedError) || attempt === 1) throw creationError;
        continue;
      }
    }
    if ((futureCutoff === undefined || Date.parse(previous.data.generatedAt) <= futureCutoff)
      && Date.parse(previous.data.generatedAt) >= Date.parse(snapshot.generatedAt)) return;
    try {
      await putBlob(pathname, JSON.stringify(snapshot), { token, access: "public", allowOverwrite: true, ifMatch: previous.etag, contentType: "application/json", cacheControlMaxAge: 60 });
      return;
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError)) throw error;
      if (attempt === 1) throw new Error("Rollback snapshot changed after latest publication");
    }
  }
}

export class BlobSnapshotStore implements SnapshotStore {
  constructor(private token: string, private getBlob: GetBlob = get, private putBlob: PutBlob = put, private headBlob: HeadBlob = head) {}
  readLatest() { return readPublicBlobJson(catalogV2Paths.snapshot, this.token, (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), this.getBlob, this.headBlob, [1, 2, 3, 4, 5, 6, 7, 8, 9]); }
  async publish(snapshot: Snapshot, expected: Versioned<Snapshot>) {
    try {
      if (expected.legacy) {
        const { schemaVersion: version, raw } = expected.legacy;
        await preserveJsonBackup({
          pathname: `snapshot-v${version}-backup.json`, raw, token: this.token, access: "public",
          validate: version === 9 ? SnapshotV9Schema.parse : version === 8 ? SnapshotV8Schema.parse : version === 7 ? SnapshotV7Schema.parse : version === 6 ? SnapshotV6Schema.parse : version === 5 ? SnapshotV5Schema.parse : version === 4 ? SnapshotV4Schema.parse : version === 3 ? SnapshotV3Schema.parse : version === 2 ? SnapshotV2Schema.parse : (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), getBlob: this.getBlob, putBlob: this.putBlob,
        });
      }
      const result = await this.putBlob(catalogV2Paths.snapshot, JSON.stringify(CompleteSnapshotSchema.parse(snapshot)), { token: this.token, access: "public", allowOverwrite: true, ifMatch: expected.etag, contentType: "application/json", cacheControlMaxAge: 60 });
      const latest = await this.headBlob(catalogV2Paths.snapshot, { token: this.token });
      if (conditionalEtag(latest.etag) !== conditionalEtag(result.etag)) return { etag: result.etag, url: result.url };
      if (Date.parse(expected.data.generatedAt) <= Date.parse(snapshot.generatedAt) + 5 * 60_000) {
        await advancePreviousSnapshot(expected.data, catalogV2Paths.previousSnapshot, this.token,
          (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), this.getBlob, this.putBlob, this.headBlob);
      }
      return { etag: result.etag, url: result.url };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConcurrencyError("Public snapshot changed during ingestion");
      throw error;
    }
  }
}

type SnapshotV11 = Extract<CatalogSnapshot, { catalogVersion: 3 }>;
const SNAPSHOT_LIMIT_BYTES = 500_000;

/** Versioned public store used only when private collection control selects catalog 3. */
export class BlobCatalog3SnapshotStore {
  constructor(private token: string, private getBlob: GetBlob = get, private putBlob: PutBlob = put, private headBlob: HeadBlob = head) {}
  async readLatest(): Promise<Versioned<SnapshotV11> | undefined> {
    try { return await readPublicBlobJson(catalogV3Paths.snapshot, this.token, SnapshotV11Schema.parse, this.getBlob, this.headBlob, [], SNAPSHOT_LIMIT_BYTES); }
    catch (error) { if (error instanceof BlobNotFoundError) return undefined; throw error; }
  }
  async publish(snapshot: SnapshotV11, expected?: Versioned<SnapshotV11>, now = new Date()) {
    const candidate = SnapshotV11Schema.parse(snapshot);
    const body = JSON.stringify(candidate);
    const futureCutoff = now.getTime() + 5 * 60_000;
    if (!Number.isFinite(now.getTime()) || Date.parse(candidate.generatedAt) > futureCutoff) throw new Error("Snapshot generation is in the future");
    if (Buffer.byteLength(body) > SNAPSHOT_LIMIT_BYTES) throw new Error("Snapshot exceeds 500 KB hard limit");
    const prior = expected ? SnapshotV11Schema.parse(expected.data) : undefined;
    if (prior && Buffer.byteLength(JSON.stringify(prior)) > SNAPSHOT_LIMIT_BYTES) throw new Error("Prior snapshot exceeds 500 KB hard limit");
    if (prior && Date.parse(prior.generatedAt) <= futureCutoff && Date.parse(prior.generatedAt) >= Date.parse(candidate.generatedAt)) {
      return { etag: expected!.etag, status: "unchanged" as const };
    }
    try {
      // Retain the last valid generation before latest advances. A failed latest
      // CAS can leave previous equal to latest; this is not an atomic pair.
      if (prior && Date.parse(prior.generatedAt) <= futureCutoff) {
        await advancePreviousSnapshot(prior, catalogV3Paths.previousSnapshot, this.token, SnapshotV11Schema.parse,
          this.getBlob, this.putBlob, this.headBlob, SNAPSHOT_LIMIT_BYTES, futureCutoff);
      }
      const result = await this.putBlob(catalogV3Paths.snapshot, body, { token: this.token, access: "public",
        allowOverwrite: Boolean(expected), ...(expected ? { ifMatch: expected.etag } : {}),
        contentType: "application/json", cacheControlMaxAge: 60 });
      return { etag: result.etag, url: result.url, status: "published" as const };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConcurrencyError("Catalog 3 snapshot changed during publication");
      throw error;
    }
  }
}

export class MemoryStateStore implements StateStore {
  private version = 1;
  private data: IngestionState;
  constructor(data: IngestionState) { this.data = IngestionStateV14Schema.parse(data); }
  async read() { return { data: structuredClone(this.data), etag: String(this.version), ...captureStateControl(this.data) }; }
  async write(state: IngestionState, expected: Versioned<IngestionState>) {
    if (expected.etag !== String(this.version)) throw new ConcurrencyError("State conflict");
    this.data = stateForWrite(state, captureStateControl(this.data)); this.version += 1; return { etag: String(this.version) };
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  private version = 1;
  constructor(private data: Snapshot) {}
  async readLatest() { return { data: structuredClone(this.data), etag: String(this.version) }; }
  async publish(snapshot: Snapshot, expected: Versioned<Snapshot>) {
    if (expected.etag !== String(this.version)) throw new ConcurrencyError("Snapshot conflict");
    this.data = structuredClone(snapshot); this.version += 1; return { etag: String(this.version) };
  }
}

export type ConditionsPublicationResult = {
  published: Conditions["countryCode"][];
  unchanged: Conditions["countryCode"][];
  failed: Array<{ countryCode: Conditions["countryCode"]; code: "read_failed" | "write_failed" | "concurrent_update" }>;
};

const publicationRetryDelay = (attempt: number) => new Promise((resolve) => setTimeout(resolve, attempt ? 500 : 150));

type CatalogConditions = Conditions | import("zod").infer<typeof ConditionsV3Schema>;
type PublicationDependencies = { getBlob?: GetBlob; headBlob?: HeadBlob; putBlob?: PutBlob; now?: Date; requireExactGeneration?: boolean };

export async function publishConditionsFiles(files: Conditions[], token: string, dependencies: PublicationDependencies = {}): Promise<ConditionsPublicationResult> {
  return publishCountryFiles(files, token, 2, dependencies);
}

/** Versioned country publication with immutable per-country wire budgets. */
export async function publishCatalog3ConditionsFiles(files: import("zod").infer<typeof ConditionsV3Schema>[], token: string, dependencies: PublicationDependencies = {}): Promise<ConditionsPublicationResult> {
  return publishCountryFiles(files, token, 3, dependencies);
}

async function publishCountryFiles(files: CatalogConditions[], token: string, version: 2 | 3, dependencies: PublicationDependencies): Promise<ConditionsPublicationResult> {
  const getBlob = dependencies.getBlob || get; const headBlob = dependencies.headBlob || head; const putBlob = dependencies.putBlob || put;
  const parse = (value: unknown) => version === 3 ? ConditionsV3Schema.parse(value) : ConditionsSchema.parse(value);
  const paths = version === 3 ? catalogV3Paths : catalogV2Paths;
  const entries = files.map((input) => {
    const file = parse(input);
    return { file, body: version === 3 ? serializeCatalog3Conditions(file) : JSON.stringify(file) };
  });
  if (new Set(files.map((file) => file.countryCode)).size !== files.length) throw new Error("Duplicate conditions country");
  const futureCutoff = version === 3 || dependencies.requireExactGeneration ? (dependencies.now || new Date()).getTime() + 5 * 60_000 : undefined;
  if (version === 3) {
    if (entries.length !== catalogV3CountryCodes.length) throw new Error("Conditions publication requires all 45 countries");
    if (new Set(entries.map(({ file }) => file.generatedAt)).size !== 1
      || new Set(entries.map(({ file }) => file.producerCommitSha)).size !== 1) throw new Error("Conditions publication must be one producer generation");
  }
  if (futureCutoff !== undefined && (!Number.isFinite(futureCutoff) || entries.some(({ file }) => Date.parse(file.generatedAt) > futureCutoff))) {
    throw new Error("Conditions generation is in the future");
  }
  if (version === 2) for (const { file } of entries) {
    const expected = catalogV2.locationIds.filter((id) => id.startsWith(`${file.countryCode.toLowerCase()}-`)).sort();
    if (!expected.length || expected.join(",") !== Object.keys(file.locations).sort().join(",")) throw new Error("Conditions publication catalog mismatch");
  }
  if (entries.some(({ file, body }) => Buffer.byteLength(body) > (version === 3 ? catalog3ConditionsCountryLimit(file.countryCode) : CONDITIONS_COUNTRY_LIMIT))
    || entries.reduce((total, { body }) => total + Buffer.byteLength(body), 0) > CONDITIONS_TOTAL_LIMIT) throw new Error("Conditions publication exceeds size limits");
  const outcomes = await mapConcurrent(entries, 4, async ({ file, body }) => {
    const pathname = `${paths.conditions}${file.countryCode}.json`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let previous: Versioned<CatalogConditions> | undefined;
      try {
        previous = await readPublicBlobJson(pathname, token, (value) => {
          const stored = parse(value);
          if (stored.countryCode !== file.countryCode) throw new Error("Stored conditions country does not match pathname");
          return stored;
        }, getBlob, headBlob, [], version === 3 ? catalog3ConditionsCountryLimit(file.countryCode) : CONDITIONS_COUNTRY_LIMIT);
      }
      catch (error) {
        if (!(error instanceof BlobNotFoundError)) {
          if (attempt < 2) { await publicationRetryDelay(attempt); continue; }
          return { countryCode: file.countryCode, status: "failed" as const, code: error instanceof ConcurrencyError ? "concurrent_update" as const : "read_failed" as const };
        }
      }
      if (previous && (futureCutoff === undefined || Date.parse(previous.data.generatedAt) <= futureCutoff)
        && Date.parse(previous.data.generatedAt) >= Date.parse(file.generatedAt)) {
        if (dependencies.requireExactGeneration && JSON.stringify(previous.data) !== JSON.stringify(file)) {
          return { countryCode: file.countryCode, status: "failed" as const, code: "concurrent_update" as const };
        }
        return { countryCode: file.countryCode, status: "unchanged" as const };
      }
      try {
        await putBlob(pathname, body, { token, access: "public", contentType: "application/json", cacheControlMaxAge: 60,
          allowOverwrite: Boolean(previous), ...(previous ? { ifMatch: previous.etag } : {}) });
        return { countryCode: file.countryCode, status: "published" as const };
      } catch (error) {
        // First-creation races also need a fresh read; never overwrite without an ETag.
        if (attempt < 2) { await publicationRetryDelay(attempt); continue; }
        return { countryCode: file.countryCode, status: "failed" as const,
          code: error instanceof BlobPreconditionFailedError ? "concurrent_update" as const : "write_failed" as const };
      }
    }
    return { countryCode: file.countryCode, status: "failed" as const, code: "concurrent_update" as const };
  });
  return {
    published: outcomes.filter(({ status }) => status === "published").map(({ countryCode }) => countryCode).sort(),
    unchanged: outcomes.filter(({ status }) => status === "unchanged").map(({ countryCode }) => countryCode).sort(),
    failed: outcomes.filter((outcome): outcome is Extract<typeof outcome, { status: "failed" }> => outcome.status === "failed")
      .map(({ countryCode, code }) => ({ countryCode, code })).sort((a, b) => a.countryCode.localeCompare(b.countryCode)),
  };
}
