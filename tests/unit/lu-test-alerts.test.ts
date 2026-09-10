import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locations } from "@/lib/data";
import { createEmptyState } from "@/lib/risk";
import { fetchLuPartition, parseLuCap } from "@/lib/ingestion/adapters/national-civil-alerts-lu";

const xml = readFileSync("tests/fixtures/providers/lu-alert-test-cap.xml", "utf8");
const now = new Date("2026-09-07T09:30:00Z");
const context = { now, locations, fetch };
const marker = "urn:oasis:names:tc:emergency:cap:1.2:profile:cap-lu:1.0:cb-eu-level";
const liveXml = readFileSync("tests/fixtures/providers/lu-alert-cap.xml", "utf8")
  .replaceAll("2026-08-28", "2026-09-07").replaceAll("T10:00:00+02:00", "T20:00:00+02:00");

describe("LU structured test messages", () => {
  it.each([
    liveXml.replace("English public alert", "TEST equipment failure is causing a real public emergency"),
    liveXml.replaceAll("</info>", "<parameter><valueName>unrelated-parameter</valueName><value>TEST</value></parameter></info>"),
  ])("retains valid production alerts when TEST occurs outside the designated parameter", (record) => {
    const parsed = parseLuCap(record, context);
    expect(parsed.ignored).toBe(false);
    expect(parsed.events).toHaveLength(5);
    expect(parsed.events.map(({ id }) => id)).toEqual(parseLuCap(liveXml, context).events.map(({ id }) => id));
    expect(parsed.events.every(({ level }) => level === "HIGH")).toBe(true);
  });

  it("accepts repeated identical TEST markers in every language block", () => {
    const duplicate = xml.replaceAll("</info>", `<parameter><valueName>${marker}</valueName><value>TEST</value></parameter></info>`);
    expect(parseLuCap(duplicate, context)).toMatchObject({ ignored: true, references: [], events: [], affectedIds: [] });
  });

  it("rejects inconsistent TEST markers before a cancellation can remove referenced live alerts", () => {
    const cancellation = xml.replace("<msgType>Alert</msgType>", "<msgType>Cancel</msgType><references>sender,LU-Alert.fixture.1,2026-09-07T09:00:00Z</references>")
      .replace("<value>TEST</value>", "<value>ALERT</value>");
    expect(() => parseLuCap(cancellation, context)).toThrow("CAP-LU test markers are inconsistent");
  });
  it.each(["Alert", "Update", "Cancel", "Pause", "Resume"])("ignores the official multilingual %s test without lifecycle effects", (type) => {
    const record = xml.replace("<msgType>Alert</msgType>", `<msgType>${type}</msgType><references>sender,live-alert,2026-09-07T09:00:00Z</references>`);
    expect(parseLuCap(record, context)).toMatchObject({ ignored: true, references: [], events: [], affectedIds: [] });
  });

  it.each([
    xml.replace("<value>TEST</value>", "<value>ALERT</value>"),
    xml.replace(marker, "unrelated-parameter"),
    xml.replace("</info>", `<parameter><valueName>${marker}</valueName><value>ALERT</value></parameter></info>`),
    xml.replaceAll(marker, "unrelated-parameter"),
  ])("fails closed on inconsistent or absent structured test evidence", (record) => {
    expect(() => parseLuCap(record, context)).toThrow();
  });

  it("advances the partition watermark and retains live events after a test update", async () => {
    const state = createEmptyState(now);
    const live = parseLuCap(liveXml, context).events[0];
    expect(live).toBeDefined();
    state.events.push(live);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-09-07T09:00:00Z";
    const resource = { url: "https://download.data.public.lu/test.xml", last_modified: "2026-09-07T09:25:05Z", format: "xml" };
    const record = xml.replace("<msgType>Alert</msgType>", `<msgType>Update</msgType><references>sender,${live.id.split(":")[1]},2026-09-07T09:00:00Z</references>`);
    const result = await fetchLuPartition({ ...context, state, fetch: (async (url) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: resource.last_modified, resources: [resource] })
      : new Response(record)) as typeof fetch });
    expect(result).toMatchObject({ status: "ok", sourceUpdatedAt: "2026-09-07T09:25:05.000Z", events: [live], unavailableLocationIds: [] });
    expect(result.checkedLocationIds).toHaveLength(5);
  });

  it("retains live events and the prior watermark when a mixed-marker cancellation precedes a valid test resource", async () => {
    const state = createEmptyState(now);
    const live = parseLuCap(liveXml, context).events;
    state.events.push(...live);
    state.sourcePartitions.nationalCivilAlerts.LU.sourceUpdatedAt = "2026-09-07T09:00:00.000Z";
    const bad = xml.replace("<msgType>Alert</msgType>", "<msgType>Cancel</msgType><references>sender,LU-Alert.fixture.1,2026-09-07T09:00:00Z</references>")
      .replace("<value>TEST</value>", "<value>ALERT</value>");
    const resources = [
      { url: "https://download.data.public.lu/bad.xml", last_modified: "2026-09-07T09:25:05Z", format: "xml" },
      { url: "https://download.data.public.lu/good.xml", last_modified: "2026-09-07T09:26:05Z", format: "xml" },
    ];
    const result = await fetchLuPartition({ ...context, state, fetch: (async (url) => String(url).includes("api/1/datasets")
      ? Response.json({ last_update: "2026-09-07T09:26:05Z", resources })
      : new Response(String(url).endsWith("bad.xml") ? bad : xml)) as typeof fetch });
    expect(result).toMatchObject({ status: "partial", sourceUpdatedAt: "2026-09-07T09:00:00.000Z",
      events: live, removedEventPrefixes: [], checkedLocationIds: [], error: "1 CAP-LU resources were invalid" });
    expect(result.unavailableLocationIds).toEqual(locations.filter(({ countryCode }) => countryCode === "LU").map(({ id }) => id).sort());
  });
});
