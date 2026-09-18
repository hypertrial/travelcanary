import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { IngestionStateV15Schema, IngestionStateV16Schema, parseCatalogState, parseCatalogStateV15, type IngestionState } from "./domain/catalog-state";
import { PRIVATE_STATE_HARD_LIMIT_BYTES } from "./ingestion/limits";
import { assertStateControlChange, captureStateControl, type CapturedStateControl } from "./publication-control";

export type Versioned<T> = CapturedStateControl & { data: T; etag: string; legacy?: { schemaVersion: number; raw: string } };
export type WriteResult = { etag: string; url?: string };
export interface StateStore {
  read(): Promise<Versioned<IngestionState>>;
  write(state: IngestionState, expected: Versioned<IngestionState>): Promise<WriteResult>;
}
export class ConcurrencyError extends Error {}

function etag(value: string) {
  const normalized = value.startsWith("W/") ? value.slice(2) : value;
  if (!normalized) throw new Error("Blob read did not return an ETag");
  return normalized;
}

function stateForWrite(state: IngestionState, before: CapturedStateControl) {
  const next = IngestionStateV16Schema.parse({ ...state, stateRevision: state.stateRevision + 1 });
  assertStateControlChange(next, before);
  if (Buffer.byteLength(JSON.stringify(next)) > PRIVATE_STATE_HARD_LIMIT_BYTES) throw new Error("Private ingestion state exceeds 5 MB hard limit");
  return next;
}

export class BlobStateStore implements StateStore {
  constructor(private readonly token: string, private readonly pathname = "ingestion-state.json",
    private readonly getBlob: typeof get = get, private readonly putBlob: typeof put = put) {
    if (!token.trim()) throw new Error("Private Blob token is required");
  }
  async read() {
    const result = await this.getBlob(this.pathname, { token: this.token, access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new BlobNotFoundError();
    const raw = await new Response(result.stream).text();
    const value = JSON.parse(raw) as { schemaVersion?: unknown };
    const data = parseCatalogState(value);
    const legacy = typeof value.schemaVersion === "number" && value.schemaVersion <= 15 ? { schemaVersion: value.schemaVersion, raw } : undefined;
    return { data, etag: etag(result.blob.etag), legacy, ...captureStateControl(data) };
  }
  private async preserveV15Backup(raw: string) {
    const pathname = "ingestion-state-v15-backup.json";
    const body = JSON.stringify(parseCatalogStateV15(JSON.parse(raw)));
    let existing: Awaited<ReturnType<typeof get>> | null = null;
    try { existing = await this.getBlob(pathname, { token: this.token, access: "private", useCache: false }); }
    catch (error) { if (!(error instanceof BlobNotFoundError)) throw error; }
    if (existing?.statusCode === 200 && existing.stream) {
      const existingBody = JSON.stringify(IngestionStateV15Schema.parse(JSON.parse(await new Response(existing.stream).text())));
      if (existingBody !== body) throw new ConcurrencyError("V15 backup does not match the state being migrated");
      return;
    }
    try {
      await this.putBlob(pathname, body, { token: this.token, access: "private", allowOverwrite: false,
        contentType: "application/json", cacheControlMaxAge: 60 });
    } catch (error) {
      let raced: Awaited<ReturnType<typeof get>> | null = null;
      try { raced = await this.getBlob(pathname, { token: this.token, access: "private", useCache: false }); }
      catch (readError) { if (!(readError instanceof BlobNotFoundError)) throw readError; }
      if (!raced || raced.statusCode !== 200 || !raced.stream) throw error;
      const racedBody = JSON.stringify(IngestionStateV15Schema.parse(JSON.parse(await new Response(raced.stream).text())));
      if (racedBody !== body) throw new ConcurrencyError("V15 backup does not match the state being migrated");
    }
  }
  async write(state: IngestionState, expected: Versioned<IngestionState>) {
    const validated = stateForWrite(state, expected);
    try {
      if (expected.legacy) await this.preserveV15Backup(expected.legacy.raw);
      const result = await this.putBlob(this.pathname, JSON.stringify(validated), { token: this.token, access: "private",
        allowOverwrite: true, ifMatch: expected.etag, contentType: "application/json", cacheControlMaxAge: 60 });
      return { etag: result.etag, url: result.url };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConcurrencyError("Private state changed during ingestion");
      throw error;
    }
  }
}

export class MemoryStateStore implements StateStore {
  private version = 1;
  private data: IngestionState;
  constructor(data: IngestionState) { this.data = IngestionStateV16Schema.parse(data); }
  async read() { return { data: structuredClone(this.data), etag: String(this.version), ...captureStateControl(this.data) }; }
  async write(state: IngestionState, expected: Versioned<IngestionState>) {
    if (expected.etag !== String(this.version)) throw new ConcurrencyError("State conflict");
    this.data = stateForWrite(state, captureStateControl(this.data)); this.version += 1;
    return { etag: String(this.version) };
  }
}
