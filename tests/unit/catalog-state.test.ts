import { describe, expect, it } from "vitest";
import type { get, put } from "@vercel/blob";
import * as legacy from "@/lib/domain/schemas";
import { IngestionStateV16Schema, parseCatalogState, parseCatalogStateV13, parseCatalogStateV14, parseCatalogStateV15 } from "@/lib/domain/catalog-state";
import { emptyConditions } from "@/lib/domain/conditions";
import { LocalDatabase, LocalStateStore } from "@/lib/local-storage";
import { BlobStateStore } from "@/lib/state-store";
import { createLegacyState } from "../fixtures/legacy-state";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = new Date("2026-08-25T10:00:00.000Z");
const timestamp = now.toISOString();

function populatedV12() {
  const state = createLegacyState(now);
  state.conditions.locations["at-vienna"] = { ...emptyConditions(), limitations: ["disabled"] };
  state.conditions.attempts["weather:at-vienna"] = timestamp;
  state.fingerprints["retained"] = timestamp;
  return legacy.IngestionStateV12Schema.parse(state);
}

function memoryBlob(initial: string, beforeBackupWrite?: (values: Map<string, { body: string; etag: number }>) => void) {
  const values = new Map<string, { body: string; etag: number }>([["ingestion-state.json", { body: initial, etag: 1 }]]);
  let revision = 1;
  const getBlob = (async (pathname: string) => {
    const value = values.get(pathname); if (!value) return null;
    return { statusCode: 200 as const, stream: new Blob([value.body]).stream(), headers: new Headers(),
      blob: { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname,
        contentDisposition: "inline", cacheControl: "60", uploadedAt: new Date(), etag: String(value.etag),
        contentType: "application/json", size: value.body.length } };
  }) as typeof get;
  const putBlob = (async (pathname: string, body: unknown, options?: { ifMatch?: string; allowOverwrite?: boolean }) => {
    if (pathname === "ingestion-state-v15-backup.json" && !values.has(pathname)) beforeBackupWrite?.(values);
    const current = values.get(pathname);
    if (options?.ifMatch && String(current?.etag) !== options.ifMatch) throw new Error("precondition failed");
    if (options?.allowOverwrite === false && current) throw new Error("precondition failed");
    const value = typeof body === "string" ? body : await new Response(body as BodyInit).text(); revision += 1;
    values.set(pathname, { body: value, etag: revision });
    return { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname,
      contentType: "application/json", contentDisposition: "inline", etag: String(revision) };
  }) as typeof put;
  return { values, getBlob, putBlob, replace(pathname: string, body: string) { revision += 1; values.set(pathname, { body, etag: revision }); } };
}

const schemas = [legacy.IngestionStateV1Schema, legacy.IngestionStateV2Schema, legacy.IngestionStateV3Schema,
  legacy.IngestionStateV4Schema, legacy.IngestionStateV5Schema, legacy.IngestionStateV6Schema, legacy.IngestionStateV7Schema,
  legacy.IngestionStateV8Schema, legacy.IngestionStateV9Schema, legacy.IngestionStateV10Schema, legacy.IngestionStateV11Schema, legacy.IngestionStateV12Schema];

function historical(version: number) {
  const current = populatedV12(); const schema = schemas[version - 1];
  const old = version === 11 ? legacy.downgradeIngestionStateV12(current) : current;
  const sources = schema.shape.sources.keyType.options;
  const providers = "providers" in schema.shape ? schema.shape.providers.keyType.options : [];
  return schema.parse({ ...old, schemaVersion: version,
    sources: Object.fromEntries(sources.map((id) => [id, current.sources[id as keyof typeof current.sources] || current.sources.usgs])),
    providers: Object.fromEntries(providers.map((id) => [id, current.providers[id as keyof typeof current.providers] || current.providers.usgs])),
    sourcePartitions: { ...current.sourcePartitions, bbk: {} },
  });
}

