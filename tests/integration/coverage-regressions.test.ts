import type { IngestionStateV14 as IngestionState } from "@/lib/domain/catalog-state";
import { describe, expect, it } from "vitest";
import { locations } from "@/lib/data";
import { countryCodes, PartitionedSourceResultSchema, type NormalizedEvent, type PartitionedSourceResult } from "@/lib/domain/schemas";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "@/lib/risk";
import { locationCoveragePresentation } from "@/lib/coverage-presentation";
import { limitEvents } from "@/lib/ingestion/adapters/national-civil-alerts-shared";
import { fetchPlPartition, IMGW_HYDRO_URL } from "@/lib/ingestion/adapters/national-civil-alerts-pl";
import mapping from "../../data/imgw-hydrology-mapping.json";

const now = new Date("2026-08-31T10:00:00Z");
const health = { status: "ok" as const, lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(), nextExpectedUpdate: now.toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };
function healthy(): IngestionState {
  const state = createEmptyState(now);
  for (const id of Object.keys(state.sources) as Array<keyof typeof state.sources>) state.sources[id] = { ...health };
  for (const group of Object.values(state.sourcePartitions)) for (const code of countryCodes) group[code] = { ...health };
  return state;
}
function warning(id: string, level: NormalizedEvent["level"] = "HIGH"): NormalizedEvent {
  return { id, sourceId: "national-civil-alerts", providerId: "national-civil-alerts", type: "flood", level, timing: "ACTIVE",
    headline: "Official flood warning", explanation: "Official flood warning for the destination.", action: "Follow local instructions.", affectedArea: "Bydgoszcz",
    geometry: { kind: "locations", ids: ["pl-bydgoszcz"] }, startsAt: "2026-08-31T09:00:00Z", endsAt: "2026-08-31T18:00:00Z", expiresAt: "2026-08-31T18:00:00Z",
    sourceUpdatedAt: "2026-08-31T09:00:00Z", checkedAt: now.toISOString(), sourceName: "IMGW", sourceUrl: "https://hydro.imgw.pl/", confidence: "HIGH" };
}

