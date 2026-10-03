import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobError, BlobPreconditionFailedError } from "@vercel/blob";
import { publishCommittedCatalog } from "@/lib/catalog-publication";
import { acquireIngestionLease } from "@/lib/ingestion-lease";
import { runIngestion } from "@/lib/ingestion/orchestrator";
import { captureStateControl } from "@/lib/publication-control";
import { BlobPublicationPointerConflictError, BlobPublicationStore } from "@/lib/publication-store";
import { createEmptyState } from "@/lib/risk";
import { ConcurrencyError, MemoryStateStore } from "@/lib/state-store";
import { MemoryPublicationStore } from "../helpers/publication";

const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", async () => ({
  ...await vi.importActual<typeof import("@vercel/blob")>("@vercel/blob"), get: blob.get, put: blob.put,
}));
const now = new Date("2026-10-03T12:00:00Z");
const pointerPath = "catalogs/3/publication/latest.json";

function response(body: string, etag: string) {
  return { statusCode: 200, stream: new Response(body).body,
    blob: { size: Buffer.byteLength(body), etag, url: "https://blob.example/public", uploadedAt: now } };
}

async function fixture(ttl = 330_000) {
  const stateStore = new MemoryStateStore(createEmptyState(now));
  const lease = await acquireIngestionLease(stateStore, "pointer-retry", now, ttl);
  if (!lease) throw new Error("Test lease unavailable");
  const seed = new MemoryPublicationStore();
  const common = { stateStore, lease, collection: { catalogVersion: 3 as const, revision: 1 }, env: { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true" } };
  await publishCommittedCatalog({ ...common, stores: { publicationStore: seed }, now, family: "conditions" });
  const stale = (await seed.read(pointerPath, 64_000))!;
  const updated = await stateStore.read();
  updated.data.conditions.health["krisinformation-infrastructure"] = { checkedAt: now.toISOString(), status: "failed", matched: 0, code: "http_error" };
  await stateStore.write(updated.data, updated);
  const fresh = await publishCommittedCatalog({ ...common, stores: { publicationStore: seed }, now, family: "conditions" });
  const freshPointer = (await seed.read(pointerPath, 64_000))!;
  const objects = new Map<string, string>();
  for (const prefix of ["catalogs/3/objects/sha256/", "catalogs/3/generations/"]) {
    for (const { pathname } of await seed.list(prefix, 1000)) objects.set(pathname, (await seed.read(pathname, 5_000_000))!.body);
  }
  const pointerWrites: Array<{ at: number; body: string; ifMatch: string | undefined }> = [];
  const immutableWrites: string[] = [];
  let published: { body: string; etag: string } | null = null;
  let persistent = false;
  let reached!: () => void;
  const firstConflict = new Promise<void>((resolve) => { reached = resolve; });
  blob.get.mockImplementation(async (pathname: string) => {
    if (pathname === pointerPath) {
      const value = published || (Date.now() < now.getTime() + 61_000 ? stale : freshPointer);
      return response(value.body, value.etag);
    }
    return objects.has(pathname) ? response(objects.get(pathname)!, "object-etag") : null;
  });
  blob.put.mockImplementation(async (pathname: string, body: string, options: { ifMatch?: string }) => {
    if (pathname === pointerPath) {
      pointerWrites.push({ at: Date.now(), body, ifMatch: options.ifMatch });
      if (persistent || options.ifMatch !== freshPointer.etag) { reached(); throw new BlobPreconditionFailedError(); }
      published = { body, etag: "published-etag" };
    } else { immutableWrites.push(pathname); objects.set(pathname, body); }
    return { etag: "published-etag", url: "https://blob.example/public" };
  });
  return { stateStore, lease, fresh, seed, stale, freshPointer, firstConflict, pointerWrites, immutableWrites,
    options: { ...common, now, stores: { publicationStore: new BlobPublicationStore("synthetic-token") } },
    persistent() { persistent = true; }, objects };
}

const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }));

