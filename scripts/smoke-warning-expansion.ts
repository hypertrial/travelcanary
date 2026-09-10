// Read-only, server-side smoke. Calls each new authority once, independently of
// primary availability, without storage credentials or publication side effects.
import { locations } from "../src/lib/data";
import { NormalizedEventSchema } from "../src/lib/domain/schemas";
import { fetchDirectWeatherCaps } from "../src/lib/ingestion/adapters/direct-weather-cap";
import { fetchLvPartition } from "../src/lib/ingestion/adapters/national-civil-alerts-lv";
import { createSourceDiagnostics } from "../src/lib/ingestion/types";
import { withFetchDiagnostics } from "../src/lib/ingestion/fetch";
import { buildSnapshot, createEmptyState } from "../src/lib/risk";

const now = new Date();
const state = createEmptyState(now);
const beforeBytes = Buffer.byteLength(JSON.stringify(buildSnapshot(state, now)));
for (const country of ["LV", "ES", "HR"] as const) {
  const diagnostics = createSourceDiagnostics();
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const context = { now, locations, diagnostics, deadlineAt: Date.now() + 8_000,
      fetch: ((input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })) as typeof fetch };
    const result = await withFetchDiagnostics(diagnostics, async () => country === "LV" ? await fetchLvPartition(context) : await fetchDirectWeatherCaps(country, context));
    result.events.forEach((event) => NormalizedEventSchema.parse(event));
    state.events.push(...result.events);
    const status = "status" in result ? result.status : "ok";
    console.log(JSON.stringify({ country, status, events: result.events.length, updatedAt: result.sourceUpdatedAt,
      durationMs: Math.round(performance.now() - started), ...diagnostics }));
    if (status !== "ok") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ country, status: "failed", error: String(error).slice(0, 300), durationMs: Math.round(performance.now() - started), ...diagnostics }));
    process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
const afterBytes = Buffer.byteLength(JSON.stringify(buildSnapshot(state, now)));
console.log(JSON.stringify({ snapshotV10: { beforeBytes, afterBytes, addedBytes: afterBytes - beforeBytes, warning: afterBytes > 300_000, hardLimitBytes: 500_000 },
  note: "Isolated event projection against an empty local state; not a production snapshot or incident-detection rate." }));
if (afterBytes > 500_000) process.exitCode = 1;
