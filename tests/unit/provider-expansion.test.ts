import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { avalancheLevel, EuregioAvalancheAdapter, euregioEvents, slfEvents } from "@/lib/ingestion/adapters/avalanche";
import reportMapping from "../../data/avalanche-report-region-mapping.json";
import { foenExpiresAt, foenLevel, sampleFoen } from "@/lib/ingestion/adapters/foen";
import { krisinformationPartition } from "@/lib/ingestion/adapters/national-civil-alerts";
import { qualifiesGfmFlood, selectGfmTargets } from "@/lib/ingestion/adapters/satellite";
import { EhydFloodAdapter, parseGesamtcode } from "@/lib/ingestion/adapters/ehyd";
import { VigicruesAdapter } from "@/lib/ingestion/adapters/vigicrues";
import { locations } from "@/lib/data";
import type { DiscoveryCandidate, NormalizedEvent } from "@/lib/domain/schemas";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";
import { createSourceDiagnostics } from "@/lib/ingestion/types";

const now = new Date("2026-08-27T12:00:00Z");
const context = { now, locations, fetch };

function gfmEvent(id: string, locationId: string): NormalizedEvent {
  return {
    id, sourceId: "gfm", providerId: "gfm", type: "flood", level: "ELEVATED", timing: "ACTIVE",
    headline: "Satellite flood extent detected.", explanation: "Satellite data corroborates an active flood candidate.",
    action: "Check official local flood warnings.", affectedArea: locationId, geometry: { kind: "locations", ids: [locationId] },
    startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), sourceUpdatedAt: now.toISOString(),
    checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), sourceName: "Copernicus GFM",
    sourceUrl: "https://global-flood.emergency.copernicus.eu/", confidence: "MEDIUM",
  };
}

