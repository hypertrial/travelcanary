import { performance } from "node:perf_hooks";
import { locations } from "../src/lib/data";
import type { NormalizedEventV13 as NormalizedEvent } from "../src/lib/domain/catalog-state";
import { eventAffectsLocation } from "../src/lib/geospatial";
import { eventIsPublishable } from "../src/lib/hazard-lifecycle";
import { indexEventsByLocation } from "../src/lib/risk";

const now = new Date("2026-08-25T12:00:00.000Z");
const endsAt = "2026-08-25T18:00:00.000Z";

function events(count: number, kind: "locations" | "point"): NormalizedEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${kind}-${index}`, sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Benchmark earthquake", explanation: "Benchmark event for deterministic performance measurement.",
    action: "Follow local advice.", affectedArea: "Benchmark area",
    geometry: kind === "locations"
      ? { kind: "locations", ids: [locations[index % locations.length].id] }
      : { kind: "point", coordinates: locations[index % locations.length].centroid, radiusKm: 25 },
    startsAt: now.toISOString(), endsAt, sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(), expiresAt: endsAt,
    sourceName: "Benchmark source", sourceUrl: "https://example.com/benchmark", confidence: "HIGH",
  }));
}

function naiveIndex(sourceEvents: NormalizedEvent[]) {
  const indexed = new Map<string, NormalizedEvent[]>();
  for (const location of locations) {
    const matching = sourceEvents.filter((event) => eventIsPublishable(event, now) && eventAffectsLocation(event, location));
    if (matching.length) indexed.set(location.id, matching);
  }
  return indexed;
}

function signature(indexed: Map<string, NormalizedEvent[]>) {
  return JSON.stringify([...indexed]
    .map(([id, matching]) => [id, matching.map((event) => event.id)] as const)
    .sort(([a], [b]) => a.localeCompare(b)));
}

function median(samples: number[]) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

function measure(run: () => unknown, repetitions: number) {
  for (let index = 0; index < 2; index += 1) run();
  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

let locationSpeedup = 0;
for (const [count, kind, repetitions] of [
  [0, "locations", 20], [100, "locations", 15], [500, "locations", 10],
  [0, "point", 20], [100, "point", 8], [500, "point", 4],
] as const) {
  const sourceEvents = events(count, kind);
  const expected = naiveIndex(sourceEvents);
  const actual = indexEventsByLocation(sourceEvents, now);
  if (signature(actual) !== signature(expected)) throw new Error(`Indexed result differs for ${count} ${kind} events`);
  const naiveMs = measure(() => naiveIndex(sourceEvents), repetitions);
  const indexedMs = measure(() => indexEventsByLocation(sourceEvents, now), repetitions);
  const speedup = naiveMs / Math.max(indexedMs, 0.001);
  if (count === 500 && kind === "locations") locationSpeedup = speedup;
  console.log(JSON.stringify({ count, kind, repetitions, naiveMs: +naiveMs.toFixed(2), indexedMs: +indexedMs.toFixed(2), speedup: +speedup.toFixed(2) }));
}

if (locationSpeedup < 2) throw new Error(`Location-ID event indexing speedup was below 2x (${locationSpeedup.toFixed(2)}x)`);
