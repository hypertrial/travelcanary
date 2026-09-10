import { describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import weatherFixture from "../fixtures/conditions/forecast.json";
import airFixture from "../fixtures/conditions/air.json";
import marineFixture from "../fixtures/conditions/marine.json";

// Exercise the real catalog3 scheduler; this does not enable runtime publication.
import { catalogLocationsV3 as locations } from "@/lib/catalog-data";
import { conditionSources } from "@/lib/conditions/sources";
import { marineConditionEligible } from "@/lib/conditions/marine";
import { createEmptyState } from "@/lib/risk";
import { emptyConditions } from "@/lib/domain/conditions";
import { forecastBatches } from "@/lib/conditions/worker";
import { forecastProducts, parseOpenMeteo, type ForecastKind } from "@/lib/conditions/forecast";
import { availableForecastWeight, fitConditionsState } from "@/lib/conditions/state";

const hour = 3_600_000;
const enabled = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true" };
const start = new Date("2026-09-08T00:27:00Z");
const records = {
  weather: parseOpenMeteo(weatherFixture, "weather", new Date("2026-08-31T17:45:00Z")),
  airQuality: parseOpenMeteo(airFixture, "airQuality", new Date("2026-08-31T17:45:00Z")),
  marine: parseOpenMeteo(marineFixture, "marine", new Date("2026-08-31T18:58:55.507Z")),
};

async function simulate(failedHours = new Set<number>(), existingReservation = 0, fitCache = false) {
  const state = createEmptyState(start);
  state.collection = { catalogVersion: 3, revision: 1 };
  if (existingReservation) state.conditions.reservations.push({ at: start.toISOString(), weight: existingReservation });
  const success = new Map<string, number[]>();
  const hourlyWeights: number[] = [];
  let peakDay = 0;
  let missingAfterWarmup = 0;
  const keys = expectedKeys();
  for (let tick = 0; tick < 7 * 24; tick += 1) {
    if (tick % 8 === 0) await setImmediate();
    const now = new Date(start.getTime() + tick * hour);
    state.conditions.reservations = state.conditions.reservations.filter((item) => Date.parse(item.at) > now.getTime() - 24 * hour);
    const batches = forecastBatches(state, now, enabled);
    const weight = batches.reduce((total, batch) => total + batch.ids.length, 0);
    expect(weight).toBeLessThanOrEqual(availableForecastWeight(state, now));
    expect(weight).toBeLessThanOrEqual(400);
    hourlyWeights.push(weight);
    if (weight) state.conditions.reservations.push({ at: new Date(now.getTime() + 45_000).toISOString(), weight });
    peakDay = Math.max(peakDay, state.conditions.reservations.reduce((total, item) => total + item.weight, 0));
    expect(peakDay).toBeLessThanOrEqual(8_000);
    for (const batch of batches) {
      expect(batch.ids.length).toBeLessThanOrEqual(40);
      for (const id of batch.ids) {
        const key = `${batch.kind}:${id}`;
        if (failedHours.has(tick)) {
          // Failure consumes its reservation and releaseLease removes the attempt.
          delete state.conditions.attempts[key];
          continue;
        }
        state.conditions.attempts[key] = now.toISOString();
        const entry = state.conditions.locations[id] ||= emptyConditions();
        const record = { ...records[batch.kind], checkedAt: now.toISOString(), startAt: now.toISOString(), expiresAt: new Date(now.getTime() + forecastProducts[batch.kind].expiryHours * hour).toISOString() };
        // Assignment preserves each product's parsed shape; the scheduler reads metadata.
        Object.assign(entry, { [batch.kind]: record });
        success.set(key, [...success.get(key) || [], tick]);
      }
    }
    if (fitCache) {
      fitConditionsState(state, now);
      expect(Buffer.byteLength(JSON.stringify(state.conditions.locations))).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(5_000_000);
    }
    if (tick >= 8) {
      missingAfterWarmup = Math.max(missingAfterWarmup, keys.filter((key) => {
        const [kind, id] = key.split(":");
        const record = state.conditions.locations[id]?.[kind as ForecastKind];
        return !record || Date.parse(record.expiresAt) <= now.getTime();
      }).length);
    }
  }
  return { success, hourlyWeights, peakDay, state, missingAfterWarmup };
}

function expectedKeys() {
  return locations.flatMap(({ id }) => (["weather", "airQuality", ...(marineConditionEligible(id, 3) ? ["marine"] : [])] as ForecastKind[]).map((kind) => `${kind}:${id}`));
}

describe("reviewed full-catalog scheduler capacity", () => {
  it("bounds recovery bursts across the minute and hour windows", () => {
    const state = createEmptyState(start);
    state.collection = { catalogVersion: 3, revision: 1 };
    for (let run = 0; run < 5; run += 1) {
      const now = new Date(start.getTime() + run * 2 * 60_000);
      const weight = forecastBatches(state, now, enabled).reduce((total, batch) => total + batch.ids.length, 0);
      expect(weight).toBe(400);
      state.conditions.reservations.push({ at: new Date(now.getTime() + 45_000).toISOString(), weight });
      expect(forecastBatches(state, new Date(now.getTime() + 60_000), enabled)).toEqual([]);
    }
    expect(forecastBatches(state, new Date(start.getTime() + 10 * 60_000), enabled)).toEqual([]);
    expect(availableForecastWeight(state, new Date(start.getTime() + hour + 44_999))).toBe(0);
    expect(availableForecastWeight(state, new Date(start.getTime() + hour + 45_000))).toBe(400);
  });

  it.each([[60_000, 400], [hour, 2_000], [24 * hour, 8_000]])("expires a %i-ms reservation exactly at its window boundary", (window, limit) => {
    const state = createEmptyState(start);
    state.collection = { catalogVersion: 3, revision: 1 };
    const reservedAt = start.getTime() + 45_000;
    state.conditions.reservations.push({ at: new Date(reservedAt).toISOString(), weight: limit });
    expect(availableForecastWeight(state, new Date(reservedAt + window - 1))).toBe(0);
    expect(availableForecastWeight(state, new Date(reservedAt + window))).toBe(400);
  });

  it("stages a cold start and sustains seven days without starving any country or forecast product", async () => {
    const result = await simulate(new Set(), 0, true);
    expect(locations).toHaveLength(679);
    expect(new Set(locations.map(({ countryCode }) => countryCode)).size).toBe(45);
    expect(expectedKeys().filter((key) => key.startsWith("marine:"))).toHaveLength(161);
    expect(forecastProducts.weather).toMatchObject({ hours: 5, expiryHours: 6 });
    expect(forecastProducts.airQuality).toMatchObject({ hours: 8, expiryHours: 12 });
    expect(forecastProducts.marine).toMatchObject({ hours: 8, expiryHours: 12 });
    for (const product of Object.values(forecastProducts)) expect(conditionSources[product.sourceId].cadenceHours).toBe(product.hours);
    console.info("Reviewed catalog3 capacity", {
      marineDestinations: 161,
      peakRollingDayWeight: result.peakDay,
      maxColdStartHours: Math.max(...[...result.success.values()].map((ticks) => ticks[0])),
      maxRefreshGapHours: Object.fromEntries((["weather", "airQuality", "marine"] as const).map((kind) => [kind,
        Math.max(...[...result.success].filter(([key]) => key.startsWith(`${kind}:`)).flatMap(([, ticks]) => ticks.slice(1).map((tick, index) => tick - ticks[index])))])),
      missingAfterWarmup: result.missingAfterWarmup,
    });
    expect([...result.success.keys()].sort()).toEqual(expectedKeys().sort());
    for (const [key, ticks] of result.success) {
      expect(ticks[0], `${key} cold start`).toBeLessThanOrEqual(8);
      const expiry = key.startsWith("weather:") ? 6 : 12;
      expect(Math.max(...ticks.slice(1).map((tick, index) => tick - ticks[index])), key).toBeLessThanOrEqual(expiry);
      expect(167 - ticks.at(-1)!, `${key} final freshness`).toBeLessThan(expiry);
    }
    // Reservations live through the 45-second source phase. At an hourly boundary
    // that includes an extra run compared with the plan's simple daily estimate.
    expect(result.peakDay).toBeLessThanOrEqual(8_000);
    expect(result.missingAfterWarmup).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(result.state.conditions.locations))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.state))).toBeLessThanOrEqual(5_000_000);
  }, 60_000);

  it("retains failed-request quota and reschedules all products after a three-hour outage", async () => {
    const result = await simulate(new Set([30, 31, 32]));
    expect([...result.success.keys()].sort()).toEqual(expectedKeys().sort());
    for (const [key, ticks] of result.success) {
      expect(ticks.some((tick) => tick > 32 && tick <= 44), key).toBe(true);
      expect(ticks.some((tick) => tick >= 156), key).toBe(true);
    }
    expect(result.peakDay).toBeLessThanOrEqual(8_000);
  }, 30_000);

  it("honors an exhausted rolling-day reservation before a bounded restart", async () => {
    const result = await simulate(new Set(), 8_000);
    expect(result.hourlyWeights.slice(0, 24)).toEqual(Array(24).fill(0));
    expect(result.hourlyWeights[24]).toBeGreaterThan(0);
    expect([...result.success.keys()].sort()).toEqual(expectedKeys().sort());
    for (const ticks of result.success.values()) expect(ticks.some((tick) => tick >= 156)).toBe(true);
  }, 30_000);
});
