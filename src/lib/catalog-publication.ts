import { catalogMembershipHash } from "./catalog-membership";
import { buildCatalog3Conditions, buildCatalog3Snapshot } from "./catalog-projections";
import { catalog3CoverageTarget } from "./coverage-measurement";
import { serializeCatalog3Conditions } from "./conditions/serialization";
import { PublicationManifestV1Schema, PublicationPointerV1Schema, publicationManifestPath,
  publicationObjectPath, type PublicationManifestV1, type PublicationObject } from "./domain/publication";
import { assertSupportedCollection, type CollectionControl } from "./domain/catalog-state";
import { assertIngestionLease, type IngestionLease } from "./ingestion-lease";
import { publicationSha256, readCurrentPublication, type PublicationStore } from "./publication-store";
import type { StateStore } from "./state-store";

export type CatalogPublicationStores = { publicationStore: PublicationStore };

function releaseSha(env: Record<string, string | undefined>) {
  const value = (env.VERCEL_GIT_COMMIT_SHA || env.TRAVELCANARY_RELEASE_SHA || "").trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(value) ? value : null;
}

function object(body: string, generatedAt: string): PublicationObject {
  const sha256 = publicationSha256(body);
  return { path: publicationObjectPath(sha256), sha256, bytes: Buffer.byteLength(body), generatedAt };
}

function statusCodes(state: Awaited<ReturnType<StateStore["read"]>>["data"]) {
  const codes = new Set<string>();
  for (const [id, health] of Object.entries(state.sources)) if (["failed", "delayed"].includes(health.status)) codes.add(`source/${id}/${health.status}`);
  for (const [group, countries] of Object.entries(state.sourcePartitions)) for (const [country, health] of Object.entries(countries)) {
    if (["failed", "delayed"].includes(health.status)) codes.add(`partition/${group.toLowerCase()}/${country.toLowerCase()}/${health.status}`);
  }
  return [...codes].sort().slice(0, 100);
}

function latestEvidenceTime(state: Awaited<ReturnType<StateStore["read"]>>["data"], requested: Date) {
  const checked = [requested.getTime(), Date.parse(state.updatedAt),
    ...Object.values(state.sources).flatMap((health) => health.lastAttempt ? [Date.parse(health.lastAttempt)] : []),
    ...Object.values(state.conditions.health).map((health) => Date.parse(health.checkedAt)),
  ];
  const latest = Math.max(...checked.filter(Number.isFinite));
  if (!Number.isFinite(requested.getTime()) || latest > requested.getTime() + 5 * 60_000) throw new Error("Committed evidence is in the future");
  return new Date(Math.max(requested.getTime(), latest));
}

