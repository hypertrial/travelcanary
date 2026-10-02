import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { CatalogPartitionedSourceResultSchema, IngestionStateV16Schema } from "@/lib/domain/catalog-state";
import { fetchLuPartition, parseLuCap } from "@/lib/ingestion/adapters/national-civil-alerts-lu";
import { NationalCivilAlertsAdapter } from "@/lib/ingestion/adapters/national-civil-alerts";
import { nationalWarningSources } from "@/lib/national-warning-sources";
import { createEmptyState, mergeSourceResults } from "@/lib/risk-state";
import { MemoryStateStore } from "@/lib/state-store";

const now = new Date("2026-08-28T04:30:00Z");
const xml = readFileSync("tests/fixtures/providers/lu-alert-cap.xml", "utf8");
const cancel = xml.replace("<identifier>LU-Alert.fixture.1</identifier>", "<identifier>cancel</identifier>")
  .replace("<msgType>Alert</msgType>", "<msgType>Cancel</msgType><references>sender,LU-Alert.fixture.1,2026-08-28T04:00:00Z</references>")
  .replace(/\s*<info>[\s\S]*<\/info>\s*<\/alert>/, "\n</alert>");

describe("persisted LU-Alert catch-up", () => {
  it.each(["country", "transport"])("restores still-active alerts after disabling and re-enabling the %s", async (scope) => {
    const otherTransports = [...new Set(Object.values(nationalWarningSources).flatMap(({ systems }) => systems.map(({ id }) => id)))].filter((id) => id !== "lu-alert");
    vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", otherTransports.join(","));
    try {
      const state = createEmptyState(now); state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
      const store = new MemoryStateStore(state);
      const resources = Array.from({ length: 101 }, (_, index) => ({ url: `https://download.data.public.lu/${String(index).padStart(3, "0")}.xml`,
        last_modified: "2026-08-28T03:00:00Z", format: "xml" }));
      for (let run = 0; run < 3; run += 1) {
        vi.stubEnv("NATIONAL_ALERTS_DISABLED_COUNTRIES", scope === "country" && run === 1 ? "LU" : "");
        vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", [...otherTransports, ...(scope === "transport" && run === 1 ? ["lu-alert"] : [])].join(","));
        const read = await store.read(); const at = new Date(now.getTime() + run * 3_600_000);
        const result = await new NationalCivilAlertsAdapter().fetch({ state: read.data, locations: catalogLocationsV3, now: at,
          fetch: (async (input) => String(input).includes("api/1/datasets")
            ? Response.json({ last_update: "2026-08-28T04:00:00Z", resources })
            : new Response(String(input) === resources[0].url ? xml : xml.replace("<status>Actual</status>", "<status>Test</status>"))) as typeof fetch });
        await store.write(mergeSourceResults(read.data, [result], at), read);
        const latest = (await store.read()).data;
        expect(latest.events.filter(({ id }) => id.startsWith("lu-alert:LU-Alert.fixture.1:"))).toHaveLength(run === 1 ? 0 : 5);
        if (run === 1) expect(latest.luAlertCursor).toBeNull();
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("recovers a pre-fix V16 overflow at an equal-timestamp boundary", async () => {
    const state = createEmptyState(now); const { luAlertCursor: _cursor, luAlertSupersededIds: _ids, ...oldState } = state;
    expect(_cursor).toBeNull(); expect(_ids).toEqual([]);
    const legacy = IngestionStateV16Schema.parse(oldState);
    Object.assign(legacy.sourcePartitions.nationalCivilAlerts.LU, { status: "delayed", sourceUpdatedAt: "2026-08-28T03:00:00.000Z",
      error: "LU-Alert resource limit or deadline reached" });
    const resources = Array.from({ length: 101 }, (_, index) => ({ url: `https://download.data.public.lu/${String(index).padStart(3, "0")}.xml`,
      last_modified: "2026-08-28T03:00:00Z", format: "xml" }));
    const calls: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const result = await fetchLuPartition({ now, locations: catalogLocationsV3, state: legacy, fetch: (async (input) => {
        if (String(input).includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:00:00Z", resources });
        calls.push(String(input)); return new Response(String(input) === resources[0].url ? cancel : xml);
      }) as typeof fetch });
      legacy.events = result.events; legacy.luAlertCursor = result.luAlertCursor!; legacy.luAlertSupersededIds = result.luAlertSupersededIds!;
      expect(result.status).toBe(run === 0 ? "partial" : "ok"); expect(result.events).toEqual([]);
    }
    expect(new Set(calls).size).toBe(101); expect(calls).toHaveLength(101);
  });
  it("retries the failed tie boundary including older overlap resources", async () => {
    const state = createEmptyState(now);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T04:00:00.000Z";
    const resources = ["a", "b", "c"].map((id) => ({ url: `https://download.data.public.lu/${id}.xml`,
      last_modified: "2026-08-28T03:30:00Z", format: "xml" }));
    const current = { now, locations: catalogLocationsV3, state };
    const first = await fetchLuPartition({ ...current, fetch: (async (input) => String(input).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T04:20:00Z", resources })
      : new Response(String(input) === resources[1].url ? "<broken/>" : xml)) as typeof fetch });
    expect(first.status).toBe("partial");
    expect(first.luAlertCursor).toEqual({ timestamp: "2026-08-28T03:30:00.000Z", resourceUrl: resources[0].url });
    state.luAlertCursor = first.luAlertCursor!;
    const calls: string[] = [];
    const recovered = await fetchLuPartition({ ...current, fetch: (async (input) => {
      if (String(input).includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:20:00Z", resources });
      calls.push(String(input)); return new Response(xml);
    }) as typeof fetch });
    expect(recovered.status).toBe("ok"); expect(recovered.luAlertCursor).toBeNull();
    expect(calls).toEqual(resources.slice(1).map(({ url }) => url));
  });

  it.each(["expired", "duplicate-category", "exercise"])("preserves trusted lifecycle references from %s Updates", async (kind) => {
    const state = createEmptyState(now); state.events = parseLuCap(xml, { now, locations: catalogLocationsV3, fetch }).events;
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    let update = xml.replaceAll("LU-Alert.fixture.1", "LU-Alert.update")
      .replace("<msgType>Alert</msgType>", "<msgType>Update</msgType><references>sender,LU-Alert.fixture.1,2026-08-28T04:00:00Z</references>");
    if (kind === "expired") update = update.replaceAll("2026-08-28T10:00:00+02:00", "2026-08-28T06:15:00+02:00");
    if (kind === "duplicate-category") update = update.replaceAll("<category>Safety</category>", "<category>Met</category>");
    if (kind === "exercise") update = update.replace("<status>Actual</status>", "<status>Exercise</status>");
    const result = await fetchLuPartition({ now, locations: catalogLocationsV3, state, fetch: (async (input) => String(input).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T04:20:00Z", resources: [{ url: "https://download.data.public.lu/update.xml", last_modified: "2026-08-28T03:00:00Z", format: "xml" }] })
      : new Response(update)) as typeof fetch });
    expect(result.events).toEqual(kind === "exercise" ? state.events : []);
    expect(result.luAlertSupersededIds).toEqual(kind === "exercise" ? [] : ["LU-Alert.fixture.1"]);
  });

  it("fails closed without eviction when supersession state reaches its bound", async () => {
    const state = createEmptyState(now); state.luAlertSupersededIds = Array.from({ length: 1000 }, (_, i) => `old-${i}`);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
    const before = structuredClone(state);
    const current = { now, locations: catalogLocationsV3, state, fetch: (async (input) => String(input).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-08-28T04:20:00Z", resources: [{ url: "https://download.data.public.lu/cancel.xml", last_modified: "2026-08-28T03:00:00Z", format: "xml" }] })
      : new Response(cancel)) as typeof fetch };
    await expect(fetchLuPartition(current)).rejects.toThrow(/supersession state limit/);
    expect(state).toEqual(before);
    state.luAlertSupersededIds[0] = "LU-Alert.fixture.1";
    expect((await fetchLuPartition(current)).luAlertSupersededIds).toHaveLength(1000);
  });

  it.each(["absent", "failed", "not_due", "disabled", "stale"])("retains private progress for %s results", (outcome) => {
    const state = createEmptyState(now);
    state.luAlertCursor = { timestamp: "2026-08-28T03:00:00.000Z", resourceUrl: "https://download.data.public.lu/a.xml" };
    state.luAlertSupersededIds = ["retained"];
    state.partitionTransports.nationalCivilAlerts.LU["lu-alert"].lastAttempt = now.toISOString();
    const status = outcome === "stale" ? "ok" : outcome === "absent" ? "not_due" : outcome;
    const result = CatalogPartitionedSourceResultSchema.parse({ sourceId: "national-civil-alerts", checkedAt: outcome === "stale"
      ? new Date(now.getTime() - 60_000).toISOString() : new Date(now.getTime() + 60_000).toISOString(),
    partitions: Object.fromEntries(Object.keys(state.sourcePartitions.nationalCivilAlerts).map((code) => [code,
      { status: code === "LU" ? "partial" : "disabled", limitationCode: "runtime_transport_disabled", sourceUpdatedAt: null, error: null, events: [],
        ...(code === "LU" && outcome !== "absent" ? { transports: { "lu-alert": { status, sourceUpdatedAt: null, error: null, events: [],
          luAlertCursor: null, luAlertSupersededIds: [] } } } : {}) }])) });
    const next = mergeSourceResults(state, [result], now);
    expect(next.luAlertCursor).toEqual(outcome === "disabled" ? null : state.luAlertCursor); expect(next.luAlertSupersededIds).toEqual(["retained"]);
  });
  it.each([0, 200])("processes 201 tied resources without resurrecting a cancellation on page %i", async (cancelIndex) => {
    vi.stubEnv("NATIONAL_ALERTS_DISABLED_TRANSPORTS", [...new Set(Object.values(nationalWarningSources)
      .flatMap(({ systems }) => systems.map(({ id }) => id)))].filter((id) => id !== "lu-alert").join(","));
    try {
      const state = createEmptyState(now);
      state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-08-28T02:00:00.000Z";
      const store = new MemoryStateStore(state); const calls: string[] = [];
      const resources = Array.from({ length: 201 }, (_, index) => ({
        url: `https://download.data.public.lu/${String(index).padStart(3, "0")}.xml`,
        last_modified: "2026-08-28T03:00:00Z", format: "xml",
      }));
      for (let run = 0; run < 3; run += 1) {
        const read = await store.read(); const at = new Date(now.getTime() + run * 60 * 60_000);
        const result = await new NationalCivilAlertsAdapter().fetch({ state: read.data, locations: catalogLocationsV3, now: at,
          fetch: (async (input) => {
            const url = String(input);
            if (url.includes("api/1/datasets")) return Response.json({ last_update: "2026-08-28T04:00:00Z", resources });
            calls.push(url); return new Response(url === resources[cancelIndex].url ? cancel : xml);
          }) as typeof fetch });
        await store.write(mergeSourceResults(read.data, [result], at), read);
        const persisted = IngestionStateV16Schema.parse((await store.read()).data);
        expect(persisted.partitionTransports.nationalCivilAlerts.LU["lu-alert"].status).toBe(run === 2 ? "ok" : run === 0 ? "partial" : "delayed");
        if (cancelIndex === 0 || run === 2) expect(persisted.events.filter(({ id }) => id.startsWith("lu-alert:"))).toEqual([]);
        if (run === 1) {
          const latest = await store.read(); latest.data.partitionTransports.nationalCivilAlerts.LU["lu-alert"].status = "delayed";
          await store.write(latest.data, latest);
        }
      }
      expect(calls).toHaveLength(201);
      expect(new Set(calls).size).toBe(201);
    } finally { vi.unstubAllEnvs(); }
  });
});
