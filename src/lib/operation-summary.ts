const counterKeys = ["locations", "countries", "bytes", "privateStateBytes", "cacheBytes", "durationMs", "sourceDurationMs"] as const;
const publicationCounterKeys = ["published", "unchanged", "failed", "omittedFailures"] as const;

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
  return summary;
}
