import { describe, expect, it } from "vitest";
import type { PublicHazard } from "@/lib/domain/schemas";
import { comparePublicHazards, currentPublicHazards, eventIsPublishable, hazardTiming } from "@/lib/hazard-lifecycle";

function hazard(id: string, level: PublicHazard["level"], startsAt: string, updatedAt = "2026-08-25T10:00:00Z"): PublicHazard {
  return {
    providerId: "meteoalarm",
    id, type: "severe-weather", level, timing: "ACTIVE", headline: "Weather warning",
    explanation: "Official warning information.", action: "Check local advice.", affectedArea: { label: "Test area" },
    startsAt, endsAt: "2026-08-25T18:00:00Z", sourceUpdatedAt: updatedAt, checkedAt: updatedAt,
    expiresAt: "2026-08-25T18:00:00Z", sourceName: "Test source", sourceUrl: "https://example.com/", confidence: "HIGH",
    evidence: [{ providerId: "meteoalarm", sourceName: "Test source", sourceUrl: "https://example.com/", sourceUpdatedAt: updatedAt, checkedAt: updatedAt, confidence: "HIGH" }],
  };
}

describe("shared hazard lifecycle", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it("derives active and upcoming timing at the exact boundary", () => {
    expect(hazardTiming("2026-08-25T12:00:00Z", now)).toBe("ACTIVE");
    expect(hazardTiming("2026-08-25T12:00:00.001Z", now)).toBe("UPCOMING");
  });

  it("sorts by severity, active timing, update time, and stable id", () => {
    const hazards = [
      hazard("b", "HIGH", "2026-08-25T13:00:00Z"),
      hazard("c", "ELEVATED", "2026-08-25T11:00:00Z"),
      hazard("a", "HIGH", "2026-08-25T11:00:00Z"),
    ].map((item) => ({ ...item, timing: hazardTiming(item.startsAt, now) })).sort(comparePublicHazards);
    expect(hazards.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });

  it("removes expired evidence and reranks remaining hazards", () => {
    const expired = { ...hazard("expired", "SEVERE", "2026-08-25T10:00:00Z"), endsAt: now.toISOString(), expiresAt: now.toISOString() };
    expect(currentPublicHazards([expired, hazard("current", "HIGH", "2026-08-25T11:00:00Z")], now).map(({ id }) => id)).toEqual(["current"]);
  });

  it("uses the same end and expiry boundaries as browser pruning", () => {
    const current = hazard("current", "HIGH", "2026-08-25T11:00:00Z");
    expect(eventIsPublishable(current, now)).toBe(true);
    expect(eventIsPublishable({ ...current, endsAt: now.toISOString() }, now)).toBe(false);
    expect(eventIsPublishable({ ...current, expiresAt: now.toISOString() }, now)).toBe(false);
    expect(currentPublicHazards([current, { ...current, id: "ended", endsAt: now.toISOString() }], now)).toHaveLength(1);
  });

  it("rejects evidence that ends before it starts", () => {
    const invalid = { ...hazard("invalid", "HIGH", "2026-08-25T17:00:00Z"), endsAt: "2026-08-25T16:00:00Z" };
    expect(eventIsPublishable(invalid, now)).toBe(false);
    expect(currentPublicHazards([invalid], now)).toEqual([]);
  });
});
