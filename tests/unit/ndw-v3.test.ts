import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseNdwInfrastructure } from "@/lib/conditions/infrastructure";
import { runConditions } from "@/lib/conditions/worker";
import { conditionSourceIds, emptyConditions } from "@/lib/domain/conditions";
import { createEmptyState } from "@/lib/risk";
import { MemoryStateStore } from "@/lib/storage";

const now = new Date("2026-09-08T07:50:00Z");
const closures = readFileSync("tests/fixtures/conditions/ndw-v3-closures.xml", "utf8");
const srti = readFileSync("tests/fixtures/conditions/ndw-v3-srti.xml", "utf8");
const maintenance = readFileSync("tests/fixtures/conditions/ndw-v3-maintenance.xml", "utf8");
const records = (xml: string) => Object.values(parseNdwInfrastructure(xml, now).locations).flat();
const publicationAt = (at: string) => closures.replace(/<com:publicationTime>.*?<\/com:publicationTime>/, `<com:publicationTime>${at}</com:publicationTime>`);
const withPeriod = (period: string) => closures.replace("</com:validityTimeSpecification>", `${period}</com:validityTimeSpecification>`);

describe("NDW DATEX 3 transport contract", () => {
  it("maps the real WGS84 line closure to Rotterdam while excluding the real maintenance vehicle warning", () => {
    expect(parseNdwInfrastructure(closures, now).locations["nl-rotterdam"]).toMatchObject([
      { id: "ndw:NDW14_SRV-RTM-106027_23_CLOSURE1", sourceId: "ndw-traffic", kind: "road-closure", status: "active",
        startsAt: "2026-09-07T20:01:06.000Z", checkedAt: now.toISOString() },
    ]);
    expect(records(srti)).toEqual([]);
    expect(records(maintenance)).toEqual([]);
  });
  it("accepts an unprefixed publication QName and a genuinely empty fresh publication", () => {
    expect(records(closures.replace('xsi:type="sit:SituationPublication"', 'xsi:type="SituationPublication"'))).toEqual(records(closures));
    expect(records(closures.replace(/<sit:situation id=.*?<\/sit:situation>/s, ""))).toEqual([]);
  });
  it.each([
    ["invalid XML", closures.slice(0, -20)],
    ["wrong payload type", closures.replace("sit:SituationPublication", "sit:MeasuredDataPublication")],
    ["wrong container version", closures.replace('modelBaseVersion="3"', 'modelBaseVersion="2"')],
    ["wrong payload version", closures.replace('lang="nl" modelBaseVersion="3"', 'lang="nl" modelBaseVersion="2"')],
    ["missing payload", closures.replace(/<mc:payload.*?<\/mc:payload>/s, "")],
    ["multiple payloads", closures.replace("</mc:messageContainer>", `${closures.match(/<mc:payload.*?<\/mc:payload>/s)![0]}</mc:messageContainer>`)],
    ["missing publication clock", closures.replace(/<com:publicationTime>.*?<\/com:publicationTime>/, "")],
    ["invalid clock", publicationAt("not-a-date")],
    ["entity declaration", '<!DOCTYPE x [<!ENTITY foo "bar">]>' + closures],
  ])("rejects %s", (_name, xml) => {
    expect(() => parseNdwInfrastructure(xml, now)).toThrow();
  });
  it.each([
    ["2026-09-08T05:50:00Z", false], ["2026-09-08T05:50:00.001Z", true],
    ["2026-09-08T07:55:00Z", true], ["2026-09-08T07:55:00.001Z", false],
  ])("enforces publication freshness at %s", (at, accepted) => {
    if (accepted) expect(records(publicationAt(at))).not.toHaveLength(0);
    else expect(() => parseNdwInfrastructure(publicationAt(at), now)).toThrow(/Stale/);
  });
  it.each([
    ["test", closures.replace("<com:informationStatus>real", "<com:informationStatus>test")],
    ["private", closures.replace("<com:confidentiality>noRestriction", "<com:confidentiality>restrictedToAuthorities")],
    ["missing confidentiality", closures.replace("<com:confidentiality>noRestriction</com:confidentiality>", "")],
    ["construction", closures.replace("<sit:operatorActionStatus>", "<sit:cause><sit:causeType>constructionWork</sit:causeType></sit:cause><sit:operatorActionStatus>")],
    ["maintenance", closures.replace("<sit:operatorActionStatus>", "<sit:cause><sit:causeType>roadMaintenance</sit:causeType></sit:cause><sit:operatorActionStatus>")],
    ["ambiguous described cause", closures.replace("<sit:operatorActionStatus>", "<sit:cause><sit:causeType>other</sit:causeType><sit:causeDescription>Works</sit:causeDescription></sit:cause><sit:operatorActionStatus>")],
  ])("excludes %s records", (_name, xml) => { expect(records(xml)).toEqual([]); });
  it("keeps public non-maintenance vehicle warnings", () => {
    const publicObstruction = srti.replace("constructionOrMaintenanceVehicle", "car");
    expect(records(publicObstruction)).toContainEqual(expect.objectContaining({ kind: "road-disruption" }));
  });
  it("accepts a period identical to the overall validity and rejects narrower or unsupported schedules", () => {
    expect(records(withPeriod("<com:validPeriod><com:startOfPeriod>2026-09-07T20:01:06Z</com:startOfPeriod></com:validPeriod>"))).toEqual(records(closures));
    for (const period of [
      "<com:validPeriod><com:startOfPeriod>2026-09-08T20:00:00Z</com:startOfPeriod></com:validPeriod>",
      "<com:validPeriod><com:startOfPeriod>2026-09-07T20:01:06Z</com:startOfPeriod><com:endOfPeriod>2026-09-08T08:00:00Z</com:endOfPeriod></com:validPeriod>",
      "<com:validPeriod><com:startOfPeriod>2026-09-07T20:01:06Z</com:startOfPeriod><com:recurringTimePeriodOfDay>night</com:recurringTimePeriodOfDay></com:validPeriod>",
      "<com:exceptionPeriod><com:startOfPeriod>2026-09-08T07:00:00Z</com:startOfPeriod></com:exceptionPeriod>",
    ]) expect(() => parseNdwInfrastructure(withPeriod(period), now)).toThrow();
  });
  it("retains a valid prior closure after a stale DATEX 3 refresh fails", async () => {
    const initial = parseNdwInfrastructure(closures, now).locations["nl-rotterdam"];
    const state = createEmptyState(now);
    state.conditions.locations["nl-rotterdam"] = { ...emptyConditions(), infrastructureIncidents: initial };
    const store = new MemoryStateStore(state);
    const result = await runConditions({ now, stateStore: store,
      env: { LOCAL_CONDITIONS_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) => id !== "ndw-traffic").join(",") },
      fetch: async () => new Response(gzipSync(publicationAt("2026-09-08T05:50:00Z"))),
      publish: async (files) => ({ published: files.map(({ countryCode }) => countryCode), unchanged: [], failed: [] }),
    });
    expect(result.sources?.["ndw-traffic"]?.status).toBe("failed");
    expect((await store.read()).data.conditions.locations["nl-rotterdam"].infrastructureIncidents).toEqual(initial);
  });
});
