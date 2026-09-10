import { parseCatalogState, assertCatalog2Collection, type IngestionStateV14 as IngestionState } from "../src/lib/domain/catalog-state";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { get, put, BlobNotFoundError } from "@vercel/blob";
import { buildSnapshot, createEmptyState } from "../src/lib/risk";
import { parseSnapshot, type Snapshot } from "../src/lib/domain/schemas";
import { CompleteSnapshotSchema } from "../src/lib/snapshot-validation";
import { catalogV2Paths } from "../src/lib/catalog-paths";

type GetBlob = typeof get;
type PutBlob = typeof put;
type Existing<T> = { value: T; url: string };

export type InitializeStorageOptions = {
  privateToken: string;
  publicToken: string;
  now?: Date;
  getBlob?: GetBlob;
  putBlob?: PutBlob;
};

async function readExisting<T>(pathname: string, token: string, access: "public" | "private", parse: (value: unknown) => T, getBlob: GetBlob): Promise<Existing<T> | null> {
  try {
    const result = await getBlob(pathname, { token, access, useCache: false });
    if (!result) return null;
    if (!result.stream || result.statusCode !== 200) throw new Error(`Could not read ${pathname}`);
    return { value: parse(JSON.parse(await new Response(result.stream).text())), url: result.blob.url };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

function isBootstrapState(state: IngestionState): boolean {
  return state.events.length === 0 && Object.values(state.sources).every((source) => source.lastSuccess === null && source.itemCount === 0);
}

function isBootstrapSnapshot(snapshot: Snapshot): boolean {
  return Object.values(snapshot.locations).every((location) => location.level === "UNKNOWN" && location.hazards.length === 0)
    && Object.values(snapshot.providers).every((provider) => provider.lastSuccess === null);
}

export async function initializeStorage(options: InitializeStorageOptions): Promise<{ initialized: boolean; latestUrl: string }> {
  const getBlob = options.getBlob || get;
  const putBlob = options.putBlob || put;
  const now = options.now || new Date();
  const [existingState, existingLatest, existingPrevious] = await Promise.all([
    readExisting("ingestion-state.json", options.privateToken, "private", parseCatalogState, getBlob),
    readExisting(catalogV2Paths.snapshot, options.publicToken, "public", (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), getBlob),
    readExisting(catalogV2Paths.previousSnapshot, options.publicToken, "public", (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), getBlob),
  ]);

  if (existingState) assertCatalog2Collection(existingState.value);
  if (existingState && existingLatest && existingPrevious) return { initialized: false, latestUrl: existingLatest.url };
  if ((existingState && !isBootstrapState(existingState.value))
    || (existingLatest && !isBootstrapSnapshot(existingLatest.value))
    || (existingPrevious && !isBootstrapSnapshot(existingPrevious.value))) {
    throw new Error("Storage is partially initialized with non-bootstrap data; refusing to overwrite it");
  }

  const state = existingState?.value || createEmptyState(now);
  const snapshot = existingLatest?.value || existingPrevious?.value || buildSnapshot(state, now);
  if (!existingState) {
    await putBlob("ingestion-state.json", JSON.stringify(state), { token: options.privateToken, access: "private", contentType: "application/json", cacheControlMaxAge: 60 });
  }
  const latest = existingLatest || await putBlob(catalogV2Paths.snapshot, JSON.stringify(snapshot), { token: options.publicToken, access: "public", contentType: "application/json", cacheControlMaxAge: 60 });
  if (!existingPrevious) {
    await putBlob(catalogV2Paths.previousSnapshot, JSON.stringify(snapshot), { token: options.publicToken, access: "public", contentType: "application/json", cacheControlMaxAge: 60 });
  }

  const verified = await Promise.all([
    readExisting("ingestion-state.json", options.privateToken, "private", parseCatalogState, getBlob),
    readExisting(catalogV2Paths.snapshot, options.publicToken, "public", (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), getBlob),
    readExisting(catalogV2Paths.previousSnapshot, options.publicToken, "public", (value) => CompleteSnapshotSchema.parse(parseSnapshot(value)), getBlob),
  ]);
  if (verified.some((value) => value === null)) throw new Error("Storage verification failed");
  return { initialized: true, latestUrl: latest.url };
}

async function main() {
  const privateToken = process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
  const publicToken = process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
  if (!privateToken || !publicToken) throw new Error("Both Blob tokens are required");
  const result = await initializeStorage({ privateToken, publicToken });
  console.log(`${result.initialized ? "Initialized" : "Verified existing"} storage. Set NEXT_PUBLIC_SNAPSHOT_URL=${result.latestUrl}`);
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
