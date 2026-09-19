import { describe, expect, it, vi } from "vitest";
import { locations } from "@/lib/data";
import { CemsAdapter } from "@/lib/ingestion/adapters/cems";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

const now = new Date("2026-09-08T12:00:00Z");
const destination = locations.find(({ id }) => id === "at-vienna")!;
const next = "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=100&offset=100";
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
function activation(code: string, overrides: Record<string, unknown> = {}) {
  return { code, countries: ["Austria"], eventTime: "2026-09-08T09:00:00Z", activationTime: "2026-09-08T10:00:00Z", category: "Wildfire", lastUpdate: "2026-09-08T11:00:00Z", closed: false, centroid: "POINT (16 48)", ...overrides };
}
const unrelated = (count: number) => Array.from({ length: count }, (_, index) => activation(`OTHER${index}`, { countries: ["United States"] }));
function polygon(offset = 0) {
  const [lon, lat] = destination.centroid;
  return `POLYGON ((${lon - 0.1} ${lat - 0.1}, ${lon + 0.1 + offset} ${lat - 0.1}, ${lon + 0.1 + offset} ${lat + 0.1}, ${lon - 0.1} ${lat + 0.1}, ${lon - 0.1} ${lat - 0.1}))`;
}
const detail = (overrides: Record<string, unknown> = {}) => ({ extent: polygon(), category: "Wildfire", lastUpdate: "2026-09-08T11:00:00Z", eventTime: "2026-09-08T09:00:00Z", countries: [{ name: "Austria" }], ...overrides });

async function run(results: unknown[] | unknown[][], metadata: Record<string, unknown> = {}, details: Record<string, unknown[]> = {}, checkedAt = now) {
  const pages = Array.isArray(results[0]) ? results as unknown[][] : [results as unknown[]];
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  const requested: URL[] = [];
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input)); requested.push(url);
    if (url.pathname.endsWith("/public-activations-info/")) {
      const page = Number(url.searchParams.get("offset")) / 100;
      const rows = pages[page] || [];
      const generatedNext = page < pages.length - 1
        ? `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=100&offset=${(page + 1) * 100}` : null;
      return Response.json({ results: rows, ...(pages.length > 1 ? { count: total } : {}), ...(page === 0 ? metadata : {}),
        next: generatedNext ?? (page === 0 ? metadata.next : null) });
    }
    return Response.json({ results: details[url.searchParams.get("code")!] || [] });
  });
  const result = await new CemsAdapter().fetch({ now: checkedAt, locations: [destination], fetch: fetchMock });
  const lists = requested.filter(({ pathname }) => pathname.endsWith("/public-activations-info/"));
  expect(lists[0].searchParams.get("limit")).toBe("100");
  expect(lists[0].searchParams.get("offset")).toBe("0");
  return { result, requested };
}

