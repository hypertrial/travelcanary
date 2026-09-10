import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Model = {
  clampRefreshInterval(value: unknown): number;
  normalizeServiceUrl(value: unknown): string;
  parseSummary(value: string): unknown | null;
  strongestState(value: unknown): string;
  attentionCount(value: unknown): number;
  destinationUrl(origin: string, id: string): string;
};

const source = readFileSync(join(process.cwd(), "omarchy", "Model.js"), "utf8");
const model = Function(`${source}\nreturn { clampRefreshInterval, normalizeServiceUrl, parseSummary, strongestState, attentionCount, destinationUrl };`)() as Model;
const validSummary = {
  schemaVersion: 1, appVersion: "0.1.0", catalogVersion: 3, health: "ok", freshness: "fresh",
  generatedAt: "2026-09-10T12:00:00.000Z",
  restrictedSources: { active: true, count: 6, disclosure: "Restricted source terms accepted." },
  counts: { NORMAL: 670, ELEVATED: 3, HIGH: 2, SEVERE: 1, UNKNOWN: 3, attention: 9 },
  destinations: [{ id: "fr-paris", name: "Paris", countryCode: "FR", level: "SEVERE", updatePending: false }],
};

describe("Omarchy TravelCanary model", () => {
  it("accepts only loopback HTTP origins and clamps polling", () => {
    expect(model.normalizeServiceUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(model.normalizeServiceUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(model.normalizeServiceUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
    for (const value of ["https://127.0.0.1:3000", "http://example.com", "http://127.0.0.1:70000", "http://127.0.0.1:3000/path", "http://127.0.0.1@evil.test"]) {
      expect(model.normalizeServiceUrl(value)).toBe("");
    }
    expect(model.clampRefreshInterval(1)).toBe(60);
    expect(model.clampRefreshInterval(9999)).toBe(3600);
    expect(model.clampRefreshInterval("bad")).toBe(300);
  });

  it("validates bounded summaries and derives the strongest state", () => {
    const parsed = model.parseSummary(JSON.stringify(validSummary)) as { destinations: unknown[]; restrictedSources: { disclosure: string } };
    expect(parsed.destinations).toHaveLength(1);
    expect(parsed.restrictedSources.disclosure).toBe(validSummary.restrictedSources.disclosure);
    expect(model.strongestState(parsed)).toBe("SEVERE");
    expect(model.attentionCount(parsed)).toBe(9);
    expect(model.parseSummary("not-json")).toBeNull();
    expect(model.parseSummary(JSON.stringify({ ...validSummary, destinations: Array(11).fill(validSummary.destinations[0]) }))).toBeNull();
    expect(model.parseSummary(JSON.stringify({ ...validSummary, destinations: [{ ...validSummary.destinations[0], id: "../../private" }] }))).toBeNull();
  });

  it("opens only validated destination routes on the configured instance", () => {
    expect(model.destinationUrl("http://127.0.0.1:3000", "fr-paris")).toBe("http://127.0.0.1:3000/?destination=fr-paris");
    expect(model.destinationUrl("http://example.com", "fr-paris")).toBe("");
    expect(model.destinationUrl("http://127.0.0.1:3000", "../private")).toBe("");
  });
});