describe("V16 private-state migration", () => {
  it.each(Array.from({ length: 12 }, (_, index) => index + 1))("migrates V%i directly to Catalog 3 while retaining usable evidence", (version) => {
    const input = historical(version); const before = structuredClone(input); const migrated = parseCatalogState(input);
    expect(migrated).toMatchObject({ schemaVersion: 16, collection: { catalogVersion: 3 }, stateRevision: 0, ingestionFence: 0, ingestionLease: null });
    if (version >= 11) expect(migrated.conditions.locations["at-vienna"]).toEqual(populatedV12().conditions.locations["at-vienna"]);
    else expect(migrated.conditions.locations["at-vienna"]).toBeUndefined();
    expect(input).toEqual(before);
  });

  it("migrates V13, V14, and V15 idempotently and removes transition/Catalog 2 receipts", () => {
    const v13 = parseCatalogStateV13(populatedV12());
    const v14 = parseCatalogStateV14(v13);
    const v15 = parseCatalogStateV15(v14);
    for (const input of [v13, v14, v15]) {
      const migrated = parseCatalogState(input);
      expect(IngestionStateV16Schema.parse(migrated)).toEqual(migrated);
      expect(migrated.collection).toEqual({ catalogVersion: 3, revision: 1 });
      expect(Object.keys(migrated.collectionReceipts)).toEqual(["3"]);
      expect("publicationTransition" in migrated).toBe(false);
      expect(parseCatalogState(migrated)).toEqual(migrated);
    }
  });

  it("creates one immutable V15 backup before the first V16 local write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "travelcanary-v15-")); const database = new LocalDatabase(join(directory, "travelcanary.db"));
    const v15 = parseCatalogStateV15(populatedV12());
    database.initialize([{ namespace: "private", key: "ingestion/state.json", value: JSON.stringify(v15), maxBytes: 5 * 1024 * 1024 }]);
    const store = new LocalStateStore(database); const read = await store.read();
    await store.write({ ...read.data, updatedAt: new Date(now.getTime() + 1000).toISOString() }, read);
    expect(JSON.parse(database.read("private", "ingestion/state-v15-backup.json")!.value)).toEqual(v15);
    const next = await store.read(); await store.write({ ...next.data, updatedAt: new Date(now.getTime() + 2000).toISOString() }, next);
    expect(JSON.parse(database.read("private", "ingestion/state-v15-backup.json")!.value)).toEqual(v15);
    database.close();
  });

  it("atomically backs up the exact V15 state migrated by local storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "travelcanary-v15-race-")); const database = new LocalDatabase(join(directory, "travelcanary.db"));
    const first = parseCatalogStateV15(populatedV12());
    const second = parseCatalogStateV15({ ...first, updatedAt: new Date(now.getTime() + 1000).toISOString() });
    database.initialize([{ namespace: "private", key: "ingestion/state.json", value: JSON.stringify(first), maxBytes: 5 * 1024 * 1024 }]);
    const store = new LocalStateStore(database); const stale = await store.read();
    database.compareAndSwap("private", "ingestion/state.json", JSON.stringify(second), 1, 5 * 1024 * 1024);
    await expect(store.write(stale.data, stale)).rejects.toThrow(/changed/);
    expect(database.read("private", "ingestion/state-v15-backup.json")).toBeUndefined();
    const current = await store.read(); await store.write(current.data, current);
    expect(JSON.parse(database.read("private", "ingestion/state-v15-backup.json")!.value)).toEqual(second);
    database.close();
  });

  it("refuses to migrate a Blob V15 state that differs from its immutable backup", async () => {
    const first = parseCatalogStateV15(populatedV12());
    const second = parseCatalogStateV15({ ...first, updatedAt: new Date(now.getTime() + 1000).toISOString() });
    const blob = memoryBlob(JSON.stringify(first));
    const store = new BlobStateStore("private-token", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const stale = await store.read(); blob.replace("ingestion-state.json", JSON.stringify(second));
    await expect(store.write(stale.data, stale)).rejects.toThrow(/precondition/);
    expect(JSON.parse(blob.values.get("ingestion-state-v15-backup.json")!.body)).toEqual(first);
    const current = await store.read();
    await expect(store.write(current.data, current)).rejects.toThrow(/backup does not match/);
    expect(JSON.parse(blob.values.get("ingestion-state.json")!.body)).toEqual(second);
  });

  it("rejects a different V15 backup that wins the Blob creation race", async () => {
    const first = parseCatalogStateV15(populatedV12());
    const second = parseCatalogStateV15({ ...first, updatedAt: new Date(now.getTime() + 1000).toISOString() });
    const blob = memoryBlob(JSON.stringify(first), (values) => {
      values.set("ingestion-state-v15-backup.json", { body: JSON.stringify(second), etag: 2 });
    });
    const store = new BlobStateStore("private-token", "ingestion-state.json", blob.getBlob, blob.putBlob);
    const current = await store.read();
    await expect(store.write(current.data, current)).rejects.toThrow(/backup does not match/);
    expect(JSON.parse(blob.values.get("ingestion-state.json")!.body)).toEqual(first);
  });

  it("rejects V16 collection, fence, and lease regression", () => {
    const state = parseCatalogState(parseCatalogStateV15(populatedV12()));
    expect(IngestionStateV16Schema.safeParse({ ...state, collection: { catalogVersion: 2, revision: 1 } }).success).toBe(false);
    expect(IngestionStateV16Schema.safeParse({ ...state, ingestionFence: 2, ingestionLease: { owner: "writer-one", fence: 1,
      expiresAt: new Date(now.getTime() + 60_000).toISOString() } }).success).toBe(false);
  });
});
