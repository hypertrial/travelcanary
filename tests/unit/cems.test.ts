import { afterEach, describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { CemsAdapter } from "@/lib/ingestion/adapters/cems";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

const now = new Date("2026-08-25T12:00:00Z");
const destination = locations.find((location) => location.countryCode === "AT")!;

function activation(overrides: Record<string, unknown> = {}) {
  return {
    code: "EMSR001", countries: ["Austria"], eventTime: "2026-08-25T09:00:00Z", activationTime: "2026-08-25T10:00:00Z",
    category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z", closed: false, centroid: "POINT (0 0)", ...overrides,
  };
}

function wktAround([longitude, latitude]: [number, number]) {
  return `POLYGON ((${longitude - 0.2} ${latitude - 0.2}, ${longitude + 0.2} ${latitude - 0.2}, ${longitude + 0.2} ${latitude + 0.2}, ${longitude - 0.2} ${latitude + 0.2}, ${longitude - 0.2} ${latitude - 0.2}))`;
}

function mockFetch(results: unknown[], detail: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    return new Response(JSON.stringify(url.includes("public-activations-info") ? { results } : { results: [detail] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("Copernicus EMS adapter", () => {
  afterEach(() => vi.useRealTimers());

  it.each([true, false])("clears a detail-level closure independently of sibling failure (%s)", async (siblingFails) => {
    const adapter = new CemsAdapter();
    const list = [activation(), activation({ code: "EMSR002" })];
    const detail = { extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z", eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }] };
    const initial = await adapter.fetch({ now, locations: [destination], fetch: mockFetch(list, detail) });
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(2);
    const at = new Date(now.getTime() + 10 * 60_000);
    const result = await adapter.fetch({ now: at, locations: [destination], fetch: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("public-activations-info")) return Response.json({ results: list });
      const closed = url.searchParams.get("code") === "EMSR001";
      return Response.json({ results: !closed && siblingFails ? [] : [{ ...detail, closed }] });
    }) as typeof fetch });
    expect(result.status).toBe(siblingFails ? "partial" : "ok");
    expect(result.removedEventPrefixes).toContain("cems:EMSR001");
    expect(mergeSourceResults(state, [result], at).events.map(({ id }) => id)).toEqual(["cems:EMSR002"]);
  });

  it.each(["2030-01-01T00:00:00Z", "invalid"])("retains evidence when a detail closure has an invalid update time (%s)", async (lastUpdate) => {
    const adapter = new CemsAdapter();
    const detail = { extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z", eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }] };
    const initial = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], detail) });
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(1);
    const result = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], { ...detail, closed: true, lastUpdate }) });
    expect(result.status).toBe("failed");
    expect(result.removedEventPrefixes || []).toEqual([]);
    expect(mergeSourceResults(state, [result], now).events).toEqual(state.events);
  });

  it("fails closed when the activation list is malformed", async () => {
    const result = await new CemsAdapter().fetch({
      now, locations: [destination], fetch: (async () => Response.json({})) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it("fails when a listed activation has no detail result", async () => {
    const result = await new CemsAdapter().fetch({
      now,
      locations: [destination],
      fetch: (async (input: string | URL | Request) => Response.json(
        String(input).includes("public-activations-info") ? { results: [activation()] } : { results: [] },
      )) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it("fails when a listed activation has no parseable geometry", async () => {
    const result = await new CemsAdapter().fetch({
      now, locations: [destination],
      fetch: mockFetch([activation()], {
        extent: "not-a-polygon", category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
        eventTime: "2026-08-25T09:00:00Z",
      }),
    });

    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it("keeps only current, open, supported activations affecting the catalog", async () => {
    const adapter = new CemsAdapter();
    const detail = {
      extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
      eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }], reportLink: "https://example.com/activation",
    };
    const result = await adapter.fetch({
      now, locations: [destination],
      fetch: mockFetch([
        activation(),
        activation({ code: "OLD", lastUpdate: "2026-08-23T11:00:00Z" }),
        activation({ code: "CLOSED", closed: true }),
        activation({ code: "OTHER", category: "Preparedness exercise" }),
      ], detail),
    });
    expect(result.status).toBe("ok");
    expect(result.removedEventPrefixes).toEqual(["cems:CLOSED", "cems:EMSR001"]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "cems:EMSR001", level: "ELEVATED", type: "wildfire" });
  });

  it.each(["Volcanic activity", "Earthquake", "Severe weather"])("ignores unsupported %s activations", async (category) => {
    const result = await new CemsAdapter().fetch({
      now, locations: [destination],
      fetch: mockFetch([activation({ category })], {
        extent: wktAround(destination.centroid), category, lastUpdate: "2026-08-25T11:00:00Z",
        eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
      }),
    });

    expect(result).toMatchObject({ status: "ok", events: [] });
  });

  it("drops sensitive and out-of-area activation details", async () => {
    const adapter = new CemsAdapter();
    const sensitive = await adapter.fetch({
      now, locations: [destination],
      fetch: mockFetch([activation()], { sensitive: true, extent: wktAround(destination.centroid), category: "Wildfire" }),
    });
    expect(sensitive.events).toHaveLength(0);

    const distant = await adapter.fetch({
      now, locations: [destination],
      fetch: mockFetch([activation()], { extent: wktAround([0, 0]), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z", eventTime: "2026-08-25T09:00:00Z" }),
    });
    expect(distant.events).toHaveLength(0);
  });

  it("matches every AOI instead of the broad activation extent", async () => {
    const adapter = new CemsAdapter();
    const result = await adapter.fetch({
      now, locations: [destination],
      fetch: mockFetch([activation()], {
        extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
        eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
        aois: [{ name: "Distant", extent: wktAround([0, 0]) }],
      }),
    });
    expect(result.events).toHaveLength(0);
  });

  it("retains a matching AOI even when it is not first", async () => {
    const adapter = new CemsAdapter();
    const result = await adapter.fetch({
      now, locations: [destination],
      fetch: mockFetch([activation()], {
        extent: wktAround([0, 0]), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
        eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
        aois: [{ name: "Distant", extent: wktAround([0, 0]) }, { name: "Destination", extent: wktAround(destination.centroid) }],
      }),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "cems:EMSR001:aoi-2", affectedArea: "Destination, Austria" });
  });

  it("keeps valid activations when a sibling detail request fails", async () => {
    const detail = {
      extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
      eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
    };
    const result = await new CemsAdapter().fetch({
      now, locations: [destination],
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("public-activations-info")) return Response.json({ results: [activation({ code: "BROKEN" }), activation({ code: "GOOD" })] });
        return new URL(url).searchParams.get("code") === "BROKEN"
          ? new Response("unavailable", { status: 503 })
          : Response.json({ results: [detail] });
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ status: "partial", error: "1 of 2 activation details unavailable" });
    expect(result.events.map((event) => event.id)).toEqual(["cems:GOOD"]);
  });

  it("keeps valid activations when a sibling detail has inconsistent dates", async () => {
    const result = await new CemsAdapter().fetch({
      now, locations: [destination],
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("public-activations-info")) return Response.json({ results: [activation({ code: "BROKEN" }), activation({ code: "GOOD" })] });
        const code = new URL(url).searchParams.get("code");
        return Response.json({ results: [{
          extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
          eventTime: code === "BROKEN" ? "2030-01-01T00:00:00Z" : "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
        }] });
      }) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "partial", error: "1 of 2 activation details unavailable" });
    expect(result.events.map((event) => event.id)).toEqual(["cems:GOOD"]);
  });

  it("keeps valid activations when a sibling list record is malformed", async () => {
    const result = await new CemsAdapter().fetch({
      now, locations: [destination],
      fetch: mockFetch([activation({ code: "GOOD" }), { code: "BROKEN" }], {
        extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
        eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
      }),
    });

    expect(result).toMatchObject({ status: "partial", error: "1 activation list records invalid" });
    expect(result.events.map((event) => event.id)).toEqual(["cems:GOOD"]);
  });

  it("rejects implausibly future activation updates", async () => {
    const future = "2030-01-01T00:00:00Z";
    const listFuture = await new CemsAdapter().fetch({
      now, locations: [destination], fetch: mockFetch([activation({ lastUpdate: future })], {}),
    });
    const detailFuture = await new CemsAdapter().fetch({
      now, locations: [destination], fetch: mockFetch([activation()], {
        extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: future,
        eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
      }),
    });

    expect(listFuture).toMatchObject({ status: "failed", events: [] });
    expect(detailFuture).toMatchObject({ status: "failed", events: [] });
  });

  it("finishes bounded fanout before the 60-second route limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const many = Array.from({ length: 100 }, (_, index) => activation({ code: `EMSR${index}` }));
    let detailCalls = 0;
    const run = new CemsAdapter().fetch({
      now, locations: [destination],
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("public-activations-info")) return Response.json({ results: many });
        detailCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 4_900));
        return Response.json({ results: [{
          extent: wktAround(destination.centroid), category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z",
          eventTime: "2026-08-25T09:00:00Z", countries: [{ name: "Austria" }],
        }] });
      }) as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    expect(result.status).toBe("partial");
    expect(detailCalls).toBeGreaterThan(0);
    expect(detailCalls).toBeLessThan(100);
  });
});