describe("verified coverage and retention regressions", () => {
  it("caps independent national warnings by severity after reconciling same-ID updates", () => {
    const severe = warning("pl:bulletin:severe", "SEVERE");
    const newer = [1, 2].map((index) => ({ ...warning(`pl:bulletin:${index}`, "ELEVATED"), sourceUpdatedAt: `2026-08-31T09:0${index}:00Z` }));
    const selected = limitEvents([...newer, severe]);
    expect(selected).toHaveLength(2);
    expect(limitEvents([severe, ...newer])).toEqual(selected);
    const state = healthy(); state.events = selected;
    expect(buildSnapshot(state, now).locations["pl-bydgoszcz"].level).toBe("SEVERE");
    expect(limitEvents([severe, { ...severe, level: "ELEVATED", sourceUpdatedAt: now.toISOString() }])).toMatchObject([{ level: "ELEVATED" }]);
  });

  it.each([0, 20, 21, 60])("ages previously checked national scopes after grace (%i minutes)", (minutes) => {
    const state = healthy();
    const last = new Date(now.getTime() - minutes * 60_000);
    state.partitionTransports.nationalCivilAlerts.PL["imgw-hydrology"] = {
      ...health, lastAttempt: last.toISOString(), lastSuccess: last.toISOString(), sourceUpdatedAt: last.toISOString(),
      nextExpectedUpdate: new Date(last.getTime() + 10 * 60_000).toISOString(), checkedLocationIds: ["pl-bydgoszcz"], unavailableLocationIds: [],
    };
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations["pl-bydgoszcz"].delayedHazards).toEqual(minutes > 20 ? ["flood"] : []);
    expect(snapshot.locations["pl-bydgoszcz"].level).toBe(minutes > 20 ? "UNKNOWN" : "NORMAL");
    expect(snapshot.providers["national-civil-alerts"].partitions!.PL.transports!.find(({ id }) => id === "imgw-hydrology")!.status).toBe(minutes > 20 ? "delayed" : "ok");
    state.events = [warning("pl:bulletin:current")];
    expect(buildSnapshot(state, now).locations["pl-bydgoszcz"].level).toBe("HIGH");
  });

  it("keeps current successful destinations independent of a partial transport's failed destinations", () => {
    const state = healthy();
    state.partitionTransports.nationalCivilAlerts.PL["imgw-hydrology"] = {
      ...health, status: "delayed", consecutiveFailures: 2, checkedLocationIds: ["pl-bydgoszcz"], unavailableLocationIds: ["pl-warsaw"],
    };
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations["pl-bydgoszcz"].delayedHazards).toEqual([]);
    expect(snapshot.locations["pl-warsaw"].delayedHazards).toEqual(["flood"]);
  });

  it("keeps permanent air-quality counts stable across partial failure, delay and recovery", () => {
    const state = healthy();
    const location = locations.find(({ id }) => id === "at-vienna")!;
    const baseline = buildSnapshot(state, now);
    const present = (snapshot: ReturnType<typeof buildSnapshot>) => locationCoveragePresentation({ location, state: snapshot.locations[location.id], snapshot, now });
    for (const status of ["partial", "delayed", "ok"] as const) {
      state.sourcePartitions.eea.AT = { ...health, status };
      state.providerCoverage["eea-aqi"] = { checkedAt: now.toISOString(), checkedLocationIds: status === "ok" ? [location.id] : ["at-graz"], unavailableLocationIds: status === "ok" ? [] : [location.id] };
      const snapshot = buildSnapshot(state, now);
      expect(snapshot.locations[location.id].coverageGaps).toEqual(baseline.locations[location.id].coverageGaps);
      expect(present(snapshot).counts).toEqual({ ...present(baseline).counts, delayed: status === "delayed" ? 1 : 0 });
      expect(snapshot.locations[location.id].delayedHazards).toEqual(status === "delayed" ? ["air-quality"] : []);
    }
  });

  it("does not turn reviewed air-quality coverage gaps into delayed required checks", () => {
    const state = healthy();
    const unsupported = ["es-las-palmas-de-gran-canaria", "es-santa-cruz-de-tenerife", "pt-horta", "pt-ponta-delgada", "pt-santa-cruz-das-flores"];
    state.sourcePartitions.eea.ES = { ...health, status: "delayed", consecutiveFailures: 2 };
    state.sourcePartitions.eea.PT = { ...health, status: "delayed", consecutiveFailures: 2 };
    state.providerCoverage["eea-aqi"] = { checkedAt: now.toISOString(), checkedLocationIds: ["es-madrid"], unavailableLocationIds: [...unsupported, "pt-lisbon"] };
    const snapshot = buildSnapshot(state, now);
    for (const id of unsupported) {
      expect(snapshot.locations[id].coverageGaps).toContain("air-quality");
      expect(snapshot.locations[id].delayedHazards).not.toContain("air-quality");
      expect(snapshot.locations[id].level).toBe("NORMAL");
      const presentation = locationCoveragePresentation({ location: locations.find((location) => location.id === id)!, state: snapshot.locations[id], snapshot, now });
      expect(presentation.delayed).toEqual([]);
      expect(presentation.categories.find(({ key }) => key === "air-quality")).toMatchObject({ coverageStatus: "not_monitored", freshnessStatus: "current" });
    }
    expect(snapshot.locations["pt-lisbon"].delayedHazards).toContain("air-quality");
    expect(snapshot.locations["es-madrid"].delayedHazards).not.toContain("air-quality");
  });

  it("publishes disabled context as disabled, while real context failures stay non-blocking", () => {
    const state = healthy();
    state.sources.gdelt = { ...health, status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null, sourceUpdatedAt: null, error: "environment_disabled" };
    const disabled = buildSnapshot(state, now);
    expect(disabled.providers.gdelt).toMatchObject({ status: "disabled", limitationCode: "environment_disabled" });
    expect(disabled.dataHealth).toBe("complete");
    state.sources.gdelt = { ...state.sources.gdelt, status: "delayed", consecutiveFailures: 2, error: "Upstream unavailable" };
    const failed = buildSnapshot(state, now);
    expect(failed.providers.gdelt.status).toBe("delayed");
    expect(failed.dataHealth).toBe("complete");
    expect(failed.locations["at-vienna"].delayedHazards).toEqual([]);
  });

  it("keeps weather delays scoped to applicable destination hazards", () => {
    const state = healthy();
    state.sourcePartitions.meteoalarm.DE = { ...health, status: "delayed", consecutiveFailures: 2 };
    const snapshot = buildSnapshot(state, now);
    expect(snapshot.locations["de-berlin"].delayedHazards).toContain("severe-weather");
    expect(snapshot.locations["de-berlin"].delayedHazards).not.toContain("coastal");
    expect(snapshot.locations["at-vienna"].delayedHazards).toEqual([]);
  });

  it("scopes repeated EFFIS no-data failures without changing permanent fire-danger coverage", () => {
    let state = healthy();
    const result = { sourceId: "effis" as const, checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      status: "partial" as const, error: "One missing sample", events: [], checkedLocationIds: ["pt-madeira"], unavailableLocationIds: ["at-austrian-alps"] };
    for (let attempt = 0; attempt < 2; attempt++) {
      state = mergeSourceResults(state, [result], now);
      const snapshot = buildSnapshot(state, now);
      expect(snapshot.dataHealth).toBe("complete");
      expect(snapshot.locations["pt-madeira"].delayedHazards).not.toContain("fire-danger");
      expect(snapshot.locations["at-vienna"].delayedHazards).not.toContain("fire-danger");
      expect(snapshot.locations["at-austrian-alps"].delayedHazards.includes("fire-danger")).toBe(attempt === 1);
      const location = locations.find(({ id }) => id === "pt-madeira")!;
      // An unrelated late weather feed must not make the successful EFFIS sample late.
      snapshot.locations[location.id].delayedHazards.push("severe-weather");
      snapshot.locations[location.id].coverage = "delayed";
      const presentation = locationCoveragePresentation({ location, state: snapshot.locations[location.id], snapshot, now });
      expect(presentation.categories.flatMap(({ subchecks }) => subchecks).find(({ hazard }) => hazard === "fire-danger"))
        .toMatchObject({ coverageStatus: "available", freshnessStatus: "current" });
    }
    const later = new Date(now.getTime() + 121 * 60_000);
    // Other sources keep the overall snapshot fresh while EFFIS misses its cadence.
    const fresh = healthy(); fresh.sources.effis = state.sources.effis; fresh.providerCoverage = state.providerCoverage;
    for (const [id, health] of Object.entries(fresh.sources)) if (id !== "effis") Object.assign(health, { lastSuccess: later.toISOString(), nextExpectedUpdate: later.toISOString() });
    expect(buildSnapshot(fresh, later).locations["pt-madeira"].delayedHazards).toContain("fire-danger");
    state = mergeSourceResults(state, [{ ...result, status: "ok", error: null, checkedLocationIds: ["pt-madeira", "at-austrian-alps"], unavailableLocationIds: [] }], now);
    expect(buildSnapshot(state, now).locations["at-austrian-alps"].delayedHazards).not.toContain("fire-danger");
  });

  it.each([[true, false], [false, true], [true, true], [false, false]])("clears successful IMGW subtransports independently (measurements %s, bulletins %s)", async (measurementsOk, bulletinsOk) => {
    const state = healthy();
    const station = mapping.mappings.find(({ locationId }) => locationId === "pl-bydgoszcz")!.stationIds[0];
    const measurement = warning(`pl:measurement:${station}:pl-bydgoszcz`);
    const bulletin = warning("pl:bulletin:old:pl-bydgoszcz");
    state.events = [measurement, bulletin];
    const rows = [...new Set(mapping.mappings.flatMap(({ stationIds }) => stationIds))].map((id) => ({ id_stacji: id, stan_wody: 1, stan_ostrzegawczy: 100, stan_alarmowy: 200, stan_wody_data_pomiaru: now.toISOString() }));
    const partition = await fetchPlPartition({ now, locations, state, fetch: (async (input) => String(input) === IMGW_HYDRO_URL
      ? Response.json(measurementsOk ? rows : [])
      : new Response(bulletinsOk ? "<html><body>Index of /data/current/ost_hydro/</body></html>" : '<a href="bad.TXT">bad.TXT</a>')) as typeof fetch });
    const result: PartitionedSourceResult = { sourceId: "national-civil-alerts", checkedAt: now.toISOString(), partitions: Object.fromEntries(countryCodes.map((code) => [code, code === "PL" ? partition : { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null }])) as PartitionedSourceResult["partitions"] };
    const retained = mergeSourceResults(state, [result], now).events.map(({ id }) => id).sort();
    expect(retained).toEqual([...(measurementsOk ? [] : [measurement.id]), ...(bulletinsOk ? [] : [bulletin.id])].sort());
  });

  it("keeps an IMGW drought cancellation healthy-empty while retaining only genuinely stale measurement scopes", async () => {
    const state = healthy();
    state.events = [warning("pl:bulletin:old:pl-bydgoszcz")];
    const staleStations = new Set(mapping.mappings.find(({ locationId }) => locationId === "pl-bialystok")!.stationIds);
    const rows = [...new Set(mapping.mappings.flatMap(({ stationIds }) => stationIds))].map((id) => ({
      id_stacji: id, stan_wody: 1, stan_ostrzegawczy: 100, stan_alarmowy: 200,
      stan_wody_data_pomiaru: staleStations.has(id) ? "2026-08-30T10:00:00Z" : now.toISOString(),
    }));
    const partition = await fetchPlPartition({ now, locations, state, fetch: (async (input) => {
      const url = String(input);
      if (url === IMGW_HYDRO_URL) return Response.json(rows);
      return new Response(url.endsWith(".TXT")
        ? "Odwołanie ostrzeżenia Nr: 93\nZjawisko: susza hydrologiczna\nStopień: nie dotyczy\nWażność: od godz.  dnia  do godz.  dnia"
        : '<a href="drought.TXT">drought.TXT</a>');
    }) as typeof fetch });
    expect(partition).toMatchObject({ status: "partial", events: [], unavailableLocationIds: ["pl-bialystok"], removedEventPrefixes: expect.arrayContaining(["pl:bulletin:"]) });
    expect(partition.checkedLocationIds).toContain("pl-bydgoszcz");
    const result = PartitionedSourceResultSchema.parse({
      sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(countryCodes.map((code) => [code, code === "PL" ? {
        ...partition, transports: { "imgw-hydrology": {
          status: partition.status, sourceUpdatedAt: partition.sourceUpdatedAt, error: partition.error,
          checkedLocationIds: partition.checkedLocationIds, unavailableLocationIds: partition.unavailableLocationIds,
        } },
      } : { status: "ok", sourceUpdatedAt: now.toISOString(), events: [], error: null }])),
    });
    const merged = mergeSourceResults(mergeSourceResults(state, [result], now), [result], now);
    expect(merged.events).toEqual([]);
    expect(merged.partitionTransports.nationalCivilAlerts.PL["imgw-hydrology"].status).toBe("delayed");
    const snapshot = buildSnapshot(merged, now);
    expect(snapshot.locations["pl-bydgoszcz"].delayedHazards).toEqual([]);
    expect(snapshot.locations["pl-bialystok"].delayedHazards).toEqual(["flood"]);
  });
});
