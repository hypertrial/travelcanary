import { pathToFileURL } from "node:url";
import { BlobStateStore, type StateStore } from "../src/lib/storage";
import { assertSupportedCollection } from "../src/lib/domain/catalog-state";

export async function activateCatalog3(store: StateStore, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid activation time");
  const current = await store.read();
  assertSupportedCollection(current.data);
  if (current.data.collection.catalogVersion === 3) return { status: "unchanged", collection: current.data.collection };
  if (current.data.conditions.lease && Date.parse(current.data.conditions.lease.expiresAt) > now.getTime()) throw new Error("An active conditions lease has not drained");
  const revision = current.data.collection.revision + 1;
  current.data.collection = { catalogVersion: 3, revision };
  current.data.publicationTransition = { from: 2, to: 3, revision, dualStartedAt: null, dualUntil: null };
  await store.write(current.data, current);
  return { status: "activated", collection: current.data.collection, publication: "awaiting-complete-dual-generation" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Explicit operator command after deploying the compatible foundation, pausing
  // cron and draining old workers. A revision fence cannot recall issued writes.
  if (process.argv.length !== 3 || process.argv[2] !== "--drained") {
    throw new Error("Usage: node --import tsx scripts/activate-catalog3.ts --drained (pause cron and drain workers first)");
  }
  if (process.env.INGESTION_PAUSED !== "true") throw new Error("Activation requires INGESTION_PAUSED=true and a drained deployment");
  const token = process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("Private storage is not configured");
  console.log(JSON.stringify(await activateCatalog3(new BlobStateStore(token))));
}
