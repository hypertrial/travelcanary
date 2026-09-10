import { publishCommittedCatalog, type CatalogPublicationStores } from "../catalog-publication";
import { assertSupportedCollection, assertCatalog2Collection, type CollectionControl, type IngestionStateV14 as IngestionState } from "../domain/catalog-state";
import { performance } from "node:perf_hooks";
import { AggregateSourceResultSchema, SnapshotV10SourceIdSchema, countryCodes, PartitionedSourceResultSchema, type CountryCode, type SourceId, type SourceResult } from "../domain/schemas";
import { locations } from "../data";
import { buildSnapshot, mergeSourceResults } from "../risk";
import { snapshotProjectionMetrics } from "../risk-snapshot";
import { ConcurrencyError, type SnapshotStore, type StateStore } from "../storage";
import { CompleteSnapshotSchema } from "../snapshot-validation";
import { withFetchDiagnostics } from "./fetch";
import { MAX_EVENTS_PER_PARTITION, MAX_EVENTS_PER_SOURCE_RESULT, PRIVATE_STATE_HARD_LIMIT_BYTES } from "./limits";
import { createSourceDiagnostics, isExpandedSourceAdapter, partitionExecutionStatus, type Cadence, type MutableSourceDiagnostics, type SourceAdapter, type SourceExecutionSummary } from "./types";
import { expandedAdapterLocations, scopeAdapterResult } from "./collection-scope";
import { fitConditionsState } from "../conditions/state";

type SourceExecution = { result: SourceResult; durationMs: number; diagnostics: MutableSourceDiagnostics };
const SOURCE_PHASE_BUDGET_MS = 45_000;
const MAX_FUTURE_SNAPSHOT_SKEW_MS = 5 * 60_000;
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

function failedSourceResult(sourceId: SourceId, checkedAt: string, error: unknown): SourceResult {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300) || "Source failed unexpectedly";
  if (sourceId === "meteoalarm" || sourceId === "eea" || sourceId === "national-civil-alerts") {
    return PartitionedSourceResultSchema.parse({ sourceId, checkedAt, partitions: Object.fromEntries(countryCodes.map((countryCode) => [countryCode, {
      status: "failed", sourceUpdatedAt: null, events: [], error: message,
    }])) });
  }
  return AggregateSourceResultSchema.parse({ sourceId, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: message });
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
      : adapter.fetch({ ...context, state, locations }));
    return scopeAdapterResult(adapter, version, result);
  } catch (error) {
    return scopeAdapterResult(adapter, version, failedSourceResult(adapter.id, context.now.toISOString(), error));
  }
}

function buildValidatedSnapshot(state: IngestionState, now: Date) {
  const snapshot = CompleteSnapshotSchema.parse(buildSnapshot(state, now));
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > 500_000) throw new Error(`Snapshot exceeds 500 KB hard limit (${bytes} bytes)`);
  return { snapshot, bytes };
}

function publicationTime(now: Date, latestGeneratedAt: string) {
  const latest = Date.parse(latestGeneratedAt);
  if (latest > now.getTime() + MAX_FUTURE_SNAPSHOT_SKEW_MS) return now;
  return new Date(Math.max(now.getTime(), latest));
}

function sourceSummary(execution: SourceExecution): SourceExecutionSummary {
  const { result } = execution;
  if (!("partitions" in result)) return {
    status: result.status,
    events: result.events.length,
    durationMs: rounded(execution.durationMs),
    diagnostics: execution.diagnostics,
    error: result.error,
  };
  const entries = Object.entries(result.partitions);
  const partialIds = entries.filter(([, partition]) => partition.status === "partial").map(([id]) => id as CountryCode);
  const failedIds = entries.filter(([, partition]) => partition.status === "failed").map(([id]) => id as CountryCode);
  const disabled = entries.filter(([, partition]) => partition.status === "disabled").length;
  const succeeded = entries.filter(([, partition]) => partition.status === "ok").length;
  const status = partitionExecutionStatus(entries.map(([, partition]) => partition));
  const error = [
    partialIds.length ? `${partialIds.length} of ${entries.length} partitions partially unavailable` : null,
    failedIds.length ? `${failedIds.length} of ${entries.length} partitions failed` : null,
    disabled ? `${disabled} of ${entries.length} partitions readiness-gated` : null,
  ].filter(Boolean).join("; ") || null;
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
  snapshotStore: SnapshotStore;
  catalogPublication?: CatalogPublicationStores;
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
  const collection = (options.catalogPublication ? assertSupportedCollection : assertCatalog2Collection)(initialState.data);
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
        ? scopeAdapterResult(adapter, collection.catalogVersion, failedSourceResult(adapter.id, now.toISOString(), new Error("transport_disabled")))
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
  snapshotStore: SnapshotStore;
  catalogPublication?: CatalogPublicationStores;
  now?: Date;
}) {
  const totalStarted = performance.now();
  const now = options.now || new Date();
  const initial = await options.stateStore.read();
  const collection = (options.catalogPublication ? assertSupportedCollection : assertCatalog2Collection)(initial.data);
  return publishResults({
    ...options, now, collection, publicationClock: options.now ? () => options.now! : undefined, results: [], executions: [], operation: "maintenance",
    sourceDurationMs: 0, totalStarted,
    initialReadMs: 0,
  });
}

