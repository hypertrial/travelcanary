import type { CatalogLocation } from "../catalog-data";
import { expandedReceiptSourceIds, type IngestionStateV14 as IngestionState } from "../domain/catalog-state";
import type { CountryCode, Location, SourceId, SourceResult } from "../domain/schemas";

export type Cadence = "fast" | "slow" | "satellite" | "daily";

export interface IngestionContext {
  now: Date;
  locations: Location[];
  fetch: typeof fetch;
  state?: IngestionState;
  deadlineAt?: number;
  diagnostics?: MutableSourceDiagnostics;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly cadence: Cadence;
  readonly catalogVersion?: 2 | 3;
  fetch(context: IngestionContext): Promise<SourceResult>;
}

export type ExpandedIngestionContext = Omit<IngestionContext, "locations"> & { locations: CatalogLocation[] };
export interface ExpandedSourceAdapter extends SourceAdapter {
  readonly id: (typeof expandedReceiptSourceIds)[number];
  readonly catalogVersion: 3;
  fetch(context: ExpandedIngestionContext): Promise<SourceResult>;
}
export function isExpandedSourceAdapter(adapter: SourceAdapter): adapter is ExpandedSourceAdapter {
  return adapter.catalogVersion === 3 && (expandedReceiptSourceIds as readonly string[]).includes(adapter.id);
}

export interface SourceExecutionSummary {
  status: "ok" | "partial" | "failed" | "disabled";
  events: number;
  durationMs: number;
  partitions?: { total: number; succeeded: number; partial: number; failed: number; disabled: number; partialIds: CountryCode[]; failedIds: CountryCode[] };
  diagnostics: SourceDiagnostics;
  error: string | null;
}

export interface SourceDiagnostics {
  requests: number;
  retries: number;
  responseBytes: number;
  recordsExamined: number;
  targetsScheduled: number;
  targetsCompleted: number;
  matchedLocations: number;
  overflowCodes: string[];
  outcomeCodes: string[];
  responseBytesByCategory: Record<string, number>;
}

export type MutableSourceDiagnostics = SourceDiagnostics;

export function createSourceDiagnostics(): MutableSourceDiagnostics {
  return {
    requests: 0,
    retries: 0,
    responseBytes: 0,
    recordsExamined: 0,
    targetsScheduled: 0,
    targetsCompleted: 0,
    matchedLocations: 0,
    overflowCodes: [],
    outcomeCodes: [],
    responseBytesByCategory: {},
  };
}

const diagnosticCountKeys = ["recordsExamined", "targetsScheduled", "targetsCompleted", "matchedLocations"] as const;

export function recordSourceDiagnostics(
  context: Pick<IngestionContext, "diagnostics">,
  values: Partial<Pick<SourceDiagnostics, typeof diagnosticCountKeys[number]>> & { overflowCode?: string; outcomeCode?: string },
) {
  if (!context.diagnostics) return;
  for (const key of diagnosticCountKeys) {
    const value = values[key];
    if (value !== undefined) context.diagnostics[key] += Math.max(0, Math.round(value));
  }
  const code = values.overflowCode?.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  if (code && context.diagnostics.overflowCodes.length < 16 && !context.diagnostics.overflowCodes.includes(code)) {
    context.diagnostics.overflowCodes.push(code);
  }
  const outcome = values.outcomeCode?.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  if (outcome && context.diagnostics.outcomeCodes.length < 16 && !context.diagnostics.outcomeCodes.includes(outcome)) {
    context.diagnostics.outcomeCodes.push(outcome);
  }
}

export function partitionExecutionStatus(partitions: ReadonlyArray<{ status: "ok" | "partial" | "failed" | "disabled" }>) {
  const enabled = partitions.filter(({ status }) => status !== "disabled");
  if (enabled.length === 0) return "disabled" as const;
  if (enabled.every(({ status }) => status === "failed")) return "failed" as const;
  if (enabled.some(({ status }) => status !== "ok") || enabled.length !== partitions.length) return "partial" as const;
  return "ok" as const;
}

export function sourceExecutionFailsSmoke(
  status: "ok" | "partial" | "failed" | "disabled",
  partitions?: ReadonlyArray<{ status: "ok" | "partial" | "failed" | "disabled" }>,
) {
  return partitions
    ? partitions.some((partition) => partition.status === "partial" || partition.status === "failed")
    : status === "partial" || status === "failed";
}