describe("CEMS bounded list completeness", () => {
  it.each([99, 100])("accepts %i rows when the advertised list is complete", async (count) => {
    const { result, requested } = await run(unrelated(count), { count, next: null });
    expect(result.status).toBe("ok");
    expect(result.events).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it("paginates and applies a closure beyond the first 100 rows", async () => {
    const { result, requested } = await run([unrelated(100), [activation("BEYOND", { closed: true })]]);
    expect(result.removedEventPrefixes).toContain("cems:BEYOND");
    expect(result.status).toBe("ok");
    expect(requested.filter(({ pathname }) => pathname.endsWith("/public-activations-info/"))).toHaveLength(2);
    expect(requested.some((url) => url.href === next)).toBe(true);
  });

  it("stops after five pages and reports a larger provider list as partial", async () => {
    const pages = Array.from({ length: 6 }, (_, page) => unrelated(100).map((item, index) => ({
      ...item, code: `OTHER-${page}-${index}`,
    })));
    const { result, requested } = await run(pages);
    expect(result).toMatchObject({ status: "partial", events: [] });
    expect(requested.filter(({ pathname }) => pathname.endsWith("/public-activations-info/"))).toHaveLength(5);
  });

  it("deduplicates activation codes by newest update before fetching one detail", async () => {
    const older = activation("DUPLICATE", { lastUpdate: "2026-09-08T10:00:00Z" });
    const newer = activation("DUPLICATE", { lastUpdate: "2026-09-08T11:30:00Z" });
    const { result, requested } = await run([[older, ...unrelated(99)], [newer]], {}, { DUPLICATE: [detail({ lastUpdate: newer.lastUpdate })] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "cems:DUPLICATE", sourceUpdatedAt: "2026-09-08T11:30:00.000Z" });
    expect(requested.filter((url) => url.pathname.endsWith("/public-activations/")
      && url.searchParams.get("code") === "DUPLICATE")).toHaveLength(1);
  });

  it("caps detail work at the newest 100 supported activations", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => activation(`SUPPORTED-${String(index).padStart(3, "0")}`, {
      lastUpdate: new Date(now.getTime() - index * 1000).toISOString(),
    }));
    const details = Object.fromEntries(rows.map(({ code, lastUpdate }) => [code, [detail({ lastUpdate })]]));
    const { result, requested } = await run([rows.slice(0, 100), rows.slice(100)], {}, details);
    expect(result.status).toBe("partial");
    expect(result.error).toMatch(/detail limit/);
    expect(requested.filter(({ pathname }) => pathname.endsWith("/public-activations/"))).toHaveLength(100);
    expect(result.events).toHaveLength(100);
  });

  it.each([{ next }, { count: 2, next: null }, { next: "https://untrusted.example/next" }])("does not grant completeness to a short page with %j", async (metadata) => {
    const { result, requested } = await run(unrelated(1), metadata);
    expect(result.status).toBe("partial");
    expect(result.error).toBeTruthy();
    expect(requested).toHaveLength(metadata.next === next ? 2 : 1);
  });

  it.each([
    "https://user:password@rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=100&offset=100",
    "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=100&offset=100#page",
  ])("rejects credentials and fragments in a pagination link", async (nextUrl) => {
    const { result, requested } = await run(unrelated(1), { count: 2, next: nextUrl });
    expect(result).toMatchObject({ status: "partial", error: expect.stringContaining("incomplete") });
    expect(requested).toHaveLength(1);
  });

  it("does not follow list redirects outside the reviewed endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).origin).toBe("https://rapidmapping.emergency.copernicus.eu");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    });
    const result = await new CemsAdapter().fetch({ now, locations: [destination], fetch: fetchMock });
    expect(result).toMatchObject({ status: "failed", events: [], error: expect.stringContaining("redirect") });
  });

  it("does not follow detail redirects outside the reviewed endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://rapidmapping.emergency.copernicus.eu");
      expect(init?.redirect).toBe("manual");
      if (url.pathname.endsWith("/public-activations-info/")) {
        return Response.json({ count: 1, next: null, results: [activation("REDIRECT")] });
      }
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    });
    const result = await new CemsAdapter().fetch({ now, locations: [destination], fetch: fetchMock });
    expect(result).toMatchObject({ status: "failed", events: [] });
  });

  it("preserves metadata-free under-cap response compatibility", async () => {
    expect((await run(unrelated(99))).result.status).toBe("ok");
    expect((await run([])).result.status).toBe("ok");
    expect((await run(unrelated(100))).result.status).toBe("partial");
  });

  it.each([{ count: "1" }, { count: -1 }, { count: 1.5 }, { count: 0 }, { next: 42 }, { next: false }])("treats invalid completeness metadata conservatively: %j", async (metadata) => {
    const { result } = await run(unrelated(1), metadata);
    expect(result.status).toBe("partial");
    expect(result.error).toBeTruthy();
  });

  it("retains omitted evidence unchanged across capped polling and replay, then clears on complete recovery", async () => {
    const initial = (await run([activation("PRIOR")], {}, { PRIOR: [detail()] })).result;
    let state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(1);
    const prior = structuredClone(state.events[0]);
    for (const minute of [1, 2]) {
      const { result } = await run(unrelated(100), { count: 101, next }, {}, at(minute));
      state = mergeSourceResults(state, [result], at(minute));
      expect(state.events).toEqual([prior]);
    }
    const complete = (await run(unrelated(99), { count: 99, next: null }, {}, at(3))).result;
    expect(complete.status).toBe("ok");
    expect(mergeSourceResults(state, [complete], at(3)).events).toEqual([]);
  });

  it("expires retained evidence at its original expiry despite capped polling", async () => {
    const initial = (await run([activation("PRIOR")], {}, { PRIOR: [detail()] })).result;
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(1);
    const expiry = new Date(state.events[0].expiresAt);
    const before = new Date(expiry.getTime() - 1);
    const retained = mergeSourceResults(state, [(await run(unrelated(100), { next }, {}, before)).result], before);
    expect(retained.events).toEqual(state.events);
    expect(mergeSourceResults(retained, [(await run(unrelated(100), { next }, {}, expiry)).result], expiry).events).toEqual([]);
  });

  it("applies an explicit closure from a partial page only to that activation", async () => {
    const initial = (await run([activation("OWNED"), activation("OWNED-OTHER")], {}, { OWNED: [detail()], "OWNED-OTHER": [detail()] })).result;
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(2);
    const closed = (await run([activation("OWNED", { closed: true })], { count: 2, next }, {}, at(1))).result;
    expect(closed.status).toBe("partial");
    expect(mergeSourceResults(state, [closed], at(1)).events).toEqual(state.events.filter(({ id }) => id === "cems:OWNED-OTHER"));
  });

  it("refreshes an AOI once on a partial page while preserving a failed sibling", async () => {
    const rows = [activation("REFRESH"), activation("FAILED")];
    const initial = (await run(rows, {}, { REFRESH: [detail({ aois: [{ name: "Old area", extent: polygon() }] })], FAILED: [detail()] })).result;
    const state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(2);
    const updated = (await run(rows, { next }, { REFRESH: [detail({ lastUpdate: "2026-09-08T12:00:00Z", aois: [{ name: "Updated area", extent: polygon(0.1) }] })] }, at(1))).result;
    expect(updated.status).toBe("partial");
    const merged = mergeSourceResults(state, [updated], at(1));
    expect(merged.events).toHaveLength(2);
    expect(merged.events.filter(({ id }) => id === "cems:REFRESH:aoi-1")).toEqual(updated.events);
    expect(merged.events.find(({ id }) => id === "cems:FAILED")).toEqual(state.events.find(({ id }) => id === "cems:FAILED"));
    expect(updated.events[0].geometry).not.toEqual(state.events.find(({ id }) => id === "cems:REFRESH:aoi-1")!.geometry);
  });

  it("withdraws newly sensitive activation evidence on a partial page without clearing unrelated evidence or resurrecting on replay", async () => {
    const initial = (await run([activation("PRIVATE"), activation("PRIVATE-OTHER")], {}, {
      PRIVATE: [detail({ aois: [{ name: "First area", extent: polygon() }, { name: "Second area", extent: polygon(0.1) }] })],
      "PRIVATE-OTHER": [detail()],
    })).result;
    let state = mergeSourceResults(createEmptyState(now), [initial], now);
    expect(state.events).toHaveLength(3);
    const unrelatedEvent = structuredClone(state.events.find(({ id }) => id === "cems:PRIVATE-OTHER")!);
    for (const minute of [1, 2]) {
      const withheld = (await run([activation("PRIVATE")], { count: 2, next }, {
        PRIVATE: [{ sensitive: true }],
      }, at(minute))).result;
      expect(withheld).toMatchObject({ status: "partial", events: [], removedEventPrefixes: ["cems:PRIVATE"] });
      state = mergeSourceResults(state, [withheld], at(minute));
      expect(state.events).toEqual([unrelatedEvent]);
    }
    const omitted = (await run(unrelated(100), { next }, {}, at(3))).result;
    expect(mergeSourceResults(state, [omitted], at(3)).events).toEqual([unrelatedEvent]);
  });

  it("reports incomplete-list detail failures as partial rather than clearing evidence", async () => {
    const { result, requested } = await run([activation("MISSING")], { next, count: 2 });
    expect(result).toMatchObject({ status: "partial", events: [] });
    expect(requested).toHaveLength(3);
  });
});
