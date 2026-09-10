import { assertSupportedCollection, type CollectionControl } from "./domain/catalog-state";
import { conditionRecords, type Conditions } from "./domain/conditions";
import type { z } from "zod";
import type { ConditionsV3Schema } from "./domain/catalog-public";
import { buildCatalog3Conditions, buildCatalog3Snapshot } from "./catalog-projections";
import { projectCatalog2Conditions } from "./conditions/state";
import { projectCatalog2Snapshot } from "./risk-snapshot";
import { ConcurrencyError, type BlobCatalog3SnapshotStore, type ConditionsPublicationResult, type SnapshotStore, type StateStore } from "./storage";
import { serializeCatalog3Conditions } from "./conditions/serialization";

export type CatalogPublicationStores = {
  snapshotStore: SnapshotStore;
  catalog3SnapshotStore: Pick<BlobCatalog3SnapshotStore, "readLatest" | "publish">;
  publishLegacyConditions: (files: Conditions[], exact: boolean, now: Date) => Promise<ConditionsPublicationResult>;
  publishCatalog3Conditions: (files: z.infer<typeof ConditionsV3Schema>[], exact: boolean, now: Date) => Promise<ConditionsPublicationResult>;
};

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const completeConditions = (result: ConditionsPublicationResult, files: Array<{ countryCode: string }>) => {
  const ids = [...result.published, ...result.unchanged];
  return !result.failed.length && ids.length === files.length && new Set(ids).size === files.length
    && files.every((file) => ids.includes(file.countryCode));
};
const maxSnapshotBytes = 500_000;
const day = 24 * 3600000;

/** Publish from one committed read. No collection, reservation or evidence merge occurs here. */
export async function publishCommittedCatalog(options: {
  stateStore: StateStore; stores: CatalogPublicationStores; collection: CollectionControl;
  now: Date; family: "snapshots" | "conditions" | "all"; env?: Record<string, string | undefined>;
  completedAt?: () => Date; clock?: () => Date;
}) {
  const { stores } = options;
  const read = await options.stateStore.read();
  const wall = (options.clock || (() => new Date()))();
  // Collection start time can precede evidence committed by another worker.
  // Capture publication time after the read and admit only bounded clock skew.
  const checked = [options.now.getTime(), ...Object.values(read.data.expandedSourceHealth).map((receipt) => Date.parse(receipt.health.lastAttempt!)),
    ...Object.values(read.data.sources).flatMap((health) => health.lastAttempt ? [Date.parse(health.lastAttempt)] : []),
    ...Object.values(read.data.conditions.health).map((health) => Date.parse(health.checkedAt)),
    ...Object.values(read.data.conditions.locations).flatMap((value) => conditionRecords(value).map((record) => Date.parse(record.checkedAt)))];
  const latestCheck = Math.max(...checked);
  if (!Number.isFinite(wall.getTime()) || !Number.isFinite(latestCheck) || latestCheck > wall.getTime() + 5 * 60_000) throw new Error("Committed evidence is in the future");
  const now = new Date(Math.max(wall.getTime(), latestCheck));
  assertSupportedCollection(read.data, options.collection);
  if (read.data.collection.catalogVersion !== 3) throw new Error("Expanded publication requires catalog 3 collection");
  const transition = read.data.publicationTransition;
  const dual = Boolean(transition && (!transition.dualUntil || wall.getTime() < Date.parse(transition.dualUntil)));
  const snapshots = options.family !== "conditions";
  const conditions = options.family !== "snapshots";
  const env = options.env || process.env;
  // Build and validate every candidate before the first public write.
  const expandedSnapshot = snapshots ? buildCatalog3Snapshot(read.data, now) : undefined;
  const legacySnapshot = snapshots && dual ? projectCatalog2Snapshot(read.data, now) : undefined;
  for (const snapshot of [expandedSnapshot, legacySnapshot]) if (snapshot && Buffer.byteLength(JSON.stringify(snapshot)) > maxSnapshotBytes) {
    throw new Error("Snapshot exceeds 500 KB hard limit");
  }
  const files = conditions ? buildCatalog3Conditions(read.data, now, env) : [];
  const legacyFiles = conditions && dual ? projectCatalog2Conditions(read.data, now, env) : [];
  const fence = async () => assertSupportedCollection((await options.stateStore.read()).data, options.collection);
  let snapshotsComplete = snapshots;
  const futureCutoff = wall.getTime() + 5 * 60_000;
  if (expandedSnapshot) {
    const prior = await stores.catalog3SnapshotStore.readLatest();
    await fence();
    if (prior && Date.parse(prior.data.generatedAt) <= futureCutoff && Date.parse(prior.data.generatedAt) >= now.getTime()) {
      snapshotsComplete = equal(prior.data, expandedSnapshot);
    } else {
      const outcome = await stores.catalog3SnapshotStore.publish(expandedSnapshot, prior, wall);
      if (outcome.status !== "published") {
        const stored = await stores.catalog3SnapshotStore.readLatest();
        snapshotsComplete = Boolean(stored && equal(stored.data, expandedSnapshot));
      }
    }
  }
  if (legacySnapshot) {
    const prior = await stores.snapshotStore.readLatest();
    await fence();
    if (Date.parse(prior.data.generatedAt) <= futureCutoff && Date.parse(prior.data.generatedAt) >= now.getTime()) {
      snapshotsComplete = equal(prior.data, legacySnapshot) && snapshotsComplete;
    } else {
      await stores.snapshotStore.publish(legacySnapshot, prior);
    }
  }
  let publication: ConditionsPublicationResult = { published: [], unchanged: [], failed: [] };
  let legacyPublication: ConditionsPublicationResult = { published: [], unchanged: [], failed: [] };
  if (conditions) {
    await fence();
    publication = await stores.publishCatalog3Conditions(files, true, wall);
    if (dual) {
      await fence();
      legacyPublication = await stores.publishLegacyConditions(legacyFiles, true, wall);
    }
  }
  let acknowledged = false;
  if (options.family === "all" && dual && !transition!.dualStartedAt && snapshotsComplete
    && completeConditions(publication, files) && completeConditions(legacyPublication, legacyFiles)) {
    // Preserve evidence that changed during publication. Only acknowledge the
    // original transition, and never move an already acknowledged deadline.
    const completed = (options.completedAt || options.clock || (() => new Date()))();
    if (!Number.isFinite(completed.getTime()) || completed < wall) throw new Error("Invalid publication completion time");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await options.stateStore.read();
      assertSupportedCollection(latest.data, options.collection);
      if (latest.data.publicationTransition?.dualStartedAt) { acknowledged = true; break; }
      if (!equal(latest.data.publicationTransition, transition)) throw new Error("Publication transition changed during repair");
      latest.data.publicationTransition = { ...transition!, dualStartedAt: completed.toISOString(), dualUntil: new Date(+completed + day).toISOString() };
      try { await options.stateStore.write(latest.data, latest); acknowledged = true; break; }
      catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 2) throw error; }
    }
  }
  return { dual, acknowledged, snapshot: expandedSnapshot, snapshotsComplete,
    publication, legacyPublication, countries: files.length,
    conditionsBytes: files.reduce((sum, file) => sum + Buffer.byteLength(serializeCatalog3Conditions(file)), 0) };
}
