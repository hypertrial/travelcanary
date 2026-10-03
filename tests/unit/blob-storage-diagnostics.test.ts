import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobError, BlobPreconditionFailedError } from "@vercel/blob";
import { ZodError } from "zod";
import { parseCatalogStateV15 } from "@/lib/domain/catalog-state";
import { acquireIngestionLease } from "@/lib/ingestion-lease";
import { runIngestion } from "@/lib/ingestion/orchestrator";
import { BlobPublicationStore, publicationSha256, readCurrentPublication } from "@/lib/publication-store";
import { captureStateControl } from "@/lib/publication-control";
import { createEmptyState } from "@/lib/risk";
import { BlobStateStore, ConcurrencyError, MemoryStateStore } from "@/lib/state-store";
import { createLegacyState } from "../fixtures/legacy-state";

const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", async () => ({
  ...await vi.importActual<typeof import("@vercel/blob")>("@vercel/blob"),
  get: blob.get, put: blob.put,
}));

const now = new Date("2026-10-03T12:00:00Z");
const state = createEmptyState(now);
const expected = { data: state, etag: '"old"', ...captureStateControl(state) };
const privatePath = "private/secret-sentinel/state.json";
const pointerPath = "catalogs/3/publication/latest.json";
const body = "body";
const immutablePath = `catalogs/3/objects/sha256/${publicationSha256(body)}.json`;
const secret = "https://blob.example/private/path?token=secret-sentinel";
const privateStore = new BlobStateStore("synthetic-token", privatePath);
const publicStore = new BlobPublicationStore("synthetic-token");

function response(value: string) {
  return { statusCode: 200, stream: new Response(value).body,
    blob: { size: Buffer.byteLength(value), etag: 'W/"old"', url: secret, uploadedAt: now } };
}

const operations = [
  ["private_read", blob.get, () => privateStore.read()],
  ["public_read", blob.get, () => publicStore.read(pointerPath, 64)],
  ["private_write", blob.put, () => privateStore.write(state, expected)],
  ["immutable_write", blob.put, () => publicStore.putImmutable(immutablePath, body)],
  ["pointer_write", blob.put, () => publicStore.replacePointer(body, expected.etag)],
] as const;

