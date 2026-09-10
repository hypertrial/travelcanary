import { parseCatalogState } from "@/lib/domain/catalog-state";
import { projectLegacyState } from "../fixtures/legacy-state";
import { gzipSync } from "node:zlib";
import { currentConditions, infrastructureTiming } from "@/lib/conditions/presentation";
import { buildConditionsFiles } from "@/lib/conditions/state";
import { runConditions } from "@/lib/conditions/worker";
import { MemoryStateStore } from "@/lib/storage";
import { conditionSourceIds } from "@/lib/domain/conditions";
import { describe, expect, it } from "vitest";
import { locations } from "@/lib/data";
import { ConditionsSchema, emptyConditions, type InfrastructureIncident } from "@/lib/domain/conditions";
import { createEmptyState, buildSnapshot } from "@/lib/risk";
import { downgradeIngestionStateV12, parseIngestionState } from "@/lib/domain/schemas";
import { mergeInfrastructure, parseAutobahnInfrastructure, parseEacInfrastructure, parseEnemaltaInfrastructure,
  parseKrisinformationInfrastructure, parseNdwInfrastructure, parsePseEnergyCompass, rankInfrastructure } from "@/lib/conditions/infrastructure";

const now = new Date("2026-08-31T17:45:00.000Z");
const iso = now.toISOString();
const location = (id: string) => locations.find((item) => item.id === id)!;
const record = (id: string, sourceId: InfrastructureIncident["sourceId"], kind: InfrastructureIncident["kind"], status: InfrastructureIncident["status"] = "active"): InfrastructureIncident => ({
  id, sourceId, sourceUpdatedAt: iso, checkedAt: iso, expiresAt: "2026-08-31T19:45:00.000Z", kind, status,
  scope: "destination", scopeLabel: "Test place", startsAt: status === "planned" ? "2026-08-31T18:00:00.000Z" : "2026-08-31T17:00:00.000Z",
  endsAt: "2026-08-31T19:45:00.000Z", estimatedRestorationAt: null, sourceUrl: "https://example.com/official",
});

