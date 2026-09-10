import { readFileSync } from "node:fs";
import { BlobPreconditionFailedError, type get, type put } from "@vercel/blob";
import { describe, expect, it, vi } from "vitest";
import { IngestionStateV13Schema, IngestionStateV14Schema, parseCatalogState, parseCatalogStateV13 } from "@/lib/domain/catalog-state";
import { ConditionsV2Schema } from "@/lib/domain/conditions";
import { BlobStateStore, MemoryStateStore, ConcurrencyError } from "@/lib/storage";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";
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

function populatedV13() {
  const value = parseCatalogStateV13(createLegacyState(now));
  value.collection = { catalogVersion: 3, revision: 9 };
  for (const code of ["AT", "FI", "PL"]) Object.assign(value.conditions.locations,
    ConditionsV2Schema.parse(JSON.parse(readFileSync(`public/conditions/v2/${code}.json`, "utf8"))).locations);
  value.conditions.reservations = [{ at: now.toISOString(), weight: 400 }];
  value.conditions.attempts.owned = now.toISOString(); value.conditions.cacheUntil.cached = now.toISOString();
  value.conditions.lease = { id: "123e4567-e89b-42d3-a456-426614174000", expiresAt: "2026-08-31T17:46:00Z" };
  value.conditions.cooldownUntil = "2026-08-31T20:00:00Z";
  value.fingerprints.retained = now.toISOString();
  value.events = [{ id: "usgs:retained", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Reported earthquake.", explanation: "Preliminary official evidence.", action: "Check local advice.", affectedArea: "London",
    geometry: { kind: "locations", ids: ["gb-london", "opaque-retired"] }, startsAt: "2026-08-25T10:00:00Z", endsAt: "2026-08-25T12:00:00Z",
    checkedAt: "2026-08-25T10:00:00Z", sourceUpdatedAt: "2026-08-25T10:00:00Z", expiresAt: "2026-08-25T12:00:00Z",
    sourceName: "USGS", sourceUrl: "https://earthquake.usgs.gov/", confidence: "MEDIUM" }];
  return IngestionStateV13Schema.parse(value);
}
function transitioned() {
  const value = parseCatalogState(populatedV13());
  value.publicationTransition = { from: 2, to: 3, revision: 9, dualStartedAt: null, dualUntil: null };
  return value;
}
const started = now.toISOString(); const until = new Date(now.getTime() + 24 * 3600000).toISOString();

