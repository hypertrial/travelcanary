import { publishCommittedCatalog, type CatalogPublicationStores } from "../catalog-publication";
import { CatalogPartitionedSourceResultSchema, ExpandedAggregateSourceResultSchema, assertSupportedCollection,
  type CatalogSourceResult as SourceResult, type CollectionControl, type IngestionState } from "../domain/catalog-state";
import { performance } from "node:perf_hooks";
import { AggregateSourceResultSchema, SnapshotV10SourceIdSchema, countryCodes, PartitionedSourceResultSchema, type CountryCode, type SourceId } from "../domain/schemas";
import { catalogV3CountryCodes } from "../domain/contract-identities";
import { locations } from "../data";
import { catalogLocationsV3 } from "../catalog-data";
import { mergeSourceResults } from "../risk";
import { ConcurrencyError, type StateStore } from "../state-store";
import { withFetchDiagnostics } from "./fetch";
import { MAX_EVENTS_PER_PARTITION, MAX_EVENTS_PER_SOURCE_RESULT, PRIVATE_STATE_HARD_LIMIT_BYTES } from "./limits";
import { createSourceDiagnostics, isExpandedSourceAdapter, partitionExecutionStatus, type Cadence, type MutableSourceDiagnostics, type SourceAdapter, type SourceExecutionSummary } from "./types";
import { expandedAdapterLocations, scopeAdapterResult } from "./collection-scope";
import { fitConditionsState } from "../conditions/state";
import { assertVersionedIngestionLease, type IngestionLease } from "../ingestion-lease";

type SourceExecution = { result: SourceResult; durationMs: number; diagnostics: MutableSourceDiagnostics };
const SOURCE_PHASE_BUDGET_MS = 45_000;
const SNAPSHOT_WARNING_BYTES = 300_000;

function assertSourceResultLimits(results: SourceResult[]) {
  for (const result of results) {
    if (!("partitions" in result)) {
      if (result.events.length > MAX_EVENTS_PER_SOURCE_RESULT) {
        throw new Error(`${result.sourceId} exceeds the ${MAX_EVENTS_PER_SOURCE_RESULT}-event source-result limit`);
      }
      continue;
    }
    for (const [countryCode, partition] of Object.entries(result.partitions)) {
      if (partition.events.length > MAX_EVENTS_PER_PARTITION) {
        throw new Error(`${result.sourceId}/${countryCode} exceeds the ${MAX_EVENTS_PER_PARTITION}-event partition limit`);
      }
    }
  }
}

function rounded(value: number) { return Math.max(0, Math.round(value)); }

function failedSourceResult(sourceId: SourceId, checkedAt: string, code: "transport_disabled" | "transport_failed", catalogVersion: 2 | 3): SourceResult {
  if (sourceId === "meteoalarm" || sourceId === "eea" || sourceId === "national-civil-alerts") {
    const codes = catalogVersion === 3 ? catalogV3CountryCodes : countryCodes;
    const schema = catalogVersion === 3 ? CatalogPartitionedSourceResultSchema : PartitionedSourceResultSchema;
    return schema.parse({ sourceId, checkedAt, partitions: Object.fromEntries(codes.map((countryCode) => [countryCode, {
      status: "failed", sourceUpdatedAt: null, events: [], error: code,
    }])) });
  }
  return (catalogVersion === 3 ? ExpandedAggregateSourceResultSchema : AggregateSourceResultSchema).parse({ sourceId, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: code });
}

// Also used by the catalog-3 runner: only explicitly reviewed adapters receive
// expanded locations. National and candidate-directed adapters retain catalog 2.
export async function collectAdapterResult(adapter: SourceAdapter, state: IngestionState, context: {
  now: Date; fetch: typeof fetch; deadlineAt: number; diagnostics: MutableSourceDiagnostics;
}): Promise<SourceResult> {
  const version = state.collection.catalogVersion;
  try {
    const result = await withFetchDiagnostics(context.diagnostics, () => isExpandedSourceAdapter(adapter)
      ? adapter.fetch({ ...context, state, locations: expandedAdapterLocations(adapter, version) })
      : adapter.fetch({ ...context, state, locations: version === 3 ? catalogLocationsV3 : locations }));
    return scopeAdapterResult(adapter, version, result);
  } catch {
    return scopeAdapterResult(adapter, version, failedSourceResult(adapter.id, context.now.toISOString(), "transport_failed", version));
  }
}

