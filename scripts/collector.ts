import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { SerialCollector, type CollectorOperation } from "../src/lib/collector";
import { collectorEnvironment } from "../src/lib/local-policy";
import { initializeLocalRuntime, localStores, LocalDatabase, readLocalPolicy } from "../src/lib/local-storage";
import { readCollectorStatus, writeCollectorStatus, type CollectorStatus } from "../src/lib/local-status";

export async function runLocalCollector() {
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
  const database = new LocalDatabase();
  initializeLocalRuntime(database);
  const stores = localStores(database);
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
    try {
      const result = operation === "conditions"
        ? await runConditions({ stateStore: stores.stateStore, catalogPublication: stores.catalogPublication,
          publish: (files) => stores.catalogPublication.publishLegacyConditions(files, false, new Date()), env })
        : operation === "maintenance"
          ? await runMaintenance(stores)
          : await runIngestion({ cadence: operation, adapters: sourceAdapters, ...stores });
      lastSuccess = new Date().toISOString(); completedAt[operation] = lastSuccess; status("idle");
      console.info(JSON.stringify({ event: "collector_complete", operation, result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status("failed", message);
      console.error(JSON.stringify({ event: "collector_failed", operation, message }));
    }
  });
  void scheduler.start(completedAt);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(heartbeat); status("stopping");
    await scheduler.stop(); database.releaseCollector(owner); database.close();
  };
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  return { database, scheduler, stop };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await runLocalCollector();