describe("infrastructure conditions", () => {
  it("classifies only current Swedish infrastructure news and persists no authority prose", () => {
    const result = parseKrisinformationInfrastructure([{
      Identifier: "123", Published: "2026-08-31T17:00:00Z", Updated: "2026-08-31T17:30:00Z",
      Headline: "Strömavbrott i Stockholm", Preamble: "Raw prose must remain transient", Web: "https://www.krisinformation.se/nyheter/123",
      Area: [{ Description: "Stockholms län" }],
    }, {
      Identifier: "test", Published: "2026-08-31T17:00:00Z", Headline: "Övning strömavbrott", Web: "https://www.krisinformation.se/nyheter/test",
      Area: [{ Description: "Stockholms län" }],
    }], now);
    expect(result.locations["se-stockholm"]).toMatchObject([{ id: "kris:123", kind: "power-outage", scope: "region", scopeLabel: "Stockholms Län" }]);
    expect(JSON.stringify(result)).not.toContain("Raw prose");
    expect(result.locations["se-stockholm"]).toHaveLength(1);
    expect(parseKrisinformationInfrastructure([{ Identifier: "external", Published: iso, Headline: "Strömavbrott", Web: "https://example.com/story", Area: [{ County: "Stockholms län" }] }], now).locations["se-stockholm"]).toEqual([]);
    expect(parseKrisinformationInfrastructure([{ Identifier: "lookalike", Published: iso, Headline: "Strömavbrott", Web: "https://notkrisinformation.se/story", Area: [{ County: "Stockholms län" }] }], now).locations["se-stockholm"]).toEqual([]);
    expect(parseKrisinformationInfrastructure([{ Identifier: "insecure", Published: iso, Headline: "Strömavbrott", Web: "http://www.krisinformation.se/story", Area: [{ County: "Stockholms län" }] }], now).locations["se-stockholm"]).toEqual([]);
    expect(parseKrisinformationInfrastructure([{ Identifier: "credentials", Published: iso, Headline: "Strömavbrott", Web: "https://user:pass@www.krisinformation.se/story", Area: [{ County: "Stockholms län" }] }], now).locations["se-stockholm"]).toEqual([]);
    expect(parseKrisinformationInfrastructure([{
      Identifier: "future", Published: "2026-09-01T17:00:00Z", Updated: "2026-08-31T17:30:00Z",
      Headline: "Strömavbrott i Stockholm", Web: "https://www.krisinformation.se/nyheter/future", Area: [{ Description: "Stockholms län" }],
    }], now).locations["se-stockholm"]).toEqual([]);
  });

  it("accepts reviewed Autobahn types only where the road and geometry both match", () => {
    const berlin = location("de-berlin");
    const result = parseAutobahnInfrastructure({ closure: [{ identifier: "c1", display_type: "CLOSURE", coordinate: { lat: berlin.centroid[1], long: berlin.centroid[0] },
      startTimestamp: "2026-08-31T17:00:00Z", endTimestamp: "2026-08-31T19:00:00Z", lastUpdate: "2026-08-31T17:30:00Z" }] }, "A100", "closure", now);
    expect(result.locations[berlin.id]).toMatchObject([{ kind: "road-closure", status: "active" }]);
    expect(parseAutobahnInfrastructure({ closure: [{ identifier: "c1", display_type: "CLOSURE", coordinate: { lat: berlin.centroid[1], long: berlin.centroid[0] },
      startTimestamp: "2026-08-31T17:00:00Z", endTimestamp: "2026-08-31T19:00:00Z" }] }, "A1", "closure", now).locations[berlin.id]).toEqual([]);
    expect(parseAutobahnInfrastructure({ closure: [{ identifier: "c1", display_type: "CLOSURE", coordinate: { lat: berlin.centroid[1], long: berlin.centroid[0] } }] }, "A100", "closure", now).locations[berlin.id]).toEqual([]);
    expect(() => parseAutobahnInfrastructure({ unexpected: [] }, "A100", "closure", now)).toThrow();
  });

  it("parses only certain current NDW closures at exact published geometry", () => {
    const amsterdam = location("nl-amsterdam");
    const xml = `<d2LogicalModel><situation><headerInformation><informationStatus>real</informationStatus></headerInformation><situationRecord id="ndw-1" type="Accident">
      <situationRecordCreationTime>2026-08-31T17:00:00Z</situationRecordCreationTime><situationRecordVersionTime>2026-08-31T17:30:00Z</situationRecordVersionTime>
      <probabilityOfOccurrence>certain</probabilityOfOccurrence><safetyRelatedMessage>true</safetyRelatedMessage><roadOrCarriagewayOrLaneManagementType>roadClosed</roadOrCarriagewayOrLaneManagementType>
      <cause><causeType>accident</causeType></cause>
      <validity><validityStatus>active</validityStatus><validityTimeSpecification><overallStartTime>2026-08-31T17:00:00Z</overallStartTime><overallEndTime>2026-08-31T19:00:00Z</overallEndTime></validityTimeSpecification></validity>
      <location><latitude>${amsterdam.centroid[1]}</latitude><longitude>${amsterdam.centroid[0]}</longitude></location></situationRecord></situation></d2LogicalModel>`;
    expect(parseNdwInfrastructure(xml, now).locations[amsterdam.id]).toMatchObject([{ id: "ndw:ndw-1", kind: "road-closure" }]);
    expect(parseNdwInfrastructure(xml.replace("accident", "constructionWork"), now).locations[amsterdam.id]).toEqual([]);
    expect(parseNdwInfrastructure(xml.replace("accident", "roadMaintenance"), now).locations[amsterdam.id]).toEqual([]);
    expect(parseNdwInfrastructure(xml.replace("certain", "riskOf"), now).locations[amsterdam.id]).toEqual([]);
    expect(parseNdwInfrastructure(xml.replace("<validityStatus>active</validityStatus>", "<validityStatus>suspended</validityStatus>"), now).locations[amsterdam.id]).toEqual([]);
    expect(() => parseNdwInfrastructure("<!DOCTYPE x>" + xml, now)).toThrow(/Unsupported/);
  });

  it("maps exact EAC locality rows and rejects page-shape drift", () => {
    const html = `<h2>CURRENT OUTAGES (FAULTS)</h2><table><tr><td>Larnaca</td><td>31/08/2026 06:00 PM</td><td>31/08/2026 09:00 PM</td></tr></table>
      <h2>SCHEDULED INTERRUPTIONS</h2><p>No scheduled interruptions</p>`;
    expect(parseEacInfrastructure(html, "2", now).locations["cy-larnaca"]).toMatchObject([{ kind: "power-outage", status: "active" }]);
    expect(() => parseEacInfrastructure(html.replaceAll("SCHEDULED INTERRUPTIONS", "OTHER").replaceAll("scheduled interruptions", "other"), "2", now)).toThrow(/contract/);
    expect(parseEacInfrastructure(html.replace("Larnaca", "Unmapped village"), "2", now).locations["cy-larnaca"]).toEqual([]);
  });

  it("uses Enemalta geometry and never fabricates a restoration estimate", () => {
    const valletta = location("mt-valletta"); const [lon, lat] = valletta.centroid;
    const current = [{ id: 1, lastupdated: "2026-08-31T17:20:00Z", PolygonGeometry: `POINT (${lon} ${lat})`, duration: "a few hours" }];
    const planned = [{ id: 2, StartDate: "2026-08-31T18:00:00Z", EndDate: "2026-08-31T20:00:00Z", Transformers: [{ GpsCoord: `POINT (${lon} ${lat})` }] }];
    const result = parseEnemaltaInfrastructure(current, planned, now).locations[valletta.id];
    expect(result).toMatchObject([{ status: "active", estimatedRestorationAt: null }, { status: "planned", estimatedRestorationAt: "2026-08-31T20:00:00.000Z" }]);
    expect(() => parseEnemaltaInfrastructure([{ id: 1 }], [], now)).toThrow(/geometry/);
    expect(() => parseEnemaltaInfrastructure([{ id: 1, PolygonGeometry: `POINT (${lon} ${lat})` }], [], now)).toThrow(/update time/);
  });

  it("publishes only PSE states 2 and 3 as national advisories", () => {
    const base = { is_active: true, valid_from_ts_utc: "2026-08-31T17:00:00Z", valid_to_ts_utc: "2026-08-31T19:00:00Z", publication_ts_utc: "2026-08-31T16:30:00Z" };
    const parsed = parsePseEnergyCompass({ value: [0, 1, 2, 3].map((usage_fcst) => ({ ...base, usage_fcst })) }, now);
    expect(parsed["pl-warsaw"]).toMatchObject([{ state: "reduce-use", scope: "country" }]);
    expect(JSON.stringify(parsed)).not.toMatch(/price|reserve|imbalance/);
    expect(parsePseEnergyCompass({ value: [{ ...base, usage_fcst: 1 }] }, now)["pl-warsaw"]).toEqual([]);
    expect(parsePseEnergyCompass({ value: [{ ...base, usage_fcst: 2, is_active: false }] }, now)["pl-warsaw"]).toEqual([]);
    expect(parsePseEnergyCompass({ value: [{ ...base, usage_fcst: 2, is_active: "false" }] }, now)["pl-warsaw"]).toEqual([]);
    expect(parsePseEnergyCompass({ value: [{ ...base, usage_fcst: 2, is_active: undefined }] }, now)["pl-warsaw"]).toEqual([]);
    const withoutPublication = parsePseEnergyCompass({ value: [{ ...base, usage_fcst: 2, publication_ts_utc: undefined }] }, now)["pl-warsaw"];
    expect(withoutPublication).toMatchObject([{ sourceUpdatedAt: null }]);
  });

  it("ranks active utility incidents before roads and retains source records only on partial refresh", () => {
    const values = { destination: [record("road", "digitraffic", "road-closure"), record("planned", "eac-power", "power-outage", "planned"),
      record("power", "enemalta-power", "power-outage"), record("water", "krisinformation-infrastructure", "water-supply-disruption")] };
    expect(rankInfrastructure(values)).toBe(1);
    expect(values.destination.map(({ id }) => id)).toEqual(["power", "water", "road"]);
    expect(mergeInfrastructure([record("old", "digitraffic", "road-closure")], [], "digitraffic", false)).toHaveLength(1);
    expect(mergeInfrastructure([record("old", "digitraffic", "road-closure")], [], "digitraffic", true)).toEqual([]);
  });

  it("migrates Digitraffic to V12, projects it back to V11, and never changes alerts", () => {
    const current = createEmptyState(now); const before = buildSnapshot(current, now);
    current.conditions.locations["fi-helsinki"] = { ...emptyConditions(), infrastructureIncidents: [record("fi", "digitraffic", "road-closure")] };
    current.conditions.health["ndw-traffic"] = { checkedAt: iso, status: "ok", matched: 1, code: null };
    const v11 = downgradeIngestionStateV12(projectLegacyState(current));
    expect(v11.schemaVersion).toBe(11);
    expect(v11.conditions.locations["fi-helsinki"].disruptions).toMatchObject([{ kind: "road-closed" }]);
    expect(v11.conditions.health).not.toHaveProperty("ndw-traffic");
    const v12 = parseIngestionState(v11);
    expect(v12.conditions.locations["fi-helsinki"].infrastructureIncidents).toMatchObject([{ kind: "road-closure", status: "active" }]);
    expect(buildSnapshot(parseCatalogState(v12), now)).toEqual(before);
  });

  it("rejects V1 country files and malformed incident combinations", () => {
    expect(() => ConditionsSchema.parse({ schemaVersion: 1 })).toThrow();
    const invalid = record("bad", "digitraffic", "road-closure", "planned"); invalid.startsAt = "2026-08-31T16:00:00.000Z";
    const state = createEmptyState(now); state.conditions.locations["fi-helsinki"] = { ...emptyConditions(), infrastructureIncidents: [invalid] };
    expect(() => ConditionsSchema.parse({ schemaVersion: 2, catalogVersion: 2, countryCode: "FI", generatedAt: iso, producerCommitSha: null,
      sources: {}, sourceHealth: {}, locations: { "fi-helsinki": state.conditions.locations["fi-helsinki"] } })).toThrow(/Invalid infrastructure/);

    const wrongSourceKind = record("wrong-kind", "eac-power", "road-closure");
    expect(() => ConditionsSchema.parse({ schemaVersion: 2, catalogVersion: 2, countryCode: "FI", generatedAt: iso, producerCommitSha: null,
      sources: { "eac-power": { name: "Electricity Authority of Cyprus", officialUrl: "https://www.eac.com.cy/", license: "Official source", licenseUrl: "https://www.eac.com.cy/", notice: "Official factual context." } },
      sourceHealth: {}, locations: { "fi-helsinki": { ...emptyConditions(), infrastructureIncidents: [wrongSourceKind] } } })).toThrow(/Invalid infrastructure/);

    const futureActive = record("future-active", "digitraffic", "road-closure");
    futureActive.startsAt = "2026-08-31T18:00:00.000Z";
    expect(() => ConditionsSchema.parse({ schemaVersion: 2, catalogVersion: 2, countryCode: "FI", generatedAt: iso, producerCommitSha: null,
      sources: { digitraffic: { name: "Fintraffic", officialUrl: "https://www.digitraffic.fi/", license: "Open source", licenseUrl: "https://www.digitraffic.fi/", notice: "Official factual context." } },
      sourceHealth: {}, locations: { "fi-helsinki": { ...emptyConditions(), infrastructureIncidents: [futureActive] } } })).toThrow(/Invalid infrastructure/);
  });
});


