import { describe, expect, it, vi } from "vitest";
import { MeteoAlarmAdapter, fetchMeteoAlarmCap, meteoAlarmFeedSlugs, meteoAlarmSupplementUrls, parseMeteoAlarmCapSupplement, parseMeteoAlarmFeed } from "@/lib/ingestion/adapters/meteoalarm";
import { eventAffectsLocation } from "@/lib/geospatial";
import { locations } from "@/lib/data";
import { createSourceDiagnostics } from "@/lib/ingestion/types";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<updated>2026-08-25T08:00:00Z</updated><entry><cap:geocode><valueName>NUTS2</valueName><value>HU33</value></cap:geocode>
<cap:areaDesc>Southern Great Plain</cap:areaDesc><cap:event>orange thunderstorm warning</cap:event><cap:sent>2026-08-25T08:00:00Z</cap:sent>
<cap:expires>2026-08-25T18:00:00Z</cap:expires><cap:onset>2026-08-25T10:00:00Z</cap:onset><cap:severity>Severe</cap:severity>
<cap:scope>Public</cap:scope><cap:message_type>Alert</cap:message_type><cap:status>Actual</cap:status><cap:identifier>alert-1</cap:identifier>
<link type="application/cap+xml" href="https://feeds.meteoalarm.org/example"/><id>alert-1</id><updated>2026-08-25T08:00:00Z</updated></entry></feed>`;

describe("MeteoAlarm adapter", () => {
  it("maps future orange CAP warnings to upcoming high risk", () => {
    const result = parseMeteoAlarmFeed(feed, "HU", new Date("2026-08-25T09:00:00Z"));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ level: "HIGH", timing: "UPCOMING", type: "severe-weather", geometry: { kind: "regions", codes: ["HU33", "area:southern great plain"] } });
  });

  it("prioritizes and reports events beyond the bounded partition limit", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const entries = Array.from({ length: 501 }, (_, index) => entry.replaceAll("alert-1", `alert-${index + 1}`)).join("");
    const oversized = feed.replace(entry, entries);
    const result = parseMeteoAlarmFeed(oversized, "HU", new Date("2026-08-25T09:00:00Z"));
    expect(result).toMatchObject({ recordsExamined: 501, overflow: true });
    expect(result.events).toHaveLength(500);
  });

  it("caps oversized Atom feeds at 2,000 prioritized records", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const entries = Array.from({ length: 2_001 }, (_, index) => entry.replaceAll("alert-1", `alert-${index + 1}`)).join("");
    const result = parseMeteoAlarmFeed(feed.replace(entry, entries), "HU", new Date("2026-08-25T09:00:00Z"));

    expect(result).toMatchObject({ recordsExamined: 2_001, overflow: true });
    expect(result.events).toHaveLength(500);
  });

  it("drops expired alerts", () => {
    const refreshed = feed.replace("2026-08-25T08:00:00Z", "2026-08-25T18:59:00Z");
    expect(parseMeteoAlarmFeed(refreshed, "HU", new Date("2026-08-25T19:00:00Z")).events).toHaveLength(0);
  });

  it("rejects a non-empty feed whose alerts expire before they start", () => {
    const invalid = feed.replace("2026-08-25T10:00:00Z", "2026-08-25T19:00:00Z");
    expect(() => parseMeteoAlarmFeed(invalid, "HU", new Date("2026-08-25T09:00:00Z"))).toThrow(/no parseable/);
  });

  it("rejects malformed XML without a feed", () => {
    expect(() => parseMeteoAlarmFeed("<not-feed />", "HU", new Date())).toThrow();
  });

  it.each([
    ["stale", "2026-08-25T06:59:59Z"],
    ["future-dated", "2026-08-25T09:05:01Z"],
  ])("rejects a %s feed update time", (_label, updated) => {
    const invalid = feed.replace("2026-08-25T08:00:00Z", updated);
    expect(() => parseMeteoAlarmFeed(invalid, "HU", new Date("2026-08-25T09:00:00Z"))).toThrow(/stale, or future-dated/);
  });

  it("retains an active warning when a later country feed is stale", async () => {
    const now = new Date("2026-08-25T09:00:00Z");
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const first = await new MeteoAlarmAdapter().fetch({
      now, locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? feed : empty)) as typeof fetch,
    });
    const state = mergeSourceResults(createEmptyState(now), [first], now);
    const stale = feed.replace("2026-08-25T08:00:00Z", "2026-08-25T06:00:00Z");
    const second = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:10:00Z"), locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? stale : empty)) as typeof fetch,
    });
    const merged = mergeSourceResults(state, [second], new Date("2026-08-25T09:10:00Z"));

    expect(second.partitions.HU).toMatchObject({ status: "failed", events: [], error: expect.stringMatching(/stale/) });
    expect(merged.events).toMatchObject([{ sourceId: "meteoalarm", id: expect.stringContaining("alert-1") }]);
  });

  it("does not treat a country ISO geocode as country-wide when a regional code is also present", () => {
    const mixed = feed.replace("<cap:geocode><valueName>NUTS2</valueName><value>HU33</value></cap:geocode>", "<cap:geocode><valueName>ISO</valueName><value>HU</value></cap:geocode><cap:geocode><valueName>NUTS2</valueName><value>HU33</value></cap:geocode>");
    const event = parseMeteoAlarmFeed(mixed, "HU", new Date("2026-08-25T09:00:00Z")).events[0];
    expect(event.geometry.kind === "regions" && event.geometry.codes).toEqual(["HU", "HU33", "area:southern great plain"]);
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-budapest")!)).toBe(false);
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-debrecen")!)).toBe(false);
  });

  it("matches the whole country only when the feed uses an explicit country geocode", () => {
    const countryWide = feed.replace("HU33", "country").replace("Southern Great Plain", "Hungary");
    const event = parseMeteoAlarmFeed(countryWide, "HU", new Date("2026-08-25T09:00:00Z")).events[0];
    expect(event.geometry.kind === "regions" && event.geometry.codes).toEqual(["HU:country", "area:hungary"]);
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-budapest")!)).toBe(true);
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-debrecen")!)).toBe(true);
  });

  it("counts destinations matched by regional warning geometry", async () => {
    const countryWide = feed.replace("HU33", "country").replace("Southern Great Plain", "Hungary");
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const diagnostics = createSourceDiagnostics();
    await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations, diagnostics,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? countryWide : empty)) as typeof fetch,
    });

    expect(diagnostics.matchedLocations).toBe(locations.filter(({ countryCode }) => countryCode === "HU").length);
  });

  it("does not promote an ISO-only geocode to a country-wide HU:country match", () => {
    const isoOnly = feed.replace("HU33", "HU").replace("Southern Great Plain", "Hungary");
    const event = parseMeteoAlarmFeed(isoOnly, "HU", new Date("2026-08-25T09:00:00Z")).events[0];
    expect(event.geometry.kind === "regions" && event.geometry.codes).toEqual(["HU", "area:hungary"]);
    expect(event.geometry.kind === "regions" && event.geometry.codes).not.toContain("HU:country");
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-budapest")!)).toBe(false);
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-debrecen")!)).toBe(false);
  });

  it("rejects a non-empty feed whose alerts have no usable area", () => {
    const withoutCodeOrArea = feed.replace(/<cap:geocode>[\s\S]*?<\/cap:geocode>/, "").replace("<cap:areaDesc>Southern Great Plain</cap:areaDesc>", "");
    expect(() => parseMeteoAlarmFeed(withoutCodeOrArea, "HU", new Date("2026-08-25T09:00:00Z"))).toThrow(/no parseable/);
  });

  it("matches a provider area label when its code scheme differs from the catalog", () => {
    const budapestFeed = feed.replace("HU33", "HU999").replace("Southern Great Plain", "Budapest");
    const event = parseMeteoAlarmFeed(budapestFeed, "HU", new Date("2026-08-25T09:00:00Z")).events[0];
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-budapest")!)).toBe(true);
    expect(eventAffectsLocation(event, locations.find((location) => location.id === "hu-debrecen")!)).toBe(false);
  });

  it("bounds unusually long provider area descriptions without failing the country feed", async () => {
    const longArea = Array.from({ length: 60 }, (_, index) => `District ${index + 1}`).join(", ");
    const longAreaFeed = feed.replace("Southern Great Plain", longArea);
    const emptyFeed = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? longAreaFeed : emptyFeed)) as typeof fetch,
    });

    expect(result.partitions.HU.status).toBe("ok");
    expect(result.partitions.HU.events[0].headline.length).toBeLessThanOrEqual(180);
    expect(result.partitions.HU.events[0].explanation.length).toBeLessThanOrEqual(500);
    expect(result.partitions.HU.events[0].affectedArea.length).toBeLessThanOrEqual(200);
    expect(result.partitions.HU.events[0].headline).toMatch(/…$/);
    expect(result.partitions.HU.events[0].explanation).toMatch(/…$/);
    expect(result.partitions.HU.events[0].affectedArea).toMatch(/…$/);
  });

  it("rejects a non-empty feed with no structured severity", () => {
    const missingSeverity = feed.replace("orange thunderstorm warning", "Extreme thunderstorm warning").replace("<cap:severity>Severe</cap:severity>", "");
    expect(() => parseMeteoAlarmFeed(missingSeverity, "HU", new Date("2026-08-25T09:00:00Z"))).toThrow(/no parseable/);
  });

  it.each(["Minor", "Unknown"])("treats %s advisories as valid non-risk records", async (severity) => {
    const advisory = feed.replace("<cap:severity>Severe</cap:severity>", `<cap:severity>${severity}</cap:severity>`);
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-germany") ? advisory : empty)) as typeof fetch,
    });

    expect(result.partitions.DE).toMatchObject({ status: "ok", events: [], error: null });
  });

  it("caps wildfire warnings at high without structured emergency instructions", () => {
    const wildfire = feed.replace("orange thunderstorm warning", "Extreme wildfire warning").replace("<cap:severity>Severe</cap:severity>", "<cap:severity>Extreme</cap:severity>");
    expect(parseMeteoAlarmFeed(wildfire, "HU", new Date("2026-08-25T09:00:00Z")).events[0]).toMatchObject({ type: "wildfire", level: "HIGH" });
  });

  it("promotes an extreme wildfire warning with evacuation instructions to severe", () => {
    const wildfire = feed
      .replace("orange thunderstorm warning", "Extreme wildfire warning")
      .replace("<cap:severity>Severe</cap:severity>", "<cap:severity>Extreme</cap:severity><cap:instruction>Evacuate immediately.</cap:instruction>");
    expect(parseMeteoAlarmFeed(wildfire, "HU", new Date("2026-08-25T09:00:00Z")).events[0]).toMatchObject({ type: "wildfire", level: "SEVERE" });
  });

  it("uses structured CAP detail instructions for wildfire emergency severity", () => {
    const wildfire = feed.replace("orange thunderstorm warning", "Extreme wildfire warning").replace("<cap:severity>Severe</cap:severity>", "<cap:severity>Extreme</cap:severity>");
    const supplement = parseMeteoAlarmCapSupplement(`<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><info><instruction>Leave the area now.</instruction></info></alert>`);
    const supplements = new Map([["https://feeds.meteoalarm.org/example", supplement]]);
    expect(parseMeteoAlarmFeed(wildfire, "HU", new Date("2026-08-25T09:00:00Z"), supplements).events[0].level).toBe("SEVERE");
  });

  it("removes an alert superseded by a cancellation", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const cancellation = entry
      .replaceAll("alert-1", "cancel-1")
      .replace("<cap:message_type>Alert</cap:message_type>", "<cap:message_type>Cancel</cap:message_type><cap:references>sender,alert-1,2026-08-25T08:00:00Z</cap:references>");
    const withCancellation = feed.replace("</feed>", `${cancellation}</feed>`);
    const parsed = parseMeteoAlarmFeed(withCancellation, "HU", new Date("2026-08-25T09:00:00Z"));
    expect(parsed.events).toHaveLength(0);
    expect(parsed.supersededIdentifiers).toEqual(["alert-1"]);
  });

  it("keeps only the latest update in a CAP lifecycle", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const update = entry
      .replaceAll("alert-1", "update-1")
      .replace("<cap:message_type>Alert</cap:message_type>", "<cap:message_type>Update</cap:message_type><cap:references>sender,alert-1,2026-08-25T08:00:00Z</cap:references>")
      .replace("<cap:severity>Severe</cap:severity>", "<cap:severity>Moderate</cap:severity>");
    const withUpdate = feed.replace("</feed>", `${update}</feed>`);
    expect(parseMeteoAlarmFeed(withUpdate, "HU", new Date("2026-08-25T09:00:00Z")).events).toMatchObject([{ level: "ELEVATED" }]);
  });

  it("retains the last valid alert when a referencing update is malformed", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const update = entry
      .replaceAll("alert-1", "update-1")
      .replace("<cap:message_type>Alert</cap:message_type>", "<cap:message_type>Update</cap:message_type><cap:references>sender,alert-1,2026-08-25T08:00:00Z</cap:references>")
      .replace("<cap:severity>Severe</cap:severity>", "");
    const withMalformedUpdate = feed.replace("</feed>", `${update}</feed>`);
    expect(parseMeteoAlarmFeed(withMalformedUpdate, "HU", new Date("2026-08-25T09:00:00Z")).events).toMatchObject([{ id: expect.stringContaining("alert-1") }]);
  });

  it("applies cancellation references from the linked CAP detail", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const cancellation = entry.replaceAll("alert-1", "cancel-1").replace("<cap:message_type>Alert</cap:message_type>", "<cap:message_type>Cancel</cap:message_type>");
    const withCancellation = feed.replace("</feed>", `${cancellation}</feed>`);
    const supplement = parseMeteoAlarmCapSupplement(`<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><references>sender,alert-1,2026-08-25T08:00:00Z</references></alert>`);
    const supplements = new Map([["https://feeds.meteoalarm.org/example", supplement]]);
    expect(parseMeteoAlarmFeed(withCancellation, "HU", new Date("2026-08-25T09:00:00Z"), supplements).events).toHaveLength(0);
  });

  it("fetches lifecycle supplements only when Atom omits references", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const cancellation = entry
      .replaceAll("alert-1", "cancel-1")
      .replace("<cap:message_type>Alert</cap:message_type>", "<cap:message_type>Cancel</cap:message_type>");
    const withInlineReference = cancellation.replace(
      "<cap:message_type>Cancel</cap:message_type>",
      "<cap:message_type>Cancel</cap:message_type><cap:references>sender,alert-1,2026-08-25T08:00:00Z</cap:references>",
    );

    const checkedAt = new Date("2026-08-25T09:00:00Z");
    expect(meteoAlarmSupplementUrls(feed.replace(entry, cancellation), checkedAt)).toEqual(["https://feeds.meteoalarm.org/example"]);
    expect(meteoAlarmSupplementUrls(feed.replace(entry, withInlineReference), checkedAt)).toEqual([]);
    const expiredUpdate = cancellation.replace("<cap:message_type>Cancel</cap:message_type>", "<cap:message_type>Update</cap:message_type>");
    const refreshed = feed.replace("2026-08-25T08:00:00Z", "2026-08-25T18:59:00Z").replace(entry, expiredUpdate);
    expect(meteoAlarmSupplementUrls(refreshed, new Date("2026-08-25T19:00:00Z"))).toEqual([]);
  });

  it("follows CAP redirects only while they remain on the MeteoAlarm allowlist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/final" } }))
      .mockResolvedValueOnce(new Response("<alert />", { status: 200 }));
    expect(await (await fetchMeteoAlarmCap(fetchMock as typeof fetch, "https://feeds.meteoalarm.org/cap/start")).text()).toBe("<alert />");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://feeds.meteoalarm.org/cap/final", expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects CAP redirects to a non-allowlisted host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } }));
    await expect(fetchMeteoAlarmCap(fetchMock as typeof fetch, "https://feeds.meteoalarm.org/cap/start")).rejects.toThrow(/allowlisted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch an initial CAP URL that is not HTTPS-allowlisted", async () => {
    const fetchMock = vi.fn();
    await expect(fetchMeteoAlarmCap(fetchMock as typeof fetch, "http://feeds.meteoalarm.org/cap")).rejects.toThrow(/allowlisted/);
    await expect(fetchMeteoAlarmCap(fetchMock as typeof fetch, "https://example.invalid/cap")).rejects.toThrow(/allowlisted/);
    await expect(fetchMeteoAlarmCap(fetchMock as typeof fetch, "not-a-url")).rejects.toThrow(/allowlisted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a CAP redirect that has no Location header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    await expect(fetchMeteoAlarmCap(fetchMock as typeof fetch, "https://feeds.meteoalarm.org/cap/start")).rejects.toThrow(/location/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a CAP response after three on-allowlist redirects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/3" } }))
      .mockResolvedValueOnce(new Response("<alert />", { status: 200 }));
    expect(await (await fetchMeteoAlarmCap(fetchMock as typeof fetch, "https://feeds.meteoalarm.org/cap/start")).text()).toBe("<alert />");
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://feeds.meteoalarm.org/cap/start",
      "https://feeds.meteoalarm.org/cap/1",
      "https://feeds.meteoalarm.org/cap/2",
      "https://feeds.meteoalarm.org/cap/3",
    ]);
  });

  it("rejects a fourth on-allowlist CAP redirect", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/3" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/cap/4" } }));
    await expect(fetchMeteoAlarmCap(fetchMock as typeof fetch, "https://feeds.meteoalarm.org/cap/start")).rejects.toThrow(/limit/i);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://feeds.meteoalarm.org/cap/start",
      "https://feeds.meteoalarm.org/cap/1",
      "https://feeds.meteoalarm.org/cap/2",
      "https://feeds.meteoalarm.org/cap/3",
    ]);
  });

  it("recognizes MeteoAlarm high- and low-temperature vocabulary", () => {
    const high = feed.replace("orange thunderstorm warning", "Orange High-temperature Warning");
    const low = feed.replace("orange thunderstorm warning", "Low-temperature Warning");
    expect(parseMeteoAlarmFeed(high, "HU", new Date("2026-08-25T09:00:00Z")).events[0].type).toBe("extreme-heat");
    expect(parseMeteoAlarmFeed(low, "HU", new Date("2026-08-25T09:00:00Z")).events[0].type).toBe("extreme-cold");
  });

  it("keeps heavy rain and thunderstorms distinct from confirmed flooding", () => {
    const rain = feed.replace("orange thunderstorm warning", "Heavy rain and thunderstorm warning");
    expect(parseMeteoAlarmFeed(rain, "HU", new Date("2026-08-25T09:00:00Z")).events[0].type).toBe("severe-weather");
  });

  it("retains distinct regions that share a provider alert identifier", () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const second = entry.replace("HU33", "HU31").replace("Southern Great Plain", "Central Hungary");
    const multiRegion = feed.replace("</feed>", `${second}</feed>`);
    const events = parseMeteoAlarmFeed(multiRegion, "HU", new Date("2026-08-25T09:00:00Z")).events;
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    expect(events.map((event) => event.geometry.kind === "regions" ? event.geometry.codes[0] : null)).toEqual(["HU33", "HU31"]);
  });

  it("isolates a structurally valid but unparseable country feed while keeping the other 27 successful", async () => {
    const emptyFeed = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const invalidAlert = feed.replace("<cap:severity>Severe</cap:severity>", "");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.endsWith("-switzerland") ? invalidAlert : emptyFeed, { status: 200 });
    });
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch,
    });
    expect(Object.keys(result.partitions)).toHaveLength(28);
    expect(result.partitions.CH.status).toBe("failed");
    expect(Object.values(result.partitions).filter((partition) => partition.status === "ok")).toHaveLength(27);
  });

  it("accepts a country feed above two MiB while preserving the global run budget", async () => {
    const emptyFeed = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(emptyFeed, {
      status: 200,
      headers: String(input).endsWith("-germany") ? { "content-length": String(3 * 1024 * 1024) } : {},
    }));

    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch,
    });

    expect(result.partitions.DE).toMatchObject({ status: "ok", error: null });
    expect(Object.values(result.partitions).every((partition) => partition.status === "ok")).toBe(true);
  });

  it("does not exhaust the CAP queue on lifecycle records with inline references", async () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const cancellations = Array.from({ length: 300 }, (_, index) => entry
      .replaceAll("alert-1", `cancel-${index}`)
      .replace("https://feeds.meteoalarm.org/example", `https://feeds.meteoalarm.org/cap/${index}`)
      .replace(
        "<cap:message_type>Alert</cap:message_type>",
        `<cap:message_type>Cancel</cap:message_type><cap:references>sender,alert-${index},2026-08-25T08:00:00Z</cap:references>`,
      )).join("");
    const cancellationFeed = feed.replace(entry, cancellations);
    const emptyFeed = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
      String(input).endsWith("-hungary") ? cancellationFeed : emptyFeed,
      { status: 200 },
    ));

    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch,
    });

    expect(result.partitions.HU).toMatchObject({ status: "ok", error: null });
    expect(fetchMock.mock.calls).toHaveLength(28);
  });

  it("marks a mixed-validity country feed partial", async () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const invalid = entry.replaceAll("alert-1", "broken-2").replace("2026-08-25T10:00:00Z", "2026-08-25T19:00:00Z");
    const mixed = feed.replace("</feed>", `${invalid}</feed>`);
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? mixed : empty)) as typeof fetch,
    });

    expect(result.partitions.HU).toMatchObject({ status: "partial", error: "1 MeteoAlarm records were invalid" });
    expect(result.partitions.HU.events).toHaveLength(1);
  });

  it("keeps valid country warnings when a sibling has a malformed update time", async () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const invalid = entry.replaceAll("alert-1", "broken-2").replace("<updated>2026-08-25T08:00:00Z</updated>", "<updated>not-a-date</updated>");
    const mixed = feed.replace("</feed>", `${invalid}</feed>`);
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? mixed : empty)) as typeof fetch,
    });

    expect(result.partitions.HU).toMatchObject({ status: "partial", error: "1 MeteoAlarm records were invalid" });
    expect(result.partitions.HU.events.map((event) => event.id)).toEqual([expect.stringContaining("alert-1")]);
  });

  it("preserves cancellation removals when an unrelated record makes the country partial", async () => {
    const entry = feed.match(/<entry>[\s\S]*<\/entry>/)![0];
    const cancellation = entry
      .replaceAll("alert-1", "cancel-1")
      .replace("<cap:message_type>Alert</cap:message_type>", "<cap:message_type>Cancel</cap:message_type><cap:references>sender,alert-1,2026-08-25T08:00:00Z</cap:references>");
    const invalid = entry.replaceAll("alert-1", "broken-2").replace("2026-08-25T10:00:00Z", "2026-08-25T19:00:00Z");
    const mixed = feed.replace("</feed>", `${cancellation}${invalid}</feed>`);
    const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations,
      fetch: (async (input: string | URL | Request) => new Response(String(input).endsWith("-hungary") ? mixed : empty)) as typeof fetch,
    });

    expect(result.partitions.HU).toMatchObject({
      status: "partial", events: [], removedEventPrefixes: ["meteoalarm:alert-1:"],
    });
  });

  it("uses global bounded queues and deduplicates CAP URLs", async () => {
    let atomActive = 0;
    let atomMaximum = 0;
    let capActive = 0;
    let capMaximum = 0;
    const capCalls = new Map<string, number>();
    const slugToCountry = new Map(Object.entries(meteoAlarmFeedSlugs).map(([country, slug]) => [slug, country]));
    const countries = [...slugToCountry.values()];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("meteoalarm-legacy-atom-")) {
        atomActive += 1;
        atomMaximum = Math.max(atomMaximum, atomActive);
        await new Promise((resolve) => setTimeout(resolve, 2));
        atomActive -= 1;
        const slug = url.split("meteoalarm-legacy-atom-")[1];
        const country = slugToCountry.get(slug)!;
        const capUrl = `https://feeds.meteoalarm.org/cap/group-${countries.indexOf(country) % 7}`;
        return new Response(feed
          .replaceAll("HU33", country)
          .replaceAll("alert-1", `alert-${country}`)
          .replace("orange thunderstorm warning", "Extreme wildfire warning")
          .replace("<cap:severity>Severe</cap:severity>", "<cap:severity>Extreme</cap:severity>")
          .replace("https://feeds.meteoalarm.org/example", capUrl), { status: 200 });
      }
      capActive += 1;
      capMaximum = Math.max(capMaximum, capActive);
      capCalls.set(url, (capCalls.get(url) || 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 2));
      capActive -= 1;
      return new Response(`<alert><info><instruction>Check local advice.</instruction></info></alert>`, { status: 200 });
    });
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch,
    });
    expect(Object.values(result.partitions).every((partition) => partition.status === "ok")).toBe(true);
    expect(atomMaximum).toBeLessThanOrEqual(10);
    expect(capMaximum).toBeLessThanOrEqual(4);
    expect(capCalls.size).toBe(7);
    expect([...capCalls.values()].every((calls) => calls === 1)).toBe(true);
    const atomUrls = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("meteoalarm-legacy-atom-"));
    expect(atomUrls).toHaveLength(28);
    expect(atomUrls.every((url) => /^https:\/\/feeds\.meteoalarm\.org\/feeds\/meteoalarm-legacy-atom-[a-z-]+$/.test(url))).toBe(true);
    expect(atomUrls.some((url) => url.includes("-rss-") || url.includes("api.meteoalarm.org"))).toBe(false);
  });

  it("keeps country feeds successful when optional CAP details fail", async () => {
    const wildfire = feed
      .replace("orange thunderstorm warning", "Extreme wildfire warning")
      .replace("<cap:severity>Severe</cap:severity>", "<cap:severity>Extreme</cap:severity>");
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input).includes("meteoalarm-legacy-atom-")
        ? new Response(wildfire, { status: 200 })
        : new Response("unavailable", { status: 503 })
    ));
    const result = await new MeteoAlarmAdapter().fetch({
      now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch,
    });
    expect(Object.values(result.partitions).every((partition) => partition.status === "ok")).toBe(true);
    expect(Object.values(result.partitions).flatMap((partition) => partition.events).every((event) => event.level === "HIGH")).toBe(true);
  });

  it("does not call IFRC when every primary country feed parses successfully", async () => {
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "true");
    try {
      const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        void input; void init;
        return new Response(empty, { status: 200 });
      });
      const result = await new MeteoAlarmAdapter().fetch({ now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch });
      expect(Object.values(result.partitions).every((partition) => partition.status === "ok")).toBe(true);
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("alerthub-api.ifrc.org"))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it("recovers only a failed primary partition through IFRC and keeps it partial", async () => {
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "true");
    try {
      const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
      const invalid = `<not-feed />`;
      const fallback = { data: { public: { DE: { items: [{
        sent: "2026-08-25T08:00:00Z", url: "https://meteoalarm.org/de-alert", identifier: "de-alert", scope: "Public", status: "ACTUAL", msgType: "ALERT",
        country: { iso3: "DEU" }, feed: { url: "https://feeds.meteoalarm.org/germany", official: true },
        infos: [{ effective: "2026-08-25T08:00:00Z", expires: "2026-08-25T18:00:00Z", event: "Flood", severity: "MODERATE", headline: "Flood", areas: [{ areaDesc: "Germany", geocodes: [{ value: "DE:country" }] }] }],
      }] } } } };
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.includes("alerthub-api.ifrc.org")) return new Response(JSON.stringify(fallback), { status: 200 });
        return new Response(url.endsWith("-germany") ? invalid : empty, { status: 200 });
      });
      const result = await new MeteoAlarmAdapter().fetch({ now: new Date("2026-08-25T09:00:00Z"), locations, fetch: fetchMock as typeof fetch });
      expect(result.partitions.DE).toMatchObject({ status: "partial", limitationCode: "ifrc_fallback", events: [{ providerId: "meteoalarm", sourceUrl: "https://meteoalarm.org/de-alert" }] });
      const once = mergeSourceResults(createEmptyState(new Date("2026-08-25T08:50:00Z")), [result], new Date("2026-08-25T09:00:00Z"));
      const twice = mergeSourceResults(once, [result], new Date("2026-08-25T09:00:00Z"));
      expect(twice.sourcePartitions.meteoalarm.DE.status).toBe("partial");
      const fallbackCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("alerthub-api.ifrc.org"));
      expect(fallbackCalls).toHaveLength(1);
      const query = JSON.parse(String(fallbackCalls[0][1]?.body)).query as string;
      expect(query).toContain("DE: alerts");
      expect(query).not.toContain("AT: alerts");
    } finally { vi.unstubAllEnvs(); }
  });

  it("preserves each attempted fallback's health through IFRC recovery or failure", async () => {
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "true");
    try {
      const now = new Date("2026-08-25T09:00:00Z");
      const empty = `<feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
      for (const recovered of [true, false]) {
        const result = await new MeteoAlarmAdapter().fetch({ now, locations, fetch: (async (input) => {
          const url = String(input);
          if (url.includes("alerthub-api.ifrc.org")) return recovered
            ? Response.json({ data: { public: { IE: { items: [] } } } }) : new Response("invalid");
          if (url.endsWith("-ireland") || url.includes("warning_IRELAND")) return new Response("invalid");
          return new Response(empty);
        }) as typeof fetch });
        expect(result.partitions.IE).toMatchObject({ status: recovered ? "partial" : "failed", transports: {
          "meteoalarm-primary": { status: "failed" }, "met-eireann-json": { status: "failed" },
          "ifrc-meteoalarm": { status: recovered ? "ok" : "failed" },
        } });
        const merged = mergeSourceResults(createEmptyState(now), [result], now);
        expect(merged.partitionTransports.meteoalarm.IE["met-eireann-json"].consecutiveFailures).toBe(1);
        expect(merged.partitionTransports.meteoalarm.IE["ifrc-meteoalarm"].consecutiveFailures).toBe(recovered ? 0 : 1);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("carries IFRC cancellation references into partial-refresh removal prefixes", async () => {
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "true");
    try {
      const empty = `<?xml version="1.0"?><feed><updated>2026-08-25T08:00:00Z</updated></feed>`;
      const fallback = { data: { public: { HU: { items: [{
        sent: "2026-08-25T08:30:00Z", url: "https://meteoalarm.org/cancel-1", identifier: "cancel-1", references: "sender,alert-1,2026-08-25T08:00:00Z",
        scope: "Public", status: "ACTUAL", msgType: "CANCEL", country: { iso3: "HUN" }, feed: { url: "https://feeds.meteoalarm.org/hungary", official: true },
        infos: [{ effective: "2026-08-25T08:30:00Z", expires: "2026-08-25T18:00:00Z", event: "Flood", severity: "MODERATE", areas: [{ areaDesc: "Hungary", geocodes: [{ value: "HU:country" }] }] }],
      }] } } } };
      const result = await new MeteoAlarmAdapter().fetch({ now: new Date("2026-08-25T09:00:00Z"), locations, fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("alerthub-api.ifrc.org")) return Response.json(fallback);
        return new Response(url.endsWith("-hungary") ? "<not-feed />" : empty);
      }) as typeof fetch });
      expect(result.partitions.HU).toMatchObject({ status: "partial", events: [], removedEventPrefixes: ["meteoalarm:alert-1:"] });
    } finally { vi.unstubAllEnvs(); }
  });
});