function sourceSummary(execution: SourceExecution): SourceExecutionSummary {
  const { result } = execution;
  if (!("partitions" in result)) return {
    status: result.status,
    events: result.events.length,
    durationMs: rounded(execution.durationMs),
    diagnostics: execution.diagnostics,
    error: result.error ? `source_${result.status}` : null,
  };
  const entries = Object.entries(result.partitions);
  const partialIds = entries.filter(([, partition]) => partition.status === "partial").map(([id]) => id as CountryCode);
  const failedIds = entries.filter(([, partition]) => partition.status === "failed").map(([id]) => id as CountryCode);
  const disabled = entries.filter(([, partition]) => partition.status === "disabled").length;
  const succeeded = entries.filter(([, partition]) => partition.status === "ok").length;
  const status = partitionExecutionStatus(entries.map(([, partition]) => partition));
  const error = status === "ok" ? null : `source_${status}`;
  return {
    status,
    events: entries.reduce((total, [, partition]) => total + partition.events.length, 0),
    durationMs: rounded(execution.durationMs),
    diagnostics: execution.diagnostics,
    partitions: { total: entries.length, succeeded, partial: partialIds.length, failed: failedIds.length, disabled, partialIds, failedIds },
    error,
  };
}

export async function runIngestion(options: {
  cadence: Cadence;
  adapters: SourceAdapter[];
  stateStore: StateStore;
  catalogPublication: CatalogPublicationStores;
  lease: IngestionLease;
  now?: Date;
  fetch?: typeof fetch;
}) {
  const totalStarted = performance.now();
  const deadlineAt = Date.now() + SOURCE_PHASE_BUDGET_MS;
  const now = options.now || new Date();
  const disabled = new Set((process.env.INGESTION_DISABLED_SOURCES || "").split(",").map((id) => id.trim()).filter(Boolean));
  if ([...disabled].some((id) => !SnapshotV10SourceIdSchema.safeParse(id).success)) throw new Error("Unknown INGESTION_DISABLED_SOURCES entry");
  const scheduled = options.adapters.filter((adapter) => adapter.cadence === options.cadence);
  const initialReadStarted = performance.now();
  const initialState = await options.stateStore.read();
  assertVersionedIngestionLease(initialState, options.lease, now);
  const collection = assertSupportedCollection(initialState.data);
  const adapters = scheduled.filter((adapter) => {
    if (adapter.id !== "gdelt" || process.env.GDELT_ENABLED !== "true") return true;
    const health = initialState.data.sources.gdelt;
    const backoffHours = health.consecutiveFailures >= 2 ? Math.min(6, 2 ** Math.min(3, health.consecutiveFailures - 1)) : 0;
    return !backoffHours || !health.lastAttempt || now.getTime() - Date.parse(health.lastAttempt) >= backoffHours * 3600000;
  });
  const initialReadMs = performance.now() - initialReadStarted;
  const sourceStarted = performance.now();
  const deadlineController = new AbortController();
  const remainingMs = deadlineAt - Date.now();
  const deadlineTimer = remainingMs > 0 ? setTimeout(() => deadlineController.abort(), remainingMs) : null;
  if (deadlineTimer === null) deadlineController.abort();
  const fetchImpl = options.fetch || fetch;
  const boundedFetch = ((input: RequestInfo | URL, init: RequestInit = {}) => fetchImpl(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadlineController.signal]) : deadlineController.signal,
  })) as typeof fetch;
  let executions: SourceExecution[];
  try {
    executions = await Promise.all(adapters.map(async (adapter): Promise<SourceExecution> => {
      const started = performance.now();
      const diagnostics = createSourceDiagnostics();
      // An operator transport stop consumes no request and retains unexpired
      // prior evidence through the existing failure lifecycle.
      const result = disabled.has(adapter.id)
        ? scopeAdapterResult(adapter, collection.catalogVersion, failedSourceResult(adapter.id, now.toISOString(), "transport_disabled", collection.catalogVersion))
        : await collectAdapterResult(adapter, initialState.data, {
          now, fetch: boundedFetch, deadlineAt, diagnostics,
        });
      return { result, durationMs: performance.now() - started, diagnostics };
    }));
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  return publishResults({
    ...options, now, collection, publicationClock: options.now ? () => options.now! : undefined, results: executions.map(({ result }) => result), executions,
    operation: options.cadence, sourceDurationMs: performance.now() - sourceStarted, initialReadMs, totalStarted,
  });
}