export async function publishCommittedCatalog(options: {
  stateStore: StateStore;
  stores: CatalogPublicationStores;
  collection: CollectionControl;
  lease: IngestionLease;
  now: Date;
  family: "snapshots" | "conditions" | "all";
  env?: Record<string, string | undefined>;
}) {
  const env = options.env || process.env;
  const read = await options.stateStore.read();
  assertSupportedCollection(read.data, options.collection);
  if (!read.data.ingestionLease || read.data.ingestionLease.owner !== options.lease.owner
    || read.data.ingestionLease.fence !== options.lease.fence) throw new Error("Publication requires the active ingestion lease");
  const generatedAt = latestEvidenceTime(read.data, options.now);
  const producerCommitSha = releaseSha(env);
  const snapshot = buildCatalog3Snapshot(read.data, generatedAt);
  const snapshotBody = JSON.stringify(snapshot);
  const snapshotObject = object(snapshotBody, snapshot.generatedAt);
  const current = await readCurrentPublication(options.stores.publicationStore);
  const canReuseConditions = options.family === "snapshots" && current
    && current.manifest.producerCommitSha === producerCommitSha
    && current.manifest.conditions.length === 45
    && current.manifest.conditions.every(({ generatedAt: value }) => generatedAt.getTime() - Date.parse(value) <= 60 * 60_000);
  const conditionFiles = canReuseConditions ? [] : buildCatalog3Conditions(read.data, generatedAt, {
    ...env, ...(producerCommitSha ? { VERCEL_GIT_COMMIT_SHA: producerCommitSha } : {}),
  });
  const conditionBodies = conditionFiles.map((file) => ({ file, body: serializeCatalog3Conditions(file) }));
  const conditions = canReuseConditions ? current.manifest.conditions : conditionBodies.map(({ file, body }) => ({
    ...object(body, file.generatedAt), countryCode: file.countryCode,
  })).sort((a, b) => a.countryCode.localeCompare(b.countryCode));

  await options.stores.publicationStore.putImmutable(snapshotObject.path, snapshotBody);
  for (const { body, file } of conditionBodies) {
    const reference = conditions.find(({ countryCode }) => countryCode === file.countryCode)!;
    await options.stores.publicationStore.putImmutable(reference.path, body);
  }

  const codes = statusCodes(read.data);
  const manifest = PublicationManifestV1Schema.parse({
    schemaVersion: 1,
    catalogVersion: 3,
    generatedAt: generatedAt.toISOString(),
    producerCommitSha,
    stateRevision: read.data.stateRevision,
    collectionRevision: read.data.collection.revision,
    ingestionFence: options.lease.fence,
    membershipHash: catalogMembershipHash(Object.keys(snapshot.locations)),
    coverageContractHash: publicationSha256(JSON.stringify(catalog3CoverageTarget)),
    complete: true,
    snapshot: snapshotObject,
    conditions,
    status: { state: codes.length || snapshot.dataHealth !== "complete" ? "degraded" : "complete", codes,
      collectorLastSuccess: generatedAt.toISOString() },
  });
  const manifestBody = JSON.stringify(manifest);
  const manifestSha256 = publicationSha256(manifestBody);
  const manifestPath = publicationManifestPath(manifestSha256);
  await options.stores.publicationStore.putImmutable(manifestPath, manifestBody);

  const latest = await assertIngestionLease(options.stateStore, options.lease, generatedAt);
  if (latest.data.stateRevision !== read.data.stateRevision) throw new Error("Private state changed during publication");
  const pointer = PublicationPointerV1Schema.parse({
    schemaVersion: 1,
    catalogVersion: 3,
    manifestPath,
    manifestSha256,
    publishedAt: generatedAt.toISOString(),
    producerCommitSha,
    stateRevision: read.data.stateRevision,
    collectionRevision: read.data.collection.revision,
    ingestionFence: options.lease.fence,
  });
  const pointerWrite = await options.stores.publicationStore.replacePointer(JSON.stringify(pointer), current?.pointerEtag || null);
  const publication = conditionFiles.length
    ? { published: conditionFiles.map(({ countryCode }) => countryCode).sort(), unchanged: [] as string[], failed: [] as Array<{ countryCode: string; code: string }> }
    : { published: [] as string[], unchanged: conditions.map(({ countryCode }) => countryCode).sort(), failed: [] as Array<{ countryCode: string; code: string }> };
  if (options.family === "all") await prunePublications(options.stores.publicationStore, pointer, generatedAt);
  return {
    snapshot,
    pointer,
    pointerUrl: pointerWrite.url,
    manifest,
    snapshotsComplete: true,
    publication,
    countries: conditions.length,
    conditionsBytes: conditionBodies.reduce((total, { body }) => total + Buffer.byteLength(body), 0),
  };
}

export async function prunePublications(store: PublicationStore, current: { manifestPath: string }, now = new Date()) {
  const cutoff = now.getTime() - 48 * 60 * 60_000;
  const manifests = (await store.list("catalogs/3/generations/", 10_000)).filter(({ pathname }) => pathname.endsWith("/manifest.json"))
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  const keepPaths = new Set<string>([current.manifestPath]);
  const rollback = manifests.find(({ pathname }) => pathname !== current.manifestPath);
  if (rollback) keepPaths.add(rollback.pathname);
  for (const item of manifests) if (item.uploadedAt.getTime() >= cutoff) keepPaths.add(item.pathname);
  const referenced = new Set<string>();
  for (const pathname of keepPaths) {
    const item = await store.read(pathname, 512_000);
    if (!item) continue;
    let manifest: PublicationManifestV1;
    try { manifest = PublicationManifestV1Schema.parse(JSON.parse(item.body)); } catch { continue; }
    referenced.add(manifest.snapshot.path);
    for (const item of manifest.conditions) referenced.add(item.path);
  }
  await store.deleteMany(manifests.filter(({ pathname }) => !keepPaths.has(pathname)).map(({ pathname }) => pathname));
  const objects = await store.list("catalogs/3/objects/sha256/", 10_000);
  await store.deleteMany(objects.filter(({ pathname, uploadedAt }) => uploadedAt.getTime() < cutoff && !referenced.has(pathname)).map(({ pathname }) => pathname));
}