async function publishResults(options: {
  stateStore: StateStore;
  snapshotStore: SnapshotStore;
  catalogPublication?: CatalogPublicationStores;
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
  if (options.collection.catalogVersion === 3) {
    if (!options.catalogPublication) throw new Error("Expanded publication stores are required");
    let committed = false;
    let readMs = options.initialReadMs; let mergeAndBuildMs = 0; let publishMs = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let phase = performance.now();
        const current = await options.stateStore.read();
        readMs += performance.now() - phase;
        assertSupportedCollection(current.data, options.collection);
        if (!committed) {
          phase = performance.now();
          const next = fitConditionsState(mergeSourceResults(current.data, options.results, options.now), options.now);
          await options.stateStore.write(next, current); committed = true;
          mergeAndBuildMs += performance.now() - phase;
        }
        phase = performance.now();
        const publication = await publishCommittedCatalog({ stateStore: options.stateStore, stores: options.catalogPublication,
          collection: options.collection, now: options.now, clock: options.publicationClock, family: options.operation === "maintenance" ? "all" : "snapshots" });
        publishMs += performance.now() - phase;
        const snapshot = publication.snapshot!; const bytes = Buffer.byteLength(JSON.stringify(snapshot));
        return { operation: options.operation, generatedAt: snapshot.generatedAt,
          status: publication.snapshotsComplete && !publication.publication.failed.length && !publication.legacyPublication.failed.length ? "ok" : "partial",
          locations: Object.keys(snapshot.locations).length, bytes, snapshotSizeWarning: bytes >= SNAPSHOT_WARNING_BYTES,
          sources: Object.fromEntries(options.executions.map((execution) => [execution.result.sourceId, sourceSummary(execution)])),
          publication: { dual: publication.dual, acknowledged: publication.acknowledged, snapshotsComplete: publication.snapshotsComplete,
            conditions: publication.publication, legacyConditions: publication.legacyPublication },
          timings: { sourcesMs: rounded(options.sourceDurationMs), readMs: rounded(readMs), mergeAndBuildMs: rounded(mergeAndBuildMs), publishMs: rounded(publishMs), totalMs: rounded(performance.now() - options.totalStarted) } };
      } catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 1) throw error; }
    }
    throw new Error("Expanded publication could not resolve a concurrent write");
  }
  let snapshotConflictRetry = false;
  let readMs = options.initialReadMs;
  let mergeAndBuildMs = 0;
  let publishMs = 0;
  let resultsCommitted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let phaseStarted = performance.now();
    const [versionedState, versionedSnapshot] = await Promise.all([
      options.stateStore.read(), options.snapshotStore.readLatest(),
    ]);
    readMs += performance.now() - phaseStarted;

    assertCatalog2Collection(versionedState.data, options.collection);
    phaseStarted = performance.now();
    const nextState = fitConditionsState(resultsCommitted
      ? versionedState.data
      : mergeSourceResults(versionedState.data, options.results, options.now), options.now);
    const stateBytes = Buffer.byteLength(JSON.stringify(nextState));
    if (stateBytes > PRIVATE_STATE_HARD_LIMIT_BYTES) throw new Error(`Private ingestion state exceeds 5 MB hard limit (${stateBytes} bytes)`);
    const candidate = buildValidatedSnapshot(nextState, publicationTime(options.now, versionedSnapshot.data.generatedAt));
    let projectionState = nextState;
    mergeAndBuildMs += performance.now() - phaseStarted;

    phaseStarted = performance.now();
    try {
      if (!resultsCommitted) {
        await options.stateStore.write(nextState, versionedState);
        resultsCommitted = true;
      }
      assertCatalog2Collection((await options.stateStore.read()).data, options.collection);
      try {
        await options.snapshotStore.publish(candidate.snapshot, versionedSnapshot);
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || snapshotConflictRetry) throw error;
        snapshotConflictRetry = true;
        const latest = await options.snapshotStore.readLatest();
        const rebasedState = await options.stateStore.read();
        assertCatalog2Collection(rebasedState.data, options.collection);
        const rebuildStarted = performance.now();
        const rebased = buildValidatedSnapshot(rebasedState.data, publicationTime(options.now, latest.data.generatedAt));
        projectionState = rebasedState.data;
        mergeAndBuildMs += performance.now() - rebuildStarted;
        await options.snapshotStore.publish(rebased.snapshot, latest);
        candidate.snapshot = rebased.snapshot;
        candidate.bytes = rebased.bytes;
      }
      publishMs += performance.now() - phaseStarted;
      const sources = Object.fromEntries(options.executions.map((execution) => [
        execution.result.sourceId, sourceSummary(execution),
      ])) as Record<SourceId, SourceExecutionSummary>;
      return {
        operation: options.operation, generatedAt: candidate.snapshot.generatedAt,
        locations: Object.keys(candidate.snapshot.locations).length, bytes: candidate.bytes,
        snapshotSizeWarning: candidate.bytes >= SNAPSHOT_WARNING_BYTES,
        projection: snapshotProjectionMetrics(projectionState, candidate.snapshot, options.now),
        sources,
        timings: {
          sourcesMs: rounded(options.sourceDurationMs), readMs: rounded(readMs),
          mergeAndBuildMs: rounded(mergeAndBuildMs), publishMs: rounded(publishMs),
          totalMs: rounded(performance.now() - options.totalStarted),
        },
      };
    } catch (error) {
      publishMs += performance.now() - phaseStarted;
      if (error instanceof ConcurrencyError && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error("Ingestion could not resolve a concurrent write");
}