it("ages the displayed timing of a planned closure without rewriting source confirmation", () => {
  const planned = record("planned", "autobahn-traffic", "road-closure", "planned");
  const value = { ...emptyConditions(), infrastructureIncidents: [planned] };
  for (const [at, expected] of [["2026-08-31T17:59:59Z", "planned"], ["2026-08-31T18:00:00Z", "active"], ["2026-08-31T18:30:00Z", "active"]] as const) {
    const current = currentConditions(value, new Date(at)).infrastructureIncidents[0];
    expect(infrastructureTiming(current, new Date(at))).toBe(expected);
    expect(current).toEqual(planned);
  }
  const state = createEmptyState(now);
  state.conditions.locations["de-berlin"] = value;
  expect(() => buildConditionsFiles(state, new Date("2026-08-31T18:30:00Z"), { LOCAL_CONDITIONS_ENABLED: "true" })).not.toThrow();
  expect(currentConditions(value, new Date(planned.expiresAt)).infrastructureIncidents).toEqual([]);
});

it("rejects NDW envelope and record drift while accepting a genuine empty publication", async () => {
  const amsterdam = location("nl-amsterdam");
  const xml = `<d2LogicalModel><payloadPublication type="SituationPublication"><publicationTime>${iso}</publicationTime><situation><headerInformation><informationStatus>real</informationStatus></headerInformation><situationRecord id="ndw-1" type="Accident"><situationRecordCreationTime>${iso}</situationRecordCreationTime><probabilityOfOccurrence>certain</probabilityOfOccurrence><roadOrCarriagewayOrLaneManagementType>roadClosed</roadOrCarriagewayOrLaneManagementType><validity><validityStatus>active</validityStatus><validityTimeSpecification><overallStartTime>${iso}</overallStartTime><overallEndTime>2026-08-31T19:45:00Z</overallEndTime></validityTimeSpecification></validity><location><latitude>${amsterdam.centroid[1]}</latitude><longitude>${amsterdam.centroid[0]}</longitude></location></situationRecord></situation></payloadPublication></d2LogicalModel>`;
  const initial = parseNdwInfrastructure(xml, now).locations[amsterdam.id];
  expect(initial).toHaveLength(1);
  const empty = `<d2LogicalModel><payloadPublication type="SituationPublication"><publicationTime>${iso}</publicationTime></payloadPublication></d2LogicalModel>`;
  expect(parseNdwInfrastructure(empty, now).locations[amsterdam.id]).toEqual([]);
  for (const malformed of ["<html>Unavailable</html>", xml.replaceAll("situationRecord", "record"), xml.replace('id="ndw-1"', '')]) {
    expect(() => parseNdwInfrastructure(malformed, now)).toThrow();
    const state = createEmptyState(now);
    state.conditions.locations[amsterdam.id] = { ...emptyConditions(), infrastructureIncidents: initial };
    const store = new MemoryStateStore(state);
    const result = await runConditions({ now: new Date(now.getTime() + 3600000), stateStore: store,
      env: { LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "ndw-traffic").join(",") },
      fetch: async () => new Response(gzipSync(malformed)),
      publish: async (files) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] }),
    });
    expect(result.sources?.["ndw-traffic"]?.status).toBe("failed");
    expect((await store.read()).data.conditions.locations[amsterdam.id].infrastructureIncidents).toEqual(initial);
  }
});
