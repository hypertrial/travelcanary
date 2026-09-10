import type { CatalogPublicationStores } from "./catalog-publication";
import { timingSafeEqual } from "node:crypto";
import { sourceAdapters } from "./ingestion/adapters";
import { runIngestion, runMaintenance } from "./ingestion/orchestrator";
import { BlobCatalog3SnapshotStore, BlobSnapshotStore, BlobStateStore, publishCatalog3ConditionsFiles, publishConditionsFiles } from "./storage";
import { runConditions } from "./conditions/worker";
import type { Cadence } from "./ingestion/types";
import { assertSourceRuntimeIntegrity } from "./ingestion/source-runtime";

assertSourceRuntimeIntegrity();

function authorized(request: Request, secret: string) {
  const supplied = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function productionStores() {
  const privateToken = process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
  const publicToken = process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
  if (!privateToken || !publicToken) throw new Error("Vercel Blob storage is not configured");
  const snapshotStore = new BlobSnapshotStore(publicToken);
  const catalogPublication: CatalogPublicationStores = {
    snapshotStore, catalog3SnapshotStore: new BlobCatalog3SnapshotStore(publicToken),
    publishLegacyConditions: (files, exact, now) => publishConditionsFiles(files, publicToken, { requireExactGeneration: exact, now }),
    publishCatalog3Conditions: (files, exact, now) => publishCatalog3ConditionsFiles(files, publicToken, { requireExactGeneration: exact, now }),
  };
  return { stateStore: new BlobStateStore(privateToken), snapshotStore, catalogPublication };
}

async function handleCronRequest(request: Request, operation: Cadence | "maintenance" | "conditions") {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Cron is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!authorized(request, secret)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (process.env.INGESTION_PAUSED === "true") return Response.json({ status: "paused" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const stores = productionStores();
    const summary = operation === "conditions"
      ? await runConditions({ stateStore: stores.stateStore, catalogPublication: stores.catalogPublication, publish: (files) => publishConditionsFiles(files, process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN!) })
      : operation === "maintenance"
      ? await runMaintenance(stores)
      : await runIngestion({ cadence: operation, adapters: sourceAdapters, ...stores });
    console.info(JSON.stringify({ event: "ingestion_complete", ...summary }));
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingestion failed";
    console.error(JSON.stringify({ event: "ingestion_failed", operation, message }));
    return Response.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export function handleCron(request: Request, cadence: Cadence) { return handleCronRequest(request, cadence); }
export function handleMaintenance(request: Request) { return handleCronRequest(request, "maintenance"); }
export function handleConditions(request: Request) { return handleCronRequest(request, "conditions"); }
