import type { CatalogPublicationStores } from "./catalog-publication";
import { timingSafeEqual } from "node:crypto";
import { sourceAdapters } from "./ingestion/adapters";
import { runIngestion, runMaintenance } from "./ingestion/orchestrator";
import { BlobStateStore } from "./state-store";
import { BlobPublicationStore } from "./publication-store";
import { runConditions } from "./conditions/worker";
import type { Cadence } from "./ingestion/types";
import { assertSourceRuntimeIntegrity } from "./ingestion/source-runtime";
import { acquireIngestionLease, newLeaseOwner, releaseIngestionLease } from "./ingestion-lease";
import { publicOperationSummary } from "./operation-summary";

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
  const catalogPublication: CatalogPublicationStores = { publicationStore: new BlobPublicationStore(publicToken) };
  return { stateStore: new BlobStateStore(privateToken), catalogPublication };
}

async function handleCronRequest(request: Request, operation: Cadence | "maintenance" | "conditions") {
  if (process.env.VERCEL_ENV !== "production") return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const secret = process.env.CRON_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) return Response.json({ error: "Cron is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!authorized(request, secret)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });
  if (process.env.INGESTION_PAUSED === "true") return Response.json({ status: "paused" }, { headers: { "Cache-Control": "no-store" } });
  let stores: ReturnType<typeof productionStores> | null = null;
  let lease: Awaited<ReturnType<typeof acquireIngestionLease>> = null;
  try {
    stores = productionStores();
    lease = await acquireIngestionLease(stores.stateStore, newLeaseOwner(`vercel-${operation}`));
    if (!lease) return Response.json({ status: "busy" }, { headers: { "Cache-Control": "no-store" } });
    const summary = operation === "conditions"
      ? await runConditions({ ...stores, lease })
      : operation === "maintenance"
      ? await runMaintenance({ ...stores, lease })
      : await runIngestion({ cadence: operation, adapters: sourceAdapters, ...stores, lease });
    const response = publicOperationSummary(summary);
    console.info(JSON.stringify({ event: "ingestion_complete", operation, ...response }));
    return Response.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error(JSON.stringify({ event: "ingestion_failed", operation, code: "operation_failed" }));
    return Response.json({ error: "Ingestion failed", code: "operation_failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  } finally {
    if (stores && lease) try { await releaseIngestionLease(stores.stateStore, lease); }
    catch { console.error(JSON.stringify({ event: "ingestion_release_failed", operation, code: "lease_release_failed" })); }
  }
}

export function handleCron(request: Request, cadence: Cadence) { return handleCronRequest(request, cadence); }
export function handleMaintenance(request: Request) { return handleCronRequest(request, "maintenance"); }
export function handleConditions(request: Request) { return handleCronRequest(request, "conditions"); }
