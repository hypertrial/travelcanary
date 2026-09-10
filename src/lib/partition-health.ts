import type { SourceHealth } from "./domain/schemas";

function maximumIso(values: (string | null)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) || null;
}

export function aggregatePartitionHealth(partitions: Readonly<Record<string, SourceHealth>>): SourceHealth {
  const values = Object.values(partitions);
  const monitored = values.filter((health) => health.status !== "not_monitored");
  if (monitored.length === 0) return {
    status: "not_monitored", lastAttempt: maximumIso(values.map((health) => health.lastAttempt)), lastSuccess: null,
    sourceUpdatedAt: null, nextExpectedUpdate: null, itemCount: 0, consecutiveFailures: 0, error: "no_approved_country_feed",
  };
  const unavailable = monitored.filter((health) => health.status !== "ok");
  return {
    status: unavailable.length === 0 ? "ok" : unavailable.some((health) => health.status === "delayed") ? "delayed" : monitored.some((health) => health.status === "ok" || health.status === "partial") ? "partial" : "failed",
    lastAttempt: maximumIso(monitored.map((health) => health.lastAttempt)),
    lastSuccess: maximumIso(monitored.map((health) => health.lastSuccess)),
    sourceUpdatedAt: maximumIso(monitored.map((health) => health.sourceUpdatedAt)),
    nextExpectedUpdate: maximumIso(monitored.map((health) => health.nextExpectedUpdate)),
    itemCount: monitored.reduce((total, health) => total + health.itemCount, 0),
    consecutiveFailures: Math.max(...monitored.map((health) => health.consecutiveFailures)),
    error: unavailable.length ? `${unavailable.length} of ${monitored.length} enabled country feeds unavailable` : null,
  };
}

