import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceAdapters } from "../src/lib/ingestion/adapters";
import { locations } from "../src/lib/data";
import { eventAffectsLocation } from "../src/lib/geospatial";
import { providerIdForSourceId, type SourceId, type SourceResult } from "../src/lib/domain/schemas";
import { providerRegistry } from "../src/lib/provider-registry";
import { nationalWarningManifest } from "../src/lib/national-warning-sources";
import { withFetchDiagnostics } from "../src/lib/ingestion/fetch";
import {
  createSourceDiagnostics, partitionExecutionStatus, sourceExecutionFailsSmoke,
  type MutableSourceDiagnostics, type SourceAdapter, type SourceDiagnostics,
} from "../src/lib/ingestion/types";

const MAX_PARTITION_PROBLEMS = 12;

type PartitionProblem = {
  id: string;
  status: "partial" | "failed" | "disabled";
  unavailableLocations: number;
  error: string | null;
  limitationCode: string | null;
};

export type SourceSmokeSummary = {
  source: SourceId;
  provider: string;
  mode: string;
  healthScope: "global" | "coverage" | "non_blocking";
  satisfiesCoverage: boolean;
  status: "ok" | "partial" | "failed" | "disabled";
  outcome: "passed" | "failed" | "disabled";
  events: number;
  affectedLocations: number;
  unavailableLocations: number;
  updated: string | null;
  durationMs: number;
  diagnostics: SourceDiagnostics;
  limitationCode: string | null;
  error: string | null;
  partitions?: {
    total: number;
    ok: number;
    partial: number;
    failed: number;
    disabled: number;
    problems: PartitionProblem[];
    omittedProblems: number;
  };
  transports?: {
    total: number; due: number; skipped: number; healthyEmpty: number;
    roles: Record<"coverage" | "fallback" | "context" | "blocked", number>;
    credentialBlocked: number; evidenceBlocked: number; affectedDestinations: number;
    problems: Array<{ country: string; id: string; status: string; error: string | null; unavailableLocations: number }>;
    omittedProblems: number;
  };
};

function boundedError(value: unknown) {
  const text = value instanceof Error ? value.message : String(value || "");
  return text.replace(/\s+/g, " ").trim().slice(0, 180) || null;
}

function sourceMetadata(sourceId: SourceId) {
  const providerId = providerIdForSourceId(sourceId);
  const provider = providerRegistry[providerId];
  return {
    providerId,
    mode: provider.mode,
    healthScope: provider.healthScope || "global" as const,
    satisfiesCoverage: provider.satisfiesCoverage !== false && provider.mode !== "discovery" && provider.mode !== "disabled",
  };
}

