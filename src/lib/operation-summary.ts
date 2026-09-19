import { conditionSourceIds } from "./domain/conditions";
import { sourceIds } from "./domain/schemas";

const counterKeys = ["locations", "countries", "bytes", "privateStateBytes", "cacheBytes", "durationMs", "sourceDurationMs"] as const;
const timingKeys = ["sourcesMs", "readMs", "mergeAndBuildMs", "publishMs", "totalMs"] as const;
const publicationCounterKeys = ["published", "unchanged", "failed", "omittedFailures"] as const;
const diagnosticSourceIds = new Set<string>([...sourceIds, ...conditionSourceIds]);

export function publicOperationSummary(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const status = typeof source.status === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(source.status) ? source.status : "failed";
  const summary: Record<string, unknown> = { status };
  for (const key of counterKeys) {
    const counter = source[key];
    if (typeof counter === "number" && Number.isFinite(counter) && counter >= 0) summary[key] = counter;
  }
  const publication = source.publication;
  if (publication && typeof publication === "object" && !Array.isArray(publication)) {
    const counters: Record<string, number> = {};
    for (const key of publicationCounterKeys) {
      const counter = (publication as Record<string, unknown>)[key];
      if (typeof counter === "number" && Number.isFinite(counter) && counter >= 0) counters[key] = counter;
    }
    if (Object.keys(counters).length) summary.publication = counters;
  }
  if (source.sources && typeof source.sources === "object" && !Array.isArray(source.sources)) {
    const counts = { successful: 0, partial: 0, failed: 0, disabled: 0 };
    const degradedSourceIds: string[] = [];
    for (const [id, value] of Object.entries(source.sources).sort(([left], [right]) => left.localeCompare(right)).slice(0, 64)) {
      if (!diagnosticSourceIds.has(id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const status = (value as Record<string, unknown>).status;
      if (status === "ok") counts.successful += 1;
      else if (status === "partial") { counts.partial += 1; degradedSourceIds.push(id); }
      else if (status === "disabled" || status === "not_monitored") counts.disabled += 1;
      else if (status === "failed" || status === "delayed") { counts.failed += 1; degradedSourceIds.push(id); }
    }
    summary.sourceSummary = counts;
    summary.degradedSourceIds = degradedSourceIds;
  }
  const timings = source.timings;
  if (timings && typeof timings === "object" && !Array.isArray(timings)) {
    const copied: Record<string, number> = {};
    for (const key of timingKeys) {
      const value = (timings as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) copied[key] = value;
    }
    if (Object.keys(copied).length) summary.timings = copied;
  }
  return summary;
}
