import { readFileSync } from "node:fs";
import { BlobPreconditionFailedError, type get, type put } from "@vercel/blob";
import { describe, expect, it, vi } from "vitest";
import { ConditionsV2Schema } from "@/lib/domain/conditions";
import { parseCatalogState } from "@/lib/domain/catalog-state";
import { BlobStateStore, ConcurrencyError, MemoryStateStore } from "@/lib/storage";
import { createLegacyState } from "../fixtures/legacy-state";

const now = new Date("2026-08-31T17:45:00Z");
function blobHarness(initial: unknown) {
  let version = 1;
  const values = new Map([["ingestion-state.json", { body: typeof initial === "string" ? initial : JSON.stringify(initial), etag: "1" }]]);
  const getBlob = vi.fn<typeof get>().mockImplementation(async (path) => {
    const entry = values.get(path); if (!entry) return null;
    return { statusCode: 200, stream: new Blob([entry.body]).stream(), headers: new Headers(), blob: {
      url: `https://unit.private.blob.vercel-storage.com/${path}`, downloadUrl: `https://unit.private.blob.vercel-storage.com/${path}`, pathname: path,
      contentDisposition: "inline", cacheControl: "60", uploadedAt: now, etag: entry.etag, contentType: "application/json", size: entry.body.length,
    } };
  });
  const putBlob = vi.fn<typeof put>().mockImplementation(async (path, body, options) => {
    const entry = values.get(path);
    if ((options.ifMatch && entry?.etag !== options.ifMatch) || (options.allowOverwrite === false && entry)) throw new BlobPreconditionFailedError();
    if (typeof body !== "string") throw new Error("Expected JSON string");
    const etag = String(++version); values.set(path, { body, etag });
    return { url: `https://unit.private.blob.vercel-storage.com/${path}`, downloadUrl: `https://unit.private.blob.vercel-storage.com/${path}`, pathname: path, contentType: "application/json", contentDisposition: "inline", etag };
  });
  return { values, getBlob, putBlob, store: new BlobStateStore("private-token", "ingestion-state.json", getBlob, putBlob) };
}

describe("canonical private storage", () => {
  it("preserves populated V12 bytes before first canonical write and never overwrites that backup", async () => {
    const legacy = createLegacyState(now);
    legacy.conditions.locations = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/AT.json", "utf8"))).locations;
    legacy.conditions.reservations = [{ at: now.toISOString(), weight: 400 }];
    legacy.conditions.attempts.legacy = now.toISOString(); legacy.fingerprints.legacy = now.toISOString();
    legacy.conditions.cooldownUntil = "2026-08-31T20:00:00Z";
    legacy.conditions.lease = { id: "123e4567-e89b-42d3-a456-426614174000", expiresAt: "2026-08-31T17:46:00Z" };
    const raw = JSON.stringify(legacy, null, 2);
    const blob = blobHarness(raw); const read = await blob.store.read();
    expect(read.data).toEqual(parseCatalogState(legacy));
    expect(read.legacy).toEqual({ schemaVersion: 12, raw });
    await blob.store.write(read.data, read);
    expect(blob.values.get("ingestion-state-v12-backup.json")?.body).toBe(raw);
    expect(JSON.parse(blob.values.get("ingestion-state.json")!.body)).toEqual(read.data);
    expect(blob.putBlob.mock.calls.map(([path]) => path)).toEqual(["ingestion-state-v12-backup.json", "ingestion-state.json"]);
    const current = await blob.store.read(); expect(current.legacy).toBeUndefined();
    current.data.collection.revision = 1; await blob.store.write(current.data, current);
    expect(blob.values.get("ingestion-state-v12-backup.json")?.body).toBe(raw);
    expect(blob.putBlob.mock.calls.filter(([path]) => path === "ingestion-state-v12-backup.json")).toHaveLength(1);
    await expect(blob.store.write(read.data, read)).rejects.toBeInstanceOf(ConcurrencyError);
    expect(JSON.parse(blob.values.get("ingestion-state.json")!.body).collection.revision).toBe(1);
  });

  it("uses immutable read metadata even when a caller mutates the expected state's collection", async () => {
    const state = parseCatalogState(createLegacyState(now)); state.collection.revision = 5;
    const blob = blobHarness(state); const expected = await blob.store.read();
    expect(Object.isFrozen(expected.collectionControl)).toBe(true);
    expected.data.collection.revision = 4;
    await expect(blob.store.write(expected.data, expected)).rejects.toThrow();
    expect(blob.putBlob).not.toHaveBeenCalled();
    expect((await blob.store.read()).data).toEqual(state);
    const { collectionControl: omitted, ...withoutControl } = await blob.store.read();
    expect(omitted).toEqual(state.collection);
    await expect(blob.store.write(withoutControl.data, withoutControl)).rejects.toThrow();
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it("isolates MemoryStateStore control from constructor and read aliases", async () => {
    const state = parseCatalogState(createLegacyState(now)); state.collection.revision = 5;
    const store = new MemoryStateStore(state); state.collection.revision = 0;
    const expected = await store.read(); expect(expected.data.collection.revision).toBe(5);
    expected.data.collection.revision = 4;
    await expect(store.write(expected.data, expected)).rejects.toThrow();
    expect((await store.read()).data.collection.revision).toBe(5);
  });

  it.each(["invalid JSON", JSON.stringify({ schemaVersion: 13 }), JSON.stringify({ schemaVersion: 99 })])("rejects corrupt or unsupported state without resetting: %s", async (raw) => {
    const blob = blobHarness(raw);
    await expect(blob.store.read()).rejects.toThrow();
    expect(blob.putBlob).not.toHaveBeenCalled(); expect(blob.values.get("ingestion-state.json")!.body).toBe(raw);
  });

  it.each(["memory", "blob"] as const)("enforces monotonic collection control in %s storage", async (kind) => {
    const state = parseCatalogState(createLegacyState(now)); state.collection.revision = 5;
    const store = kind === "memory" ? new MemoryStateStore(state) : blobHarness(state).store;
    for (const collection of [{ catalogVersion: 2 as const, revision: 4 }, { catalogVersion: 3 as const, revision: 5 }]) {
      const current = await store.read(); const changed = structuredClone(current.data); changed.collection = collection;
      await expect(store.write(changed, current)).rejects.toThrow();
      expect((await store.read()).data).toEqual(state);
    }
    const before = await store.read(); const activated = structuredClone(before.data); activated.collection = { catalogVersion: 3, revision: 6 };
    activated.publicationTransition = { from: 2, to: 3, revision: 6, dualStartedAt: null, dualUntil: null };
    await store.write(activated, before);
    const latest = await store.read(); const downgraded = structuredClone(latest.data); downgraded.collection = { catalogVersion: 2, revision: 7 };
    await expect(store.write(downgraded, latest)).rejects.toThrow();
    expect((await store.read()).data).toEqual(activated);
    await expect(store.write(before.data, before)).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