describe("V14 compatible publication transition state", () => {
  it("migrates populated V13 without pruning, renewing, dropping, or aliasing any accepted state", () => {
    const old = populatedV13(); const before = structuredClone(old); const migrated = parseCatalogState(old);
    expect(migrated).toEqual({ ...old, schemaVersion: 14, publicationTransition: null, expandedSourceHealth: {} });
    expect(parseCatalogState(migrated)).toEqual(migrated);
    expect(parseCatalogStateV13(old)).toEqual(old); expect(() => IngestionStateV13Schema.parse(migrated)).toThrow();
    migrated.events[0].headline = "Changed copy"; migrated.conditions.reservations[0].weight = 1;
    expect(old).toEqual(before);
  });

  it.each(["same direction", "wrong destination", "wrong revision", "negative revision", "one timestamp", "short window", "long window", "reverse window"])("rejects invalid transition: %s", (mode) => {
    const state = transitioned(); const transition = state.publicationTransition!;
    if (mode === "same direction") transition.from = 3;
    if (mode === "wrong destination") { transition.to = 2; transition.from = 3; }
    if (mode === "wrong revision") transition.revision = 8;
    if (mode === "negative revision") transition.revision = -1;
    if (mode === "one timestamp") transition.dualStartedAt = started;
    if (["short window", "long window", "reverse window"].includes(mode)) {
      transition.dualStartedAt = started;
      transition.dualUntil = new Date(now.getTime() + (mode === "short window" ? 24 * 3600000 - 1 : mode === "long window" ? 24 * 3600000 + 1 : -24 * 3600000)).toISOString();
    }
    expect(() => IngestionStateV14Schema.parse(state)).toThrow();
  });

  it("accepts only an exact24h acknowledged pair without applying wall-clock expiry during parsing", () => {
    const state = transitioned(); state.publicationTransition!.dualStartedAt = started; state.publicationTransition!.dualUntil = until;
    expect(parseCatalogState(state)).toEqual(state);
  });

  it("backs up original V13 bytes before canonical V14 publication and captures independent immutable transition metadata", async () => {
    const raw = JSON.stringify(populatedV13(), null, 2); const blob = blobHarness(raw); const read = await blob.store.read();
    expect(read.data).toEqual(parseCatalogState(JSON.parse(raw))); expect(read.publicationControl).toBeDefined();
    expect(Object.isFrozen(read.publicationControl)).toBe(true);
    await blob.store.write(read.data, read);
    expect(blob.values.get("ingestion-state-v13-backup.json")?.body).toBe(raw);
    expect(blob.putBlob.mock.calls.map(([path]) => path)).toEqual(["ingestion-state-v13-backup.json", "ingestion-state.json"]);
    const { publicationControl: omitted, ...withoutControl } = await blob.store.read();
    expect(omitted).toBeDefined();
    await expect(blob.store.write(withoutControl.data, withoutControl)).rejects.toThrow();
  });

  it.each(["memory", "blob"] as const)("permits explicit activation then rollback with larger revisions and preserves evidence in %s", async (kind) => {
    const base = parseCatalogState(createLegacyState(now)); base.fingerprints.retained = started;
    const store = kind === "memory" ? new MemoryStateStore(base) : blobHarness(base).store;
    const before = await store.read(); const active = structuredClone(before.data);
    active.collection = { catalogVersion: 3, revision: 1 };
    await expect(store.write(active, before)).rejects.toThrow();
    active.publicationTransition = { from: 2, to: 3, revision: 1, dualStartedAt: null, dualUntil: null };
    await store.write(active, before);
    const latest = await store.read(); const rollback = structuredClone(latest.data);
    rollback.collection = { catalogVersion: 2, revision: 2 };
    await expect(store.write(rollback, latest)).rejects.toThrow();
    rollback.publicationTransition = { from: 3, to: 2, revision: 2, dualStartedAt: null, dualUntil: null };
    await store.write(rollback, latest);
    expect((await store.read()).data).toEqual(rollback); expect(rollback.fingerprints).toEqual(base.fingerprints);
    await expect(store.write(active, before)).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it.each(["memory", "blob"] as const)("does not invent a transition without a catalog switch in %s", async (kind) => {
    const base = parseCatalogState(populatedV13()); const store = kind === "memory" ? new MemoryStateStore(base) : blobHarness(base).store;
    const expected = await store.read(); const changed = structuredClone(expected.data);
    changed.publicationTransition = { from: 2, to: 3, revision: base.collection.revision, dualStartedAt: null, dualUntil: null };
    await expect(store.write(changed, expected)).rejects.toThrow();
    expect((await store.read()).data).toEqual(base);
  });

  it.each(["memory", "blob"] as const)("prevents ordinary writes from erasing, rewinding or extending acknowledged transitions in %s", async (kind) => {
    const base = transitioned(); const store = kind === "memory" ? new MemoryStateStore(base) : blobHarness(base).store;
    const before = await store.read(); before.data.publicationTransition!.dualStartedAt = started; before.data.publicationTransition!.dualUntil = until;
    await store.write(before.data, before);
    const acknowledged = (await store.read()).data;
    for (const mode of ["clear", "unacknowledge", "rewind", "extend", "change direction"] as const) {
      const expected = await store.read(); const changed = structuredClone(expected.data);
      if (mode === "clear") changed.publicationTransition = null;
      if (mode === "unacknowledge") { changed.publicationTransition!.dualStartedAt = null; changed.publicationTransition!.dualUntil = null; }
      if (mode === "rewind" || mode === "extend") {
        const shift = mode === "rewind" ? -60000 : 60000;
        changed.publicationTransition!.dualStartedAt = new Date(now.getTime() + shift).toISOString();
        changed.publicationTransition!.dualUntil = new Date(now.getTime() + 24 * 3600000 + shift).toISOString();
      }
      if (mode === "change direction") changed.publicationTransition!.from = 3;
      // Mutating expected.data too must not forge the immutable captured controls.
      expected.data.publicationTransition = structuredClone(changed.publicationTransition);
      await expect(store.write(changed, expected)).rejects.toThrow();
      expect((await store.read()).data).toEqual(acknowledged);
    }
    const normal = await store.read(); normal.data.fingerprints.newEvidence = started;
    await store.write(normal.data, normal);
    expect((await store.read()).data.publicationTransition).toEqual(acknowledged.publicationTransition);
  });
});


const newIds = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
const scopes = { usgs: newIds, emsc: newIds, "fcdo-travel-advice": newIds.filter((id) => !id.startsWith("gb-") && !id.startsWith("va-")), "slf-avalanche": ["li-malbun"] };
function receipt(source: keyof typeof scopes = "usgs", at = started) {
  return { health: { ...createLegacyState(now).sources[source], status: "ok" as const, lastAttempt: at, lastSuccess: at,
    sourceUpdatedAt: at, nextExpectedUpdate: "2026-08-31T18:45:00Z", error: null }, checkedLocationIds: [...scopes[source]], unavailableLocationIds: [] as string[] };
}

describe("durable expanded source receipts", () => {
  it.each([["usgs", 176], ["emsc", 176], ["fcdo-travel-advice", 145], ["slf-avalanche", 1]] as const)("retains exact reviewed %s scope of%s destinations", (source, count) => {
    const state = transitioned(); state.expandedSourceHealth[source] = receipt(source);
    expect(scopes[source]).toHaveLength(count);
    expect(parseCatalogState(state)).toEqual(state);
  });

  it.each(["missing", "duplicate", "overlap", "legacy destination", "wrong source scope", "unknown source", "no attempt", "ok unavailable", "failed checked", "not monitored checked"])("rejects invalid receipt %s", (mode) => {
    const state = transitioned(); state.expandedSourceHealth.usgs = receipt(); const value = state.expandedSourceHealth.usgs;
    if (mode === "missing") value.checkedLocationIds.pop();
    if (mode === "duplicate") value.checkedLocationIds[0] = value.checkedLocationIds[1];
    if (mode === "overlap") value.unavailableLocationIds = [value.checkedLocationIds[0]];
    if (mode === "legacy destination") value.checkedLocationIds[0] = "at-vienna";
    if (mode === "wrong source scope") { delete state.expandedSourceHealth.usgs; state.expandedSourceHealth["slf-avalanche"] = { ...receipt("slf-avalanche"), checkedLocationIds: ["li-vaduz"] }; }
    if (mode === "unknown source") Object.assign(state.expandedSourceHealth, { eonet: receipt() });
    if (mode === "no attempt") Object.assign(value.health, { lastAttempt: null });
    if (mode === "ok unavailable") value.unavailableLocationIds = [value.checkedLocationIds.pop()!];
    if (mode === "failed checked") Object.assign(value.health, { status: "failed" });
    if (mode === "not monitored checked") Object.assign(value.health, { status: "not_monitored" });
    expect(() => IngestionStateV14Schema.parse(state)).toThrow();
  });

  it.each(["future success", "missing success", "old success with checked IDs"])("rejects %s in the receipt schema", (mode) => {
    const state = transitioned(); state.expandedSourceHealth.usgs = receipt();
    const health = state.expandedSourceHealth.usgs.health;
    health.lastSuccess = mode === "future success" ? "2026-08-31T17:46:00Z" : mode === "missing success" ? null : "2026-08-31T17:44:00Z";
    expect(() => IngestionStateV14Schema.parse(state)).toThrow();
  });

  it.each(["failed", "not_monitored", "partial"] as const)("preserves prior success for newer all-unavailable %s receipt", async (status) => {
    const state = transitioned(); state.expandedSourceHealth.usgs = receipt(); const store = new MemoryStateStore(state);
    for (const mode of ["erase success", "rewind success", "invent success", "erase source update"] as const) {
      const expected = await store.read(); const changed = structuredClone(expected.data);
      const value = changed.expandedSourceHealth.usgs!;
      value.health.status = status; value.health.lastAttempt = "2026-08-31T17:46:00Z";
      value.unavailableLocationIds = value.checkedLocationIds; value.checkedLocationIds = [];
      if (mode === "erase success") value.health.lastSuccess = null;
      if (mode === "rewind success") value.health.lastSuccess = "2026-08-31T17:44:00Z";
      if (mode === "invent success") value.health.lastSuccess = "2026-08-31T17:46:00Z";
      if (mode === "erase source update") value.health.sourceUpdatedAt = null;
      expect(IngestionStateV14Schema.safeParse(changed).success).toBe(true);
      await expect(store.write(changed, expected)).rejects.toThrow();
      expect((await store.read()).data.expandedSourceHealth).toEqual(state.expandedSourceHealth);
    }
    const expected = await store.read(); const value = expected.data.expandedSourceHealth.usgs!;
    value.health.status = status; value.health.lastAttempt = "2026-08-31T17:46:00Z";
    value.unavailableLocationIds = value.checkedLocationIds; value.checkedLocationIds = [];
    await store.write(expected.data, expected);
    expect((await store.read()).data.expandedSourceHealth.usgs!.health).toMatchObject({ lastAttempt: "2026-08-31T17:46:00Z", lastSuccess: started, sourceUpdatedAt: started });
  });

  it("accepts partial classification and failed classification without inventing checked destinations", () => {
    const state = transitioned(); state.expandedSourceHealth.usgs = receipt();
    const value = state.expandedSourceHealth.usgs;
    Object.assign(value.health, { status: "partial" }); value.unavailableLocationIds = value.checkedLocationIds.splice(50);
    expect(parseCatalogState(state)).toEqual(state);
    Object.assign(value.health, { status: "failed" }); value.unavailableLocationIds.push(...value.checkedLocationIds); value.checkedLocationIds = [];
    expect(parseCatalogState(state)).toEqual(state);
  });

  it.each(["memory", "blob"] as const)("preserves receipts through rollback and rejects legacy or stale updates in %s", async (kind) => {
    const base = transitioned(); const store = kind === "memory" ? new MemoryStateStore(base) : blobHarness(base).store;
    const initial = await store.read(); initial.data.expandedSourceHealth.usgs = receipt(); await store.write(initial.data, initial);
    const recorded = await store.read();
    expect(Object.isFrozen(recorded.expandedSourceControl)).toBe(true);
    expect(Object.isFrozen(recorded.expandedSourceControl!.usgs!.health)).toBe(true);
    expect(Object.isFrozen(recorded.expandedSourceControl!.usgs!.checkedLocationIds)).toBe(true);
    const retry = structuredClone(recorded.data); await store.write(retry, recorded);
    for (const mode of ["clear", "older", "same timestamp changed"] as const) {
      const expected = await store.read(); const changed = structuredClone(expected.data);
      if (mode === "clear") changed.expandedSourceHealth = {};
      if (mode === "older") changed.expandedSourceHealth.usgs = receipt("usgs", "2026-08-31T17:44:59Z");
      if (mode === "same timestamp changed") changed.expandedSourceHealth.usgs!.health.itemCount = 2;
      expected.data.expandedSourceHealth = structuredClone(changed.expandedSourceHealth);
      await expect(store.write(changed, expected)).rejects.toThrow();
      expect((await store.read()).data.expandedSourceHealth).toEqual(recorded.data.expandedSourceHealth);
    }
    const changing = await store.read(); const changedControl = structuredClone(changing.data);
    changedControl.collection.revision += 1; changedControl.publicationTransition!.revision += 1;
    changedControl.expandedSourceHealth.usgs = receipt("usgs", "2026-08-31T17:46:00Z");
    await expect(store.write(changedControl, changing)).rejects.toThrow();
    const expected = await store.read(); const rollback = structuredClone(expected.data);
    rollback.collection = { catalogVersion: 2, revision: 10 };
    rollback.publicationTransition = { from: 3, to: 2, revision: 10, dualStartedAt: null, dualUntil: null };
    const combined = structuredClone(rollback); combined.expandedSourceHealth.usgs = receipt("usgs", "2026-08-31T17:46:00Z");
    await expect(store.write(combined, expected)).rejects.toThrow();
    await store.write(rollback, expected);
    const rolledBack = await store.read(); expect(rolledBack.data.expandedSourceHealth).toEqual(recorded.data.expandedSourceHealth);
    rolledBack.data.expandedSourceHealth.usgs = receipt("usgs", "2026-08-31T17:46:00Z");
    await expect(store.write(rolledBack.data, rolledBack)).rejects.toThrow();
  });
});