describe("redacted Blob storage diagnostics", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    blob.get.mockReset().mockImplementation(async (pathname: string) => response(pathname === privatePath ? JSON.stringify(state) : body));
    blob.put.mockReset().mockResolvedValue({ etag: '"new"', url: secret });
    log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function expectDiagnostic(operation: string) {
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ event: "blob_storage_failed", operation });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-sentinel");
    expect(info).not.toHaveBeenCalled();
  }

  it.each(operations)("labels an unexpected %s SDK rejection without changing its identity", async (operation, sdk, invoke) => {
    const error = new BlobError(`Failed to fetch blob: 403 ${secret}`);
    sdk.mockRejectedValue(error);
    if (operation === "immutable_write") blob.get.mockResolvedValue(null);
    await expect(invoke()).rejects.toBe(error);
    expectDiagnostic(operation);
    expect(sdk).toHaveBeenCalledTimes(1);
  });

  it.each(operations)("does not read or serialize hostile thrown values during %s", async (operation, sdk, invoke) => {
    let reads = 0;
    const error = Object.defineProperties({}, Object.fromEntries(["message", "stack", "name", "toString", "toJSON"]
      .map((key) => [key, { get() { reads += 1; throw new Error(secret); } }])));
    sdk.mockRejectedValue(error);
    if (operation === "immutable_write") blob.get.mockResolvedValue(null);
    await expect(invoke()).rejects.toBe(error);
    expectDiagnostic(operation);
    expect(reads).toBe(0);
  });

  it.each(operations)("does not log successful %s SDK calls", async (_operation, sdk, invoke) => {
    await expect(invoke()).resolves.toBeDefined();
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(operations.slice(2))("keeps expected ConcurrencyError silent during %s", async (_operation, sdk, invoke) => {
    const error = new ConcurrencyError(secret);
    sdk.mockRejectedValue(error);
    await expect(invoke()).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([operations[2], operations[4]])("keeps expected SDK precondition conflicts silent during %s", async (_operation, sdk, invoke) => {
    sdk.mockRejectedValue(new BlobPreconditionFailedError());
    await expect(invoke()).rejects.toBeInstanceOf(ConcurrencyError);
    expect(log).not.toHaveBeenCalled();
  });

  it("verifies matching immutable content with a bounded read after a precondition conflict", async () => {
    blob.put.mockRejectedValue(new BlobPreconditionFailedError());
    await expect(publicStore.putImmutable(immutablePath, body)).resolves.toEqual({ url: secret });
    expect(blob.get).toHaveBeenCalledOnce();
    expect(blob.get).toHaveBeenCalledWith(immutablePath, expect.objectContaining({ access: "public", useCache: false }));
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it.each(["different", "missing", "oversized"])("does not accept %s immutable conflict verification or mislabel it as a PUT failure", async (kind) => {
    blob.put.mockRejectedValue(new BlobPreconditionFailedError());
    blob.get.mockResolvedValue(kind === "missing" ? null : response(kind === "different" ? "evil" : "oversized"));
    if (kind === "oversized") await expect(publicStore.putImmutable(immutablePath, body)).rejects.toThrow("Invalid publication object size");
    else await expect(publicStore.putImmutable(immutablePath, body)).rejects.toBeInstanceOf(ConcurrencyError);
    expect(blob.get).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("labels only the public read when immutable-conflict verification GET rejects", async () => {
    const error = new BlobError(`Failed to fetch blob: 503 ${secret}`);
    blob.put.mockRejectedValue(new BlobPreconditionFailedError());
    blob.get.mockRejectedValue(error);
    await expect(publicStore.putImmutable(immutablePath, body)).rejects.toBe(error);
    expectDiagnostic("public_read");
    expect(blob.put).toHaveBeenCalledOnce();
    expect(blob.get).toHaveBeenCalledOnce();
  });

  it.each(["read", "write"])("does not mislabel a V15 backup %s failure as the main private write", async (stage) => {
    const error = new BlobError(secret);
    const legacy = { schemaVersion: 15, raw: JSON.stringify(parseCatalogStateV15(createLegacyState(now))) };
    blob.get.mockResolvedValue(null);
    if (stage === "read") blob.get.mockRejectedValue(error);
    else blob.put.mockRejectedValue(error);
    await expect(privateStore.write(state, { ...expected, legacy })).rejects.toBe(error);
    expect(blob.put).toHaveBeenCalledTimes(stage === "write" ? 1 : 0);
    if (stage === "write") expect(blob.put.mock.calls[0][0]).toBe("ingestion-state-v15-backup.json");
    expect(log).not.toHaveBeenCalled();
  });

  it("does not mislabel schema validation before PUT as a private write failure", async () => {
    await expect(privateStore.write({ ...state, ingestionFence: -1 }, expected)).rejects.toBeInstanceOf(ZodError);
    expect(blob.put).not.toHaveBeenCalled();
    expect(blob.get).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["generic SDK error", new BlobError(secret)],
    ["ambiguous network error", new Error(secret)],
    ["string rejection", secret],
    ["null rejection", null],
    ["hostile object", Object.defineProperty({}, "message", { get() { throw new Error(secret); } })],
  ])("recovers an equal immutable object after %s without logging the rejected PUT", async (_label, error) => {
    blob.put.mockRejectedValue(error);
    await expect(publicStore.putImmutable(immutablePath, body)).resolves.toEqual({ url: secret });
    expect(blob.get).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([[JSON.stringify({ event: "immutable_write_recovered" })]]);
  });

  it("uses the UTF-8 byte bound when verifying an equal non-ASCII immutable object", async () => {
    const value = "é";
    blob.put.mockRejectedValue(new BlobError(secret));
    blob.get.mockResolvedValue(response(value));
    await expect(publicStore.putImmutable(`catalogs/3/objects/sha256/${publicationSha256(value)}.json`, value)).resolves.toEqual({ url: secret });
    expect(log).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([[JSON.stringify({ event: "immutable_write_recovered" })]]);
  });

  it.each(["different", "missing", "oversized"])("preserves the original generic PUT error after %s immutable verification", async (kind) => {
    const error = new BlobError(secret);
    blob.put.mockRejectedValue(error);
    blob.get.mockResolvedValue(kind === "missing" ? null : response(kind === "different" ? "evil" : "oversized"));
    await expect(publicStore.putImmutable(immutablePath, body)).rejects.toBe(error);
    expect(blob.get).toHaveBeenCalledOnce();
    expectDiagnostic("immutable_write");
  });

  it("preserves the original generic PUT error when its verification GET also fails", async () => {
    const error = new BlobError(`PUT ${secret}`);
    const readError = new BlobError(`GET ${secret}`);
    blob.put.mockRejectedValue(error);
    blob.get.mockRejectedValue(readError);
    await expect(publicStore.putImmutable(immutablePath, body)).rejects.toBe(error);
    expect(blob.get).toHaveBeenCalledOnce();
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual(expect.arrayContaining([
      { event: "blob_storage_failed", operation: "public_read" },
      { event: "blob_storage_failed", operation: "immutable_write" },
    ]));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-sentinel");
    expect(info).not.toHaveBeenCalled();
  });

  it("finishes a pointer CAS retry despite generic SDK duplicate immutable errors and commits private state once", async () => {
    const stateStore = new MemoryStateStore(createEmptyState(now));
    const lease = await acquireIngestionLease(stateStore, "blob-publication-retry", now, 330_000);
    if (!lease) throw new Error("Test lease unavailable");
    const write = vi.spyOn(stateStore, "write");
    const objects = new Map<string, string>();
    const duplicates: string[] = [];
    let pointerAttempts = 0;
    blob.get.mockImplementation(async (pathname: string) => objects.has(pathname) ? response(objects.get(pathname)!) : null);
    blob.put.mockImplementation(async (pathname: string, value: string) => {
      if (pathname === pointerPath) {
        pointerAttempts += 1;
        if (pointerAttempts === 1) throw new BlobPreconditionFailedError();
      } else if (objects.has(pathname)) {
        duplicates.push(pathname);
        throw new BlobError("This blob already exists, use allowOverwrite: true to overwrite it.");
      }
      objects.set(pathname, value);
      return { etag: '"new"', url: secret };
    });
    const result = await runIngestion({ cadence: "fast", adapters: [], stateStore,
      catalogPublication: { publicationStore: publicStore }, lease, now });
    expect(result.status).toBe("ok");
    expect(pointerAttempts).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    expect(duplicates.length).toBeGreaterThan(0);
    const current = await readCurrentPublication(publicStore);
    expect(current?.pointer.stateRevision).toBe((await stateStore.read()).data.stateRevision);
    expect(current?.manifest.conditions).toHaveLength(45);
    expect(log).not.toHaveBeenCalled();
    expect(info.mock.calls).toHaveLength(duplicates.length);
    expect(info.mock.calls.every((call) => call.length === 1
      && String(call[0]) === JSON.stringify({ event: "immutable_write_recovered" }))).toBe(true);
  });
});
