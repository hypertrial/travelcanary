import { describe, expect, it, vi } from "vitest";
import { CollectionChangedError, parseCatalogState, type IngestionStateV14 } from "@/lib/domain/catalog-state";
import { conditionSourceIds } from "@/lib/domain/conditions";
import { createEmptyState } from "@/lib/risk";
import { runConditions } from "@/lib/conditions/worker";
import { ConcurrencyError, MemoryStateStore, type Versioned } from "@/lib/storage";
import forecast from "../fixtures/conditions/forecast.json";

const now = new Date("2026-08-31T17:45:00Z");
const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "open-meteo-weather").join(",") };
const initial = () => parseCatalogState(createEmptyState(now));
function response(input: RequestInfo | URL) {
  const url = new URL(String(input));
  const latitude = url.searchParams.get("latitude")!.split(",").map(Number);
  const longitude = url.searchParams.get("longitude")!.split(",").map(Number);
  return Response.json(latitude.map((lat, index) => ({ ...structuredClone(forecast), latitude: lat, longitude: longitude[index] })));
}

describe("conditions collection fences", () => {
  it("rejects catalog3 before reserving work or fetching/publishing", async () => {
    const state = initial(); state.collection.catalogVersion = 3;
    const store = new MemoryStateStore(state); const write = vi.spyOn(store, "write"); const fetchMock = vi.fn<typeof fetch>(); const publish = vi.fn();
    await expect(runConditions({ stateStore: store, now, env, fetch: fetchMock, publish })).rejects.toBeInstanceOf(CollectionChangedError);
    expect(write).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect((await store.read()).data).toEqual(state);
  });

  it("rechecks revision after a reservation CAS conflict before issuing or charging requests", async () => {
    class ReservationRaceStore extends MemoryStateStore {
      override async write(): Promise<{ etag: string }> {
        const concurrent = await super.read(); concurrent.data.collection.revision = 1;
        await super.write(concurrent.data, concurrent);
        throw new ConcurrencyError("reservation lost to control update");
      }
    }
    const store = new ReservationRaceStore(initial()); const fetchMock = vi.fn<typeof fetch>(); const publish = vi.fn();
    await expect(runConditions({ stateStore: store, now, env, fetch: fetchMock, publish })).rejects.toBeInstanceOf(CollectionChangedError);
    const final = (await store.read()).data;
    expect(final.conditions.reservations).toEqual([]); expect(final.conditions.attempts).toEqual({}); expect(final.conditions.lease).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });

  it.each(["successful responses", "failed batch", "foreign lease"] as const)("discards %s after a revision change without refunding quota or clearing newer ownership", async (mode) => {
    const store = new MemoryStateStore(initial()); const publish = vi.fn();
    let changed = false; let concurrent: IngestionStateV14 | undefined; let newerMarker = "";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (!changed) {
        changed = true;
        const latest = await store.read(); latest.data.collection.revision = 1;
        newerMarker = Object.keys(latest.data.conditions.attempts)[0];
        latest.data.conditions.attempts[newerMarker] = "2026-08-31T17:46:00Z";
        latest.data.conditions.cacheUntil.concurrent = "2026-08-31T20:00:00Z";
        latest.data.conditions.cooldownUntil = "2026-08-31T20:00:00Z";
        latest.data.conditions.reservations.push({ at: now.toISOString(), weight: 25 });
        if (mode === "foreign lease") latest.data.conditions.lease = { id: "123e4567-e89b-42d3-a456-426614174000", expiresAt: "2026-08-31T17:48:00Z" };
        concurrent = structuredClone(latest.data); await store.write(latest.data, latest);
        if (mode === "failed batch") return new Response("upstream unavailable", { status: 503 });
      }
      return response(input);
    });
    await expect(runConditions({ stateStore: store, now, env, fetch: fetchMock, publish })).rejects.toBeInstanceOf(CollectionChangedError);
    const final = (await store.read()).data;
    expect(final.conditions.reservations).toEqual(concurrent!.conditions.reservations);
    expect(final.conditions.reservations.reduce((sum, item) => sum + item.weight, 0)).toBe(225);
    expect(final.conditions.locations).toEqual(concurrent!.conditions.locations);
    expect(final.conditions.health).toEqual(concurrent!.conditions.health);
    expect(final.conditions.cooldownUntil).toBe(concurrent!.conditions.cooldownUntil);
    expect(final.conditions.cacheUntil).toEqual(concurrent!.conditions.cacheUntil);
    expect(final.conditions.attempts[newerMarker]).toBe("2026-08-31T17:46:00Z");
    expect(final.collection.revision).toBe(1); expect(publish).not.toHaveBeenCalled();
    if (mode === "foreign lease") expect(final.conditions).toEqual(concurrent!.conditions);
    else {
      expect(final.conditions.lease).toBeNull();
      expect(final.conditions.attempts).toEqual({ [newerMarker]: "2026-08-31T17:46:00Z" });
    }
    // Only the five initially reserved40-point weather batches, never a split retry.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).searchParams.get("latitude")!.split(",").length === 40)).toBe(true);
  });

  it.each([null, "2026-08-31T22:00:00Z"])("drains an active sibling's 429 after split cancellation and preserves the longer cooldown %s", async (concurrentCooldown) => {
    const requests: Array<(value: Response) => void> = [];
    let signalControlRead!: () => void;
    const controlRead = new Promise<void>((resolve) => { signalControlRead = resolve; });
    class ObservedStore extends MemoryStateStore {
      override async read() {
        const value = await super.read();
        if (value.data.collection.revision === 1) signalControlRead();
        return value;
      }
    }
    const store = new ObservedStore(initial()); const publish = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { requests.push(resolve); }));
    let settled = false;
    const allForecasts = { ...env, CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => !["open-meteo-weather", "open-meteo-air", "open-meteo-marine"].includes(id)).join(",") };
    const running = runConditions({ stateStore: store, now, env: allForecasts, fetch: fetchMock, publish }).then(
      () => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    await vi.waitFor(() => expect(requests).toHaveLength(8));
    const latest = await store.read(); latest.data.collection.revision = 1;
    latest.data.conditions.cooldownUntil = concurrentCooldown;
    const lease = latest.data.conditions.lease;
    expect(Object.keys(latest.data.conditions.attempts)).toHaveLength(400);
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).searchParams.get("latitude")!.split(",").length === 40)).toBe(true);
    await store.write(latest.data, latest);
    requests[0](new Response("retryable upstream error", { status: 503 }));
    await controlRead;
    // Drain promise continuations, not a wall-clock delay: active HTTP siblings remain deliberately unresolved.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect((await store.read()).data.conditions.lease).toEqual(lease);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    requests[1](new Response("rate limited", { status: 429, headers: { "retry-after": "7200" } }));
    for (const resolve of requests.slice(2)) resolve(new Response("retryable sibling error", { status: 503 }));
    expect(await running).toBeInstanceOf(CollectionChangedError);
    const final = (await store.read()).data;
    expect(final.conditions.cooldownUntil).toBe(concurrentCooldown || "2026-08-31T19:45:00.000Z");
    expect(final.conditions.reservations.map(({ weight }) => weight)).toEqual([400]);
    expect(final.conditions.lease).toBeNull(); expect(final.conditions.attempts).toEqual({});
    expect(final.conditions.locations).toEqual({}); expect(final.conditions.health).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(8); expect(publish).not.toHaveBeenCalled();
  });

  it("discards forecast updates when control changes during the final merge CAS retry", async () => {
    class MergeRaceStore extends MemoryStateStore {
      writes = 0;
      override async write(state: IngestionStateV14, expected: Versioned<IngestionStateV14>): Promise<{ etag: string }> {
        this.writes += 1;
        if (this.writes === 2) {
          const latest = await super.read(); latest.data.collection.revision = 1; latest.data.fingerprints.concurrent = now.toISOString();
          await super.write(latest.data, latest); throw new ConcurrencyError("merge lost to control update");
        }
        return super.write(state, expected);
      }
    }
    const store = new MergeRaceStore(initial()); const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => response(input)); const publish = vi.fn();
    await expect(runConditions({ stateStore: store, now, env, fetch: fetchMock, publish })).rejects.toBeInstanceOf(CollectionChangedError);
    const final = (await store.read()).data;
    expect(final.collection.revision).toBe(1); expect(final.fingerprints.concurrent).toBe(now.toISOString());
    expect(final.conditions.locations).toEqual({}); expect(final.conditions.health).toEqual({});
    expect(final.conditions.reservations.map(({ weight }) => weight)).toEqual([200]);
    expect(final.conditions.attempts).toEqual({}); expect(final.conditions.lease).toBeNull(); expect(publish).not.toHaveBeenCalled();
  });
});