it("retains earlier AOI evidence when only a sibling geometry is parseable", async () => {
  const detail = { category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z", eventTime: "2026-08-25T09:00:00Z",
    aois: [{ name: "Distant", extent: wktAround([0, 0]) }, { name: "Destination", extent: wktAround(destination.centroid) }],
  };
  const adapter = new CemsAdapter();
  const initial = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], detail) });
  const state = mergeSourceResults(createEmptyState(now), [initial], now);
  expect(state.events).toHaveLength(1);
  const mixed = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], {
    ...detail, aois: [detail.aois[0], { ...detail.aois[1], extent: "not-a-polygon" }],
  }) });
  expect(mixed.status).toBe("partial");
  expect(mergeSourceResults(state, [mixed], now).events).toEqual(initial.events);
  const clear = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], { ...detail, aois: [detail.aois[0]] }) });
  expect(clear.status).toBe("ok");
  expect(mergeSourceResults(state, [clear], now).events).toEqual([]);
});

it("clears a successfully refreshed AOI during a partial geometry refresh", async () => {
  const adapter = new CemsAdapter();
  const detail = { category: "Wildfire", lastUpdate: "2026-08-25T11:00:00Z", eventTime: "2026-08-25T09:00:00Z",
    aois: [{ name: "First", extent: wktAround(destination.centroid) }, { name: "Second", extent: wktAround(destination.centroid) }],
  };
  const initial = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], detail) });
  const state = mergeSourceResults(createEmptyState(now), [initial], now);
  expect(state.events).toHaveLength(2);
  const partial = await adapter.fetch({ now, locations: [destination], fetch: mockFetch([activation()], {
    ...detail, aois: [{ ...detail.aois[0], extent: wktAround([0, 0]) }, { ...detail.aois[1], extent: "malformed" }],
  }) });
  expect(partial.status).toBe("partial");
  expect(mergeSourceResults(state, [partial], now).events).toEqual([initial.events[1]]);
});
