import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BlobNotFoundError, get, put } from "@vercel/blob";
import { publishCommittedCatalog } from "../src/lib/catalog-publication";
import { BlobPublicationStore, type PublicationStore } from "../src/lib/publication-store";
import { createEmptyState } from "../src/lib/risk";
import { BlobStateStore } from "../src/lib/state-store";
import { acquireIngestionLease, newLeaseOwner, releaseIngestionLease } from "../src/lib/ingestion-lease";

export async function initializeStorage(options: { privateToken: string; publicToken: string; now?: Date;
  getBlob?: typeof get; putBlob?: typeof put; publicationStore?: PublicationStore }) {
  const now = options.now || new Date();
  const getBlob = options.getBlob || get; const putBlob = options.putBlob || put;
  let initialized = false;
  try {
    const existing = await getBlob("ingestion-state.json", { token: options.privateToken, access: "private", useCache: false });
    if (!existing || existing.statusCode !== 200 || !existing.stream) throw new BlobNotFoundError();
    await existing.stream.cancel();
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
    await putBlob("ingestion-state.json", JSON.stringify(createEmptyState(now)), { token: options.privateToken, access: "private",
      allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 });
    initialized = true;
  }
  const stateStore = new BlobStateStore(options.privateToken, "ingestion-state.json", getBlob, putBlob);
  const lease = await acquireIngestionLease(stateStore, newLeaseOwner("storage-init"), now);
  if (!lease) throw new Error("Another writer owns the ingestion lease");
  try {
    const state = await stateStore.read();
    const publication = await publishCommittedCatalog({ stateStore, stores: { publicationStore: options.publicationStore || new BlobPublicationStore(options.publicToken) },
      collection: state.data.collection, lease, now, family: "all" });
    return { initialized, latestUrl: publication.pointerUrl || null, manifestSha256: publication.pointer.manifestSha256 };
  } finally { await releaseIngestionLease(stateStore, lease); }
}

async function main() {
  const privateToken = process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
  const publicToken = process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
  if (!privateToken || !publicToken) throw new Error("Both Blob tokens are required");
  const result = await initializeStorage({ privateToken, publicToken });
  console.log(JSON.stringify({ initialized: result.initialized, manifestSha256: result.manifestSha256 }));
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
