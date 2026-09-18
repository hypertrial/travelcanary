import { randomUUID } from "node:crypto";
import { ConcurrencyError, type StateStore } from "./state-store";

export type IngestionLease = { owner: string; fence: number; expiresAt: string; collectionRevision: number };

export function newLeaseOwner(prefix: string) {
  return `${prefix}:${randomUUID()}`;
}

export async function acquireIngestionLease(
  store: StateStore,
  owner: string,
  now = new Date(),
  ttlMs = 330_000,
): Promise<IngestionLease | null> {
  if (!Number.isFinite(now.getTime()) || ttlMs < 30_000 || ttlMs > 900_000) throw new Error("Invalid ingestion lease duration");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.read();
    const lease = current.data.ingestionLease;
    if (lease && lease.owner !== owner && Date.parse(lease.expiresAt) > now.getTime()) return null;
    const renew = lease?.owner === owner && lease.fence === current.data.ingestionFence;
    const fence = renew ? lease.fence : current.data.ingestionFence + 1;
    current.data.updatedAt = new Date(Math.max(now.getTime(), Date.parse(current.data.updatedAt))).toISOString();
    current.data.ingestionFence = fence;
    current.data.ingestionLease = { owner, fence, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    try {
      await store.write(current.data, current);
      return { owner, fence, expiresAt: current.data.ingestionLease.expiresAt, collectionRevision: current.data.collection.revision };
    } catch (error) {
      if (!(error instanceof ConcurrencyError) || attempt === 2) throw error;
    }
  }
  throw new Error("Could not acquire ingestion lease");
}

export async function assertIngestionLease(store: StateStore, expected: IngestionLease, now = new Date()) {
  const current = await store.read();
  const lease = current.data.ingestionLease;
  if (!lease || lease.owner !== expected.owner || lease.fence !== expected.fence
    || current.data.ingestionFence !== expected.fence || current.data.collection.revision !== expected.collectionRevision
    || Date.parse(lease.expiresAt) <= now.getTime()) throw new ConcurrencyError("Ingestion lease was lost");
  return current;
}

export async function releaseIngestionLease(store: StateStore, expected: IngestionLease) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.read();
    const lease = current.data.ingestionLease;
    if (!lease || lease.owner !== expected.owner || lease.fence !== expected.fence) return;
    current.data.ingestionLease = null;
    try { await store.write(current.data, current); return; }
    catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 2) throw error; }
  }
}