export async function runMaintenance(options: {
  stateStore: StateStore;
  catalogPublication: CatalogPublicationStores;
  lease: IngestionLease;
  now?: Date;
}) {
  const totalStarted = performance.now();
  const now = options.now || new Date();
  const initial = await options.stateStore.read();
  const collection = assertSupportedCollection(initial.data);
  return publishResults({
    ...options, now, collection, publicationClock: options.now ? () => options.now! : undefined, results: [], executions: [], operation: "maintenance",
    sourceDurationMs: 0, totalStarted,
    initialReadMs: 0,
  });
}

async function publishResults(options: {
  stateStore: StateStore;
  catalogPublication: CatalogPublicationStores;
  lease: IngestionLease;
  now: Date;
  results: SourceResult[];
  publicationClock?: () => Date;
  collection: CollectionControl;
  executions: SourceExecution[];
  operation: Cadence | "maintenance";
  sourceDurationMs: number;
  initialReadMs: number;
  totalStarted: number;
}) {
  assertSourceResultLimits(options.results);
  let committed = false;
  let readMs = options.initialReadMs; let mergeAndBuildMs = 0; let publishMs = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let phase = performance.now();
      const current = await options.stateStore.read();
      readMs += performance.now() - phase;
      assertVersionedIngestionLease(current, options.lease, options.publicationClock?.() || new Date());
      assertSupportedCollection(current.data, options.collection);
      if (!committed) {
        phase = performance.now();
        const next = fitConditionsState(mergeSourceResults(current.data, options.results, options.now), options.now);
        const stateBytes = Buffer.byteLength(JSON.stringify(next));
        if (stateBytes > PRIVATE_STATE_HARD_LIMIT_BYTES) throw new Error(`Private ingestion state exceeds 5 MB hard limit (${stateBytes} bytes)`);
        await options.stateStore.write(next, current); committed = true;
        mergeAndBuildMs += performance.now() - phase;
      }
      phase = performance.now();
      const publication = await publishCommittedCatalog({ stateStore: options.stateStore, stores: options.catalogPublication,
        collection: options.collection, lease: options.lease, now: options.now,
        family: options.operation === "maintenance" ? "all" : "snapshots" });
      publishMs += performance.now() - phase;
      const snapshot = publication.snapshot; const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      return { operation: options.operation, generatedAt: snapshot.generatedAt, status: "ok",
        locations: Object.keys(snapshot.locations).length, bytes, snapshotSizeWarning: bytes >= SNAPSHOT_WARNING_BYTES,
        sources: Object.fromEntries(options.executions.map((execution) => [execution.result.sourceId, sourceSummary(execution)])),
        publication: { manifestSha256: publication.pointer.manifestSha256, conditions: publication.publication },
        timings: { sourcesMs: rounded(options.sourceDurationMs), readMs: rounded(readMs), mergeAndBuildMs: rounded(mergeAndBuildMs),
          publishMs: rounded(publishMs), totalMs: rounded(performance.now() - options.totalStarted) } };
    } catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 1) throw error; }
  }
  throw new Error("Catalog 3 publication could not resolve a concurrent write");
}