describe("bounded Blob publication pointer recovery", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    vi.stubEnv("TRAVELCANARY_RELEASE_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("LOCAL_CONDITIONS_ENABLED", "true");
    vi.stubEnv("NONCOMMERCIAL_DATA_ENABLED", "true");
    blob.get.mockReset(); blob.put.mockReset();
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("rebuilds from fresh state and coherent pointer references after one wait, with one ingestion commit", async () => {
    const f = await fixture();
    const staleManifest = JSON.parse(f.objects.get(JSON.parse(f.stale.body).manifestPath)!);
    expect(f.fresh.manifest.conditions).not.toEqual(staleManifest.conditions);
    const write = vi.spyOn(f.stateStore, "write");
    const pending = outcome(runIngestion({ cadence: "fast", adapters: [], stateStore: f.stateStore,
      catalogPublication: f.options.stores, lease: f.lease }));
    await f.firstConflict;
    await vi.advanceTimersByTimeAsync(60_999);
    expect(f.pointerWrites).toHaveLength(1);
    const latest = await f.stateStore.read();
    latest.data.updatedAt = new Date(now.getTime() + 60_999).toISOString();
    // A separate committed update must be observed by the rebuilt generation.
    await MemoryStateStore.prototype.write.call(f.stateStore, latest.data, latest);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.value?.status).toBe("ok");
    expect(write).toHaveBeenCalledOnce();
    expect(f.pointerWrites.map(({ at }) => at - now.getTime())).toEqual([0, 61_000]);
    expect(f.pointerWrites[1].ifMatch).toBe(f.freshPointer.etag);
    const pointer = JSON.parse(f.pointerWrites[1].body);
    const manifest = JSON.parse(f.objects.get(pointer.manifestPath)!);
    expect(pointer.stateRevision).toBe((await f.stateStore.read()).data.stateRevision);
    expect(manifest.generatedAt).toBe(latest.data.updatedAt);
    expect(manifest.conditions).toEqual(f.fresh.manifest.conditions);
    expect(info.mock.calls).toEqual([[JSON.stringify({ event: "publication_pointer_conflict" })]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers the direct conditions publication caller through the same bounded retry", async () => {
    const f = await fixture();
    const pending = outcome(publishCommittedCatalog({ ...f.options, family: "conditions" }));
    await f.firstConflict;
    await vi.advanceTimersByTimeAsync(61_000);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.value?.publication.published).toHaveLength(45);
    expect(f.pointerWrites).toHaveLength(2);
    expect(f.pointerWrites[1].ifMatch).toBe(f.freshPointer.etag);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps persistent SDK pointer conflicts at two attempts and one wait across ingestion", async () => {
    const f = await fixture(); f.persistent();
    const write = vi.spyOn(f.stateStore, "write");
    const pending = outcome(runIngestion({ cadence: "fast", adapters: [], stateStore: f.stateStore,
      catalogPublication: f.options.stores, lease: f.lease }));
    await f.firstConflict;
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await pending).error).toBeInstanceOf(BlobPublicationPointerConflictError);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.pointerWrites.map(({ at }) => at - now.getTime())).toEqual([0, 61_000]);
    expect(write).toHaveBeenCalledOnce();
    expect(info.mock.calls).toEqual(Array.from({ length: 2 }, () => [JSON.stringify({ event: "publication_pointer_conflict" })]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([60_999, 61_000, 61_001])("checks the current lease budget at the %ims boundary", async (ttl) => {
    const f = await fixture(ttl);
    const pending = outcome(publishCommittedCatalog({ ...f.options, family: "conditions" }));
    await f.firstConflict;
    await vi.advanceTimersByTimeAsync(0);
    if (ttl <= 61_000) {
      expect((await pending).error).toBeInstanceOf(BlobPublicationPointerConflictError);
      expect(f.pointerWrites).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } else {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await pending).error).toBeUndefined();
      expect(f.pointerWrites).toHaveLength(2);
    }
  });

  it("uses the authoritative stored lease budget rather than the captured long lease", async () => {
    const f = await fixture();
    const read = f.stateStore.read.bind(f.stateStore);
    vi.spyOn(f.stateStore, "read").mockImplementation(async () => {
      const current = await read();
      current.data.ingestionLease!.expiresAt = new Date(now.getTime() + 61_000).toISOString();
      return { ...current, ...captureStateControl(current.data) };
    });
    await expect(publishCommittedCatalog({ ...f.options, family: "conditions" })).rejects.toBeInstanceOf(BlobPublicationPointerConflictError);
    expect(f.lease.expiresAt).toBe(new Date(now.getTime() + 330_000).toISOString());
    expect(f.pointerWrites).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["expired", "released", "replaced"])("writes no retry object when the lease is %s during the wait", async (kind) => {
    const f = await fixture(62_000);
    const pending = outcome(publishCommittedCatalog({ ...f.options, family: "conditions" }));
    await f.firstConflict;
    await vi.advanceTimersByTimeAsync(0);
    const before = f.immutableWrites.length;
    if (kind === "expired") vi.setSystemTime(new Date(now.getTime() + 2000));
    else {
      const current = await f.stateStore.read(); current.data.ingestionLease = null;
      await f.stateStore.write(current.data, current);
      if (kind === "replaced") expect(await acquireIngestionLease(f.stateStore, "successor", new Date(), 330_000)).not.toBeNull();
    }
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await pending).error).toBeInstanceOf(ConcurrencyError);
    expect(f.pointerWrites).toHaveLength(1);
    expect(f.immutableWrites).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["private read", "generic pointer", "non-Blob pointer", "transport"])("does not wait or retry a %s failure", async (kind) => {
    const f = await fixture();
    const error = kind === "transport" ? new BlobError("secret-sentinel") : new ConcurrencyError("secret-sentinel");
    if (kind === "private read") vi.spyOn(f.stateStore, "read").mockRejectedValue(error);
    else if (kind === "non-Blob pointer") vi.spyOn(f.seed, "replacePointer").mockRejectedValue(error);
    else {
      const put = blob.put.getMockImplementation()!;
      blob.put.mockImplementation((pathname: string, value: string, options: { ifMatch?: string }) => {
        if (pathname === pointerPath) return Promise.reject(error);
        return put(pathname, value, options);
      });
    }
    const store = kind === "non-Blob pointer" ? f.seed : f.options.stores.publicationStore;
    await expect(publishCommittedCatalog({ ...f.options, stores: { publicationStore: store }, family: "conditions" })).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });
});