describe("keyless provider expansion", () => {
  it("collapses mapped Vigicrues sections to the highest destination level and rejects malformed non-empty feeds", async () => {
    const fixture = await readFile("tests/fixtures/providers/vigicrues-rss.xml", "utf8");
    const adapter = new VigicruesAdapter();
    const result = await adapter.fetch({ ...context, fetch: (async () => new Response(fixture)) as typeof fetch });
    const paris = result.events.find((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("fr-paris"));
    expect(result.status).toBe("ok");
    expect(paris).toMatchObject({ level: "SEVERE", confidence: "HIGH", providerId: "vigicrues" });
    const malformed = await adapter.fetch({ ...context, fetch: (async () => new Response("<rss><channel><item><title>broken</title></item></channel></rss>")) as typeof fetch });
    expect(malformed.status).toBe("failed");
    const structurallyInvalid = await adapter.fetch({ ...context, fetch: (async () => new Response("<html></html>")) as typeof fetch });
    expect(structurallyInvalid.status).toBe("failed");
    const healthyEmptyDiagnostics = createSourceDiagnostics();
    const healthyEmpty = await adapter.fetch({
      ...context,
      diagnostics: healthyEmptyDiagnostics,
      fetch: (async () => new Response("<rss><channel><item><title>Pas de vigilance particulière requise</title><link>https://www.vigicrues.gouv.fr/</link><description>Pas de vigilance particulière requise</description><pubDate>Thu, 27 Aug 2026 08:34:21 +0200</pubDate></item></channel></rss>")) as typeof fetch,
    });
    expect(healthyEmpty).toMatchObject({ status: "ok", events: [], error: null, unavailableLocationIds: [] });
    expect(healthyEmptyDiagnostics).toMatchObject({ recordsExamined: 1, matchedLocations: 0 });
    const oldFixture = fixture.replace("</channel>", "<item><title>Maine : rouge</title><link>https://www.vigicrues.gouv.fr/#ML11</link><pubDate>Thu, 27 Aug 2026 08:34:21 +0200</pubDate></item></channel>");
    const previous = await adapter.fetch({ ...context, fetch: (async () => new Response(oldFixture)) as typeof fetch });
    const mixedFixture = fixture.replace("</channel>", "<item><title>Maine : jaune</title><link>https://www.vigicrues.gouv.fr/#ML14</link><pubDate>Thu, 27 Aug 2026 08:35:21 +0200</pubDate></item><item><title>broken severity</title><link>https://www.vigicrues.gouv.fr/#ML11</link><pubDate>Thu, 27 Aug 2026 08:35:21 +0200</pubDate></item></channel>");
    const mixed = await adapter.fetch({ ...context, fetch: (async () => new Response(mixedFixture)) as typeof fetch });
    expect(mixed).toMatchObject({ status: "partial", unavailableLocationIds: ["fr-angers"] });
    expect(mixed.checkedLocationIds).not.toContain("fr-angers");
    expect(mixed.events.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("fr-angers"))).toBe(false);

    const state = createEmptyState(now);
    state.events = previous.events;
    const merged = mergeSourceResults(state, [mixed], now);
    expect(merged.events.find((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("fr-angers")))
      .toMatchObject({ level: "SEVERE" });
  });

  it("scores only official eHYD flood stages for mapped Austrian destinations", async () => {
    const fixture = await readFile("tests/fixtures/providers/ehyd-pegel.json", "utf8");
    const adapter = new EhydFloodAdapter();
    const result = await adapter.fetch({ ...context, fetch: (async () => new Response(fixture)) as typeof fetch });
    const vienna = result.events.find((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("at-vienna"));
    expect(result.status).toBe("ok");
    expect(parseGesamtcode(600)).toEqual({ stage: 6, trend: 0, stale: false });
    expect(parseGesamtcode(130)).toEqual({ stage: 1, trend: 3, stale: false });
    expect(parseGesamtcode(999)).toBeNull();
    expect(vienna).toMatchObject({ level: "SEVERE", providerId: "ehyd-flood", confidence: "HIGH" });
    expect(result.events.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("hu-budapest"))).toBe(false);
    const empty = await adapter.fetch({
      ...context,
      fetch: (async () => Response.json({ type: "FeatureCollection", features: [] })) as typeof fetch,
    });
    expect(empty).toMatchObject({ status: "ok", events: [], error: null });
    const noData = await adapter.fetch({
      ...context,
      fetch: (async () => Response.json({
        type: "FeatureCollection",
        features: [{ type: "Feature", id: "pegel_aktuell.201087", properties: { hzbnr: 201087, gesamtcode: 930, zeitpunkt: null, messstelle: "Lechaschau" } }],
      })) as typeof fetch,
    });
    expect(noData).toMatchObject({ status: "ok", events: [], error: null });
    const malformed = await adapter.fetch({ ...context, fetch: (async () => Response.json({ features: [{ properties: {} }] })) as typeof fetch });
    expect(malformed.status).toBe("failed");
    const mixed = await adapter.fetch({
      ...context,
      fetch: (async () => Response.json({
        type: "FeatureCollection",
        features: [
          ...JSON.parse(fixture).features,
          { type: "Feature", id: "broken", properties: { hzbnr: 207241, gesamtcode: "nope" } },
        ],
      })) as typeof fetch,
    });
    expect(mixed).toMatchObject({ status: "partial", unavailableLocationIds: ["at-vienna"] });
    expect(mixed.events.some((event) => event.geometry.kind === "locations" && event.geometry.ids.includes("at-vienna"))).toBe(false);
  });

  it("uses only the exact FOEN warning palette and samples destination geometry", async () => {
    const fixture = JSON.parse(await readFile("tests/fixtures/providers/foen-palette.json", "utf8")) as {
      levels: Record<string, number[][]>;
    };
    expect([0, 1, 2, 3, 4, 5].map(foenLevel)).toEqual([null, null, "ELEVATED", "HIGH", "SEVERE", "SEVERE"]);
    const pixels = 512 * 256;
    const swissAlps = locations.find(({ id }) => id === "ch-swiss-alps")!;
    for (const [level, colors] of Object.entries(fixture.levels)) {
      for (const [red, green, blue] of colors) {
        expect(sampleFoen([
          new Uint8Array(pixels).fill(red), new Uint8Array(pixels).fill(green), new Uint8Array(pixels).fill(blue),
        ], swissAlps)).toBe(Number(level));
      }
    }
    expect(sampleFoen([new Uint8Array(pixels).fill(1), new Uint8Array(pixels).fill(2), new Uint8Array(pixels).fill(3)], swissAlps)).toBe(0);
    expect(foenExpiresAt(now)).toBe("2026-08-27T13:30:00.000Z");
  });

  it("rejects Krisinformation test VMAs and publishes production VMAs without text severity heuristics", async () => {
    const fixture = JSON.parse(await readFile("tests/fixtures/providers/krisinformation-test-vma.json", "utf8"));
    const testResult = krisinformationPartition(fixture, { ...context, now: new Date("2023-03-29T12:00:00Z") });
    expect(testResult).toMatchObject({ status: "ok", events: [] });
    const production = structuredClone(fixture);
    production[0].IsTest = false;
    const result = krisinformationPartition(production, { ...context, now: new Date("2023-03-29T12:00:00Z") });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.type === "civil-emergency" && event.level === "ELEVATED" && event.confidence === "HIGH")).toBe(true);
    production[0].Web = "http://attacker.example/story";
    expect(krisinformationPartition(production, { ...context, now: new Date("2023-03-29T12:00:00Z") }).events
      .every((event) => event.sourceUrl === "https://www.krisinformation.se/en")).toBe(true);
    production[0].Web = "https://notkrisinformation.se/story";
    expect(krisinformationPartition(production, { ...context, now: new Date("2023-03-29T12:00:00Z") }).events
      .every((event) => event.sourceUrl === "https://www.krisinformation.se/en")).toBe(true);
  });

  it("parses non-empty SLF geometry, preserves partial scope, and uses reviewed Avalanche.report region IDs", async () => {
    const slf = JSON.parse(await readFile("tests/fixtures/providers/slf-nonempty.json", "utf8"));
    const slfContext = { ...context, now: new Date("2026-02-19T10:00:00Z") };
    const parsed = slfEvents(slf, slfContext);
    expect(parsed.events.map((event) => event.level)).toEqual(["HIGH", "HIGH"]);
    const mixed = slfEvents({ ...slf, features: [...slf.features, { type: "Feature", properties: {}, geometry: null }] }, slfContext);
    expect(mixed).toMatchObject({ status: "partial", unavailableLocationIds: ["ch-bernese-oberland", "ch-swiss-alps"] });

    const report = JSON.parse(await readFile("tests/fixtures/providers/avalanche-report-nonempty.json", "utf8"));
    expect(euregioEvents(report, { ...context, now: new Date("2026-05-03T10:00:00Z") })).toEqual([]);
    expect(euregioEvents(report, context)).toEqual([]);
    expect(euregioEvents({ bulletins: [{ publicationTime: now.toISOString(), validTime: { startTime: now.toISOString(), endTime: new Date(now.getTime() + 24 * 60 * 60_000).toISOString() }, regions: [{ regionID: "FI-01" }] }] }, context)).toEqual([]);
    expect(() => euregioEvents({ bulletins: [{ ...report.bulletins[0], dangerRatings: [{}], regions: [] }] }, context)).toThrow(/no parseable bulletins/);
    report.bulletins[0].dangerRatings = [{ mainValue: "considerable" }];
    const events = euregioEvents(report, { ...context, now: new Date("2026-05-03T10:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerId: "euregio-avalanche", level: avalancheLevel(3), geometry: { ids: ["it-dolomites"] } });
    expect(reportMapping.partitions.filter(({ enabled }) => enabled)).toHaveLength(17);
    const partitionFixtures = JSON.parse(await readFile("tests/fixtures/providers/eaws-partition-fixtures.json", "utf8"));
    expect(Object.keys(partitionFixtures.ratedBulletinCounts).sort()).toEqual(reportMapping.partitions.filter(({ enabled }) => enabled).map(({ feedCode }) => feedCode).sort());
    expect(reportMapping.partitions.find(({ feedCode }) => feedCode === "FI")?.enabled).toBe(false);
    expect(reportMapping.mappings.some(({ locationId }) => locationId === "de-black-forest")).toBe(false);
  });

  it("treats documented EAWS seasonal absence as healthy and isolates one partition failure", async () => {
    const urls: string[] = [];
    const seasonal = await new EuregioAvalancheAdapter().fetch({
      ...context,
      fetch: (async (input) => { urls.push(String(input)); return new Response(null, { status: 404 }); }) as typeof fetch,
    });
    expect(seasonal).toMatchObject({ status: "ok", events: [], error: null });
    expect(urls).toHaveLength(reportMapping.partitions.filter(({ enabled }) => enabled).length);

    let calls = 0;
    const partial = await new EuregioAvalancheAdapter().fetch({
      ...context,
      fetch: (async () => {
        calls += 1;
        return calls === 1 ? new Response("malformed", { status: 200 }) : new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    expect(partial).toMatchObject({ status: "partial", events: [], error: "1 EAWS bulletin partitions failed" });
    expect(partial.unavailableLocationIds).toContain("at-austrian-alps");
    expect(partial.unavailableLocationIds).not.toContain("it-dolomites");
    expect(partial.checkedLocationIds).toContain("it-dolomites");
  });

  it("uses aligned GFM grids, deterministic target caps, and location-scoped replacement", async () => {
    const grids = JSON.parse(await readFile("tests/fixtures/providers/gfm-grids.json", "utf8"));
    expect(qualifiesGfmFlood(grids.extent, grids.likelihood, grids.advisory, grids.width)).toBe(true);
    const candidate: DiscoveryCandidate = {
      providerId: "gdacs", externalId: "FL:target", hazardType: "flood", geometry: { type: "Point", coordinates: [10, 47] },
      startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(), sourceUpdatedAt: now.toISOString(),
      officialUrl: "https://www.gdacs.org/", expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    };
    const targets = selectGfmTargets([candidate], locations, now, 12);
    expect(targets).toHaveLength(12);
    expect(targets.map(({ location }) => location.id)).toEqual(selectGfmTargets([candidate], locations, now, 12).map(({ location }) => location.id));
    expect(selectGfmTargets([{ ...candidate, expiresAt: now.toISOString() }], locations, now, 12)).toEqual([]);
    expect(selectGfmTargets([{ ...candidate, startsAt: new Date(now.getTime() + 1).toISOString() }], locations, now, 12)).toEqual([]);

    const state = createEmptyState(now);
    state.events = [gfmEvent("old-vienna", "at-vienna"), gfmEvent("old-budapest", "hu-budapest")];
    const merged = mergeSourceResults(state, [{
      sourceId: "gfm", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [gfmEvent("new-vienna", "at-vienna")],
      status: "partial", error: "one target unavailable", checkedLocationIds: ["at-vienna"], unavailableLocationIds: ["hu-budapest"],
    }], now);
    expect(merged.events.map(({ id }) => id).sort()).toEqual(["new-vienna", "old-budapest"]);
    expect(merged.providerCoverage.gfm).toMatchObject({ checkedLocationIds: ["at-vienna"], unavailableLocationIds: ["hu-budapest"] });

    const disabled = mergeSourceResults(merged, [{
      sourceId: "gfm", checkedAt: now.toISOString(), sourceUpdatedAt: null, events: [], status: "disabled", error: null,
      limitationCode: "environment_disabled", checkedLocationIds: [], unavailableLocationIds: [],
    }], now);
    expect(disabled.events.some(({ sourceId }) => sourceId === "gfm")).toBe(false);
  });

  it("retains unexpired avalanche evidence until its destination is fully checked", () => {
    const locationId = "ch-swiss-alps";
    const oldEvent = { ...gfmEvent("old-slf", locationId), sourceId: "slf-avalanche" as const, providerId: "slf-avalanche" as const, type: "avalanche" as const, sourceName: "SLF" };
    const newEvent = { ...oldEvent, id: "new-slf", sourceUpdatedAt: new Date(now.getTime() + 60_000).toISOString() };
    const state = createEmptyState(now);
    state.events = [oldEvent];
    const partial = {
      sourceId: "slf-avalanche" as const, checkedAt: now.toISOString(), sourceUpdatedAt: newEvent.sourceUpdatedAt,
      events: [newEvent], status: "partial" as const, error: "one bulletin was invalid",
      checkedLocationIds: [] as string[], unavailableLocationIds: [locationId],
    };
    expect(mergeSourceResults(state, [partial], now).events.map(({ id }) => id)).toEqual(["old-slf", "new-slf"]);
    partial.checkedLocationIds = [locationId];
    partial.unavailableLocationIds = [];
    expect(mergeSourceResults(state, [partial], now).events.map(({ id }) => id)).toEqual(["new-slf"]);
  });

  it("leaves a one-event-per-destination synthetic maximum for the hard size guard to reject", () => {
    const state = createEmptyState(now);
    state.events = locations.map((location, index): NormalizedEvent => ({
      id: `max-${index}`, sourceId: "vigicrues", providerId: "vigicrues", type: "flood", level: "ELEVATED", timing: "ACTIVE",
      headline: `Flood warning for ${location.name}.`, explanation: "Official flood warning applies to this destination.",
      action: "Monitor official updates and avoid affected waterways.", affectedArea: location.name,
      geometry: { kind: "locations", ids: [location.id] }, startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      sourceName: "Vigicrues", sourceUrl: "https://www.vigicrues.gouv.fr/", confidence: "HIGH",
    }));
    const bytes = Buffer.byteLength(JSON.stringify(buildSnapshot(state, now)));
    expect(bytes).toBeGreaterThan(500_000);
    expect(bytes).toBeLessThan(700_000);
  });
});


it.each([{ error: "service unavailable" }, { bulletins: {} }, { bulletins: null }])("rejects malformed EAWS envelopes without clearing active evidence: %j", async (payload) => {
  const state = createEmptyState(now);
  const warning: NormalizedEvent = { ...gfmEvent("avalanche:retained", "it-dolomites"), sourceId: "euregio-avalanche", providerId: "euregio-avalanche", type: "avalanche", level: "HIGH" };
  state.events = [warning];
  const adapter = new EuregioAvalancheAdapter();
  const failed = await adapter.fetch({ ...context, fetch: async () => Response.json(payload) });
  expect(failed.status).toBe("failed");
  expect(mergeSourceResults(state, [failed], now).events).toEqual([warning]);
  const empty = await adapter.fetch({ ...context, fetch: async () => Response.json({ bulletins: [] }) });
  expect(empty.status).toBe("ok");
  expect(mergeSourceResults(state, [empty], now).events).toEqual([]);
});
