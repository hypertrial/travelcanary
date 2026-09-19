import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { collectorOperations, SerialCollector, type CollectorOperation } from "../src/lib/collector";
import { collectorEnvironment } from "../src/lib/local-policy";
import { initializeLocalRuntime, localStores, LocalDatabase, readLocalPolicy } from "../src/lib/local-storage";
import { readCollectorStatus, writeCollectorStatus, type CollectorStatus } from "../src/lib/local-status";
import { FilePublicationStore } from "../src/lib/publication-store";
import { runtimePaths } from "../src/lib/runtime-paths";
import { acquireIngestionLease, newLeaseOwner, releaseIngestionLease } from "../src/lib/ingestion-lease";
import { classifyOperationFailure } from "../src/lib/operation-failure";
import { publicOperationSummary } from "../src/lib/operation-summary";

export async function runLocalCollector(options: { once?: boolean } = {}) {
  if (process.env.TRAVELCANARY_RUNTIME !== "local") throw new Error("Collector requires TRAVELCANARY_RUNTIME=local");
  // These reviewed connectors remain legal/technical gates in the public runtime.
  process.env.CONTEXT_FEEDS_ENABLED = "false";
  process.env.GDELT_ENABLED = "false";
  process.env.GFM_ENABLED = "false";
  process.env.GLOFAS_TARGETING_ENABLED = "false";
  process.env.IFRC_FALLBACK_ENABLED = "false";
  const [{ sourceAdapters }, { runIngestion, runMaintenance }, { runConditions }] = await Promise.all([
    import("../src/lib/ingestion/adapters"),
    import("../src/lib/ingestion/orchestrator"),
    import("../src/lib/conditions/worker"),
  ]);
  const paths = runtimePaths(process.env, true);
  const database = new LocalDatabase(resolve(paths.privateRoot, "travelcanary.db"));
  initializeLocalRuntime(database);
  const stores = localStores(database, new FilePublicationStore(paths.publicRoot, true));
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  database.acquireCollector(owner);
  const previousStatus = readCollectorStatus(database);
  let lastSuccess = previousStatus?.lastSuccess ?? null;
  let lastOperation: CollectorOperation | null = previousStatus?.lastOperation ?? null;
  const completedAt = { ...previousStatus?.completedAt };
  let collectorState: CollectorStatus["state"] = "starting";
  const status = (state: CollectorStatus["state"], error: string | null = null) => writeCollectorStatus(database, {
    schemaVersion: 1, state: collectorState = state, lastHeartbeat: new Date().toISOString(), lastSuccess, lastOperation, lastError: error?.slice(0, 300) || null, completedAt,
  });
  status("starting");
  const heartbeat = setInterval(() => { database.acquireCollector(owner); status(collectorState); }, 30_000);
  const scheduler = new SerialCollector(async (operation) => {
    lastOperation = operation; status("running");
    const env = collectorEnvironment(readLocalPolicy(database).policy);
    const ingestionLease = await acquireIngestionLease(stores.stateStore, newLeaseOwner(`local-${operation}`));
    if (!ingestionLease) { status("idle"); return; }
    try {
      const result = operation === "conditions"
        ? await runConditions({ stateStore: stores.stateStore, catalogPublication: stores.catalogPublication, lease: ingestionLease, env })
        : operation === "maintenance"
          ? await runMaintenance({ stateStore: stores.stateStore, catalogPublication: stores.catalogPublication, lease: ingestionLease })
          : await runIngestion({ cadence: operation, adapters: sourceAdapters, stateStore: stores.stateStore,
            catalogPublication: stores.catalogPublication, lease: ingestionLease });
      lastSuccess = new Date().toISOString(); completedAt[operation] = lastSuccess; status("idle");
      console.info(JSON.stringify({ event: "collector_complete", operation, ...publicOperationSummary(result) }));
    } catch (error) {
      const code = classifyOperationFailure(error);
      status("failed", code);
      console.error(JSON.stringify({ event: "collector_failed", operation, code }));
    } finally { await releaseIngestionLease(stores.stateStore, ingestionLease); }
  });
  if (options.once) {
    for (const operation of collectorOperations) await scheduler.enqueue(operation);
  } else { void scheduler.start(completedAt); status("idle"); }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(heartbeat); status("stopping");
    await scheduler.stop(); database.releaseCollector(owner); database.close();
  };
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  if (options.once) await stop();
  return { database, scheduler, stop };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await runLocalCollector({ once: process.argv.includes("--once") });