export function summarizeSourceSmoke(
  result: SourceResult,
  diagnostics: SourceDiagnostics,
  durationMs: number,
  affectedLocations: number,
): SourceSmokeSummary {
  const metadata = sourceMetadata(result.sourceId);
  if (!("partitions" in result)) {
    const failed = sourceExecutionFailsSmoke(result.status);
    return {
      source: result.sourceId, provider: metadata.providerId, mode: metadata.mode, healthScope: metadata.healthScope,
      satisfiesCoverage: metadata.satisfiesCoverage, status: result.status,
      outcome: result.status === "disabled" ? "disabled" : failed ? "failed" : "passed",
      events: result.events.length, affectedLocations, unavailableLocations: result.unavailableLocationIds?.length || 0,
      updated: result.sourceUpdatedAt, durationMs: Math.max(0, Math.round(durationMs)), diagnostics,
      limitationCode: result.limitationCode || null, error: boundedError(result.error),
    };
  }

  const entries = Object.entries(result.partitions);
  const status = partitionExecutionStatus(entries.map(([, partition]) => partition));
  const priority = { failed: 0, partial: 1, disabled: 2 } as const;
  const allProblems = entries.flatMap(([id, partition]): PartitionProblem[] => partition.status === "ok" ? [] : [{
    id, status: partition.status, unavailableLocations: partition.unavailableLocationIds?.length || 0,
    error: boundedError(partition.error), limitationCode: partition.limitationCode || null,
  }]).sort((a, b) => priority[a.status] - priority[b.status] || a.id.localeCompare(b.id));
  const counts = (value: "ok" | "partial" | "failed" | "disabled") => entries.filter(([, partition]) => partition.status === value).length;
  const events = entries.flatMap(([, partition]) => partition.events);
  const failed = sourceExecutionFailsSmoke(status, entries.map(([, partition]) => partition));
  const transportEntries = entries.flatMap(([countryCode, partition]) => Object.entries(partition.transports || {})
    .map(([id, transport]) => ({ countryCode, id, transport, events: transport.events?.length ?? partition.events.length })));
  const transportProblems = transportEntries.filter(({ transport }) => transport.status === "failed" || transport.status === "partial")
    .map(({ countryCode, id, transport }) => ({ country: countryCode, id, status: transport.status,
      error: boundedError(transport.error), unavailableLocations: transport.unavailableLocationIds?.length || 0 }));
  const manifestSystems = result.sourceId === "national-civil-alerts" || result.sourceId === "meteoalarm"
    ? Object.values(nationalWarningManifest.countries).flatMap(({ systems }) => systems.filter((system) => system.runtimeTarget === (result.sourceId === "meteoalarm" ? "meteoalarm-fallback" : "national-civil-alerts")))
    : [];
  const roles = { coverage: 0, fallback: 0, context: 0, blocked: 0 };
  for (const system of manifestSystems) roles[system.role] += 1;
  return {
    source: result.sourceId, provider: metadata.providerId, mode: metadata.mode, healthScope: metadata.healthScope,
    satisfiesCoverage: metadata.satisfiesCoverage, status,
    outcome: status === "disabled" ? "disabled" : failed ? "failed" : "passed",
    events: events.length, affectedLocations,
    unavailableLocations: entries.reduce((total, [, partition]) => total + (partition.unavailableLocationIds?.length || 0), 0),
    updated: entries.map(([, partition]) => partition.sourceUpdatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null,
    durationMs: Math.max(0, Math.round(durationMs)), diagnostics, limitationCode: null,
    error: allProblems.length ? `${counts("failed")} failed, ${counts("partial")} partial, ${counts("disabled")} disabled` : null,
    partitions: {
      total: entries.length, ok: counts("ok"), partial: counts("partial"), failed: counts("failed"), disabled: counts("disabled"),
      problems: allProblems.slice(0, MAX_PARTITION_PROBLEMS), omittedProblems: Math.max(0, allProblems.length - MAX_PARTITION_PROBLEMS),
    },
    ...(transportEntries.length || manifestSystems.length ? { transports: {
      total: Math.max(manifestSystems.length, transportEntries.length),
      due: transportEntries.filter(({ transport }) => transport.status !== "not_due" && transport.status !== "disabled").length,
      skipped: transportEntries.filter(({ transport }) => transport.status === "not_due").length,
      healthyEmpty: transportEntries.filter(({ transport, events }) => transport.status === "ok" && events === 0).length,
      roles,
      credentialBlocked: manifestSystems.filter(({ status }) => status === "credential_gated").length,
      evidenceBlocked: manifestSystems.filter(({ status }) => status === "evidence_gated").length,
      affectedDestinations: new Set(transportEntries.flatMap(({ transport }) => transport.checkedLocationIds || [])).size,
      problems: transportProblems.slice(0, MAX_PARTITION_PROBLEMS), omittedProblems: Math.max(0, transportProblems.length - MAX_PARTITION_PROBLEMS),
    } } : {}),
  };
}

function failedSummary(adapter: SourceAdapter, diagnostics: SourceDiagnostics, durationMs: number, error: unknown): SourceSmokeSummary {
  const metadata = sourceMetadata(adapter.id);
  return {
    source: adapter.id, provider: metadata.providerId, mode: metadata.mode, healthScope: metadata.healthScope,
    satisfiesCoverage: metadata.satisfiesCoverage, status: "failed", outcome: "failed", events: 0, affectedLocations: 0,
    unavailableLocations: 0, updated: null, durationMs: Math.max(0, Math.round(durationMs)), diagnostics,
    limitationCode: null, error: boundedError(error),
  };
}

export async function executeSourceSmoke(
  adapter: SourceAdapter,
  options: { now?: Date; fetch?: typeof fetch } = {},
): Promise<SourceSmokeSummary> {
  const diagnostics: MutableSourceDiagnostics = createSourceDiagnostics();
  const started = performance.now();
  try {
    const result = await withFetchDiagnostics(diagnostics, () => adapter.fetch({
      now: options.now || new Date(), locations, fetch: options.fetch || fetch, diagnostics,
    }));
    const events = "partitions" in result ? Object.values(result.partitions).flatMap((partition) => partition.events) : result.events;
    const affectedLocations = new Set(events.flatMap((event) => locations
      .filter((location) => eventAffectsLocation(event, location)).map((location) => location.id))).size;
    return summarizeSourceSmoke(result, diagnostics, performance.now() - started, affectedLocations);
  } catch (error) {
    return failedSummary(adapter, diagnostics, performance.now() - started, error);
  }
}

async function main() {
  const selected = process.argv[2];
  const adapters = selected ? sourceAdapters.filter((adapter) => adapter.id === selected) : sourceAdapters;
  if (adapters.length === 0) throw new Error(`Unknown source: ${selected}`);
  for (const adapter of adapters) {
    const summary = await executeSourceSmoke(adapter);
    console.log(JSON.stringify(summary));
    if (summary.outcome === "failed") process.exitCode = 1;
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
