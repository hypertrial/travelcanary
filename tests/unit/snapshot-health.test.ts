import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { applySnapshotStaleness } from "@/lib/snapshot-health";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { SnapshotSchema } from "@/lib/domain/schemas";
import { locations } from "@/lib/data";
import { hazardAppliesToLocation } from "@/lib/risk-policy";

const generatedAt = new Date("2026-08-25T12:00:00Z");

describe("client snapshot staleness", () => {
  it("marks a live snapshot delayed after 30 minutes", () => {
    const snapshot = buildSnapshot(createEmptyState(generatedAt), generatedAt);
    expect(applySnapshotStaleness(snapshot, new Date("2026-08-25T12:30:01Z")).dataHealth).toBe("delayed");
  });

  it("fails closed when a snapshot timestamp is implausibly far in the future", () => {
    const snapshot = buildSnapshot(createEmptyState(generatedAt), new Date("2099-01-01T00:00:00Z"));
    const stale = applySnapshotStaleness(snapshot, generatedAt);
    expect(stale.dataHealth).toBe("stale");
    expect(Object.values(stale.locations).every((location) => location.level === "UNKNOWN")).toBe(true);
  });

  it("turns only normal locations unknown after two hours", () => {
    const state = createEmptyState(generatedAt);
    for (const health of Object.values(state.sources)) {
      if (health.status !== "not_monitored") {
        health.status = "ok";
        health.lastSuccess = generatedAt.toISOString();
      }
    }
    const snapshot = buildSnapshot(state, generatedAt);
    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"));
    expect(stale.dataHealth).toBe("stale");
    expect(Object.values(stale.locations).every((location) => location.level === "UNKNOWN")).toBe(true);
  });

  it("removes expired alert evidence before applying stale coverage", async () => {
    const snapshot = SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    snapshot.generatedAt = "2026-08-25T12:00:00Z";
    const [id, state] = Object.entries(snapshot.locations).find(([, location]) => location.level !== "NORMAL" && location.level !== "UNKNOWN")!;
    if (state.level === "NORMAL" || state.level === "UNKNOWN") throw new Error("Expected an alert fixture");
    for (const hazard of state.hazards) {
      hazard.startsAt = "2026-08-25T11:00:00Z";
      hazard.endsAt = "2026-08-25T13:00:00Z";
      hazard.expiresAt = "2026-08-25T13:00:00Z";
    }

    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"));
    expect(stale.locations[id]).toMatchObject({ level: "UNKNOWN", coverage: "delayed", hazards: [] });
  });

  it("retains unexpired known alerts while marking their coverage delayed", async () => {
    const snapshot = SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    snapshot.generatedAt = "2026-08-25T12:00:00Z";
    const [id, state] = Object.entries(snapshot.locations).find(([, location]) => location.level !== "NORMAL" && location.level !== "UNKNOWN")!;
    if (state.level === "NORMAL" || state.level === "UNKNOWN") throw new Error("Expected an alert fixture");
    for (const hazard of state.hazards) {
      hazard.startsAt = "2026-08-25T13:00:00Z";
      hazard.endsAt = "2026-08-25T16:00:00Z";
      hazard.expiresAt = "2026-08-25T16:00:00Z";
    }

    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"));
    expect(stale.locations[id]).toMatchObject({ level: state.level, timing: "ACTIVE", coverage: "delayed" });
  });

  it("does not turn an expired alert normal when its coverage is already delayed", async () => {
    const snapshot = SnapshotSchema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
    snapshot.generatedAt = "2026-08-25T12:00:00Z";
    snapshot.dataHealth = "delayed";
    const [id, state] = Object.entries(snapshot.locations).find(([, location]) => location.level !== "NORMAL" && location.level !== "UNKNOWN")!;
    if (state.level === "NORMAL" || state.level === "UNKNOWN") throw new Error("Expected an alert fixture");
    state.coverage = "delayed";
    for (const hazard of state.hazards) {
      hazard.endsAt = "2026-08-25T12:10:00Z";
      hazard.expiresAt = "2026-08-25T12:10:00Z";
    }

    expect(applySnapshotStaleness(snapshot, new Date("2026-08-25T12:15:00Z")).locations[id]).toMatchObject({ level: "UNKNOWN", hazards: [] });
  });

  it("omits non-applicable hazards from stale city delays", () => {
    const snapshot = buildSnapshot(createEmptyState(generatedAt), generatedAt);
    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"), locations);
    const budapest = locations.find((location) => location.id === "hu-budapest")!;
    expect(stale.locations["hu-budapest"].delayedHazards.includes("fire-danger")).toBe(false);
    expect(hazardAppliesToLocation("fire-danger", budapest)).toBe(false);
  });

  it("keeps the full hazard list when no catalog is provided", () => {
    const snapshot = buildSnapshot(createEmptyState(generatedAt), generatedAt);
    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"));
    expect(stale.locations["hu-budapest"].delayedHazards.includes("fire-danger")).toBe(true);
  });

  it("includes fire-danger in stale outdoor delays without rewriting permanent gaps", () => {
    const snapshot = buildSnapshot(createEmptyState(generatedAt), generatedAt);
    const alpsGaps = snapshot.locations["at-austrian-alps"].coverageGaps;
    const moselleGaps = snapshot.locations["lu-luxembourg-moselle"].coverageGaps;
    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"), locations);
    const alps = locations.find((location) => location.id === "at-austrian-alps")!;
    const moselle = locations.find((location) => location.id === "lu-luxembourg-moselle")!;
    expect(hazardAppliesToLocation("fire-danger", alps)).toBe(true);
    expect(hazardAppliesToLocation("fire-danger", moselle)).toBe(true);
    expect(stale.locations["at-austrian-alps"].delayedHazards.includes("fire-danger")).toBe(true);
    expect(stale.locations["lu-luxembourg-moselle"].delayedHazards.includes("fire-danger")).toBe(true);
    expect(stale.locations["at-austrian-alps"].coverageGaps).toEqual(alpsGaps);
    expect(stale.locations["lu-luxembourg-moselle"].coverageGaps).toEqual(moselleGaps);
  });

  it("falls back to all enabled hazards when the catalog omits a city", () => {
    const snapshot = buildSnapshot(createEmptyState(generatedAt), generatedAt);
    const withoutBudapest = locations.filter((location) => location.id !== "hu-budapest");
    const stale = applySnapshotStaleness(snapshot, new Date("2026-08-25T14:00:01Z"), withoutBudapest);
    expect(stale.locations["hu-budapest"].delayedHazards.includes("fire-danger")).toBe(true);
  });
});
