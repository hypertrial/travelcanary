import { describe, expect, it } from "vitest";
import demoSnapshot from "../../public/demo-snapshot.json";
import { locations } from "@/lib/data";
import { SnapshotSchema } from "@/lib/domain/schemas";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import {
  attentionLocationSummaries,
  attentionPresentation,
  destinationHeadline,
  destinationSummary,
  deriveUiDataState,
  evidenceLabel,
  liveStatusPresentation,
  normalizeSearchTerm,
  parseSelfHostedInstanceStatus,
  publicAccessibleLabels,
  publicLabels,
  searchLocationSummaries,
  unavailableInstanceStatus,
} from "@/lib/ui-presentation";

const snapshot = SnapshotSchema.parse(demoSnapshot);

describe("UI presentation", () => {
  it("normalizes accents, punctuation, and whitespace", () => {
    expect(normalizeSearchTerm("  Zürich—City  ")).toBe("zurich city");
  });

  it("keeps native-script aliases searchable", () => {
    expect(searchLocationSummaries(locations, snapshot, "Αιγάλεω")[0].location.id).toBe("gr-aigaleo");
    expect(searchLocationSummaries(locations, snapshot, "Генк")[0].location.id).toBe("be-genk");
  });

  it("ranks exact and prefix destination matches ahead of broad matches", () => {
    const zurich = searchLocationSummaries(locations, snapshot, "zurich");
    expect(zurich[0].location.id).toBe("ch-zuerich");

    const vienna = searchLocationSummaries(locations, snapshot, "Vienna");
    expect(vienna[0].location.name).toBe("Vienna");
    expect(vienna[0].state.level).toBe("NORMAL");
  });

  it("searches aliases, countries, and human-friendly location types", () => {
    expect(searchLocationSummaries(locations, snapshot, "Woerthersee")[0].location.name).toBe("Klagenfurt am Wörthersee");
    expect(searchLocationSummaries(locations, snapshot, "Switzerland").some(({ location }) => location.country === "Switzerland")).toBe(true);
    expect(searchLocationSummaries(locations, snapshot, "Mountain region").some(({ location }) => location.type === "mountain")).toBe(true);
  });

  it("returns no suggestions for an empty query", () => {
    expect(searchLocationSummaries(locations, snapshot, "   ")).toEqual([]);
  });

  it("exposes the public label for a non-normal search result", () => {
    const [alps] = searchLocationSummaries(locations, snapshot, "Austrian Alps");
    expect(alps.location.id).toBe("at-austrian-alps");
    expect(alps.state.level).toBe("ELEVATED");
    expect(publicLabels[alps.state.level]).toBe("Be aware");
  });

  it("sorts attention by severity, timing, and name", () => {
    const attention = attentionLocationSummaries(locations, snapshot);
    expect(attention.map(({ location }) => location.id)).toEqual([
      "at-klagenfurt-am-woerthersee",
      "at-graz",
      "at-austrian-alps",
      "at-salzburg",
      "at-salzkammergut",
      "at-innsbruck",
      "at-linz",
    ]);
    const presentation = attentionPresentation(attention, { catalogCount: locations.length });
    expect(presentation.globalUnavailable).toBe(false);
    expect(presentation.label).toBe("1 emergency · 7 need attention");
    expect(presentation.compactLabel).toBe("7 need attention");
    expect(presentation.railTitle).toBe("7 need attention");
    expect(presentation.railDetail).toBe("1 emergency");
    expect(presentation.groups.map(({ key, items }) => [key, items.length])).toEqual([
      ["emergency", 1],
      ["change-plans", 1],
      ["be-aware", 4],
      ["unavailable", 1],
    ]);
    expect(presentation.accessibleLabel).toBe("1 emergency condition, 1 destination where plans may need changing, 4 destinations to be aware of, 1 destination with updates unavailable.");
  });

  it("treats every destination as unavailable before a snapshot loads", () => {
    const attention = attentionLocationSummaries(locations, null);
    expect(attention).toHaveLength(503);
    expect(attention.every(({ state }) => state.level === "UNKNOWN")).toBe(true);
    expect(attention.every(({ location }, index) => index === 0 || attention[index - 1].location.name.localeCompare(location.name) <= 0)).toBe(true);
    const presentation = attentionPresentation(attention, { catalogCount: locations.length });
    expect(presentation.globalUnavailable).toBe(true);
    expect(presentation.groups).toEqual([]);
    expect(presentation.label).toBe("503 updates unavailable");
    expect(presentation.compactLabel).toBe("503 unavailable");
    expect(presentation.railTitle).toBe("503 updates unavailable");
    expect(presentation.railDetail).toBe("Check affected destinations");
  });

  it("still lists individual destinations when only some updates are unavailable", () => {
    const attention = attentionLocationSummaries(locations, snapshot).filter(({ state }) => state.level === "UNKNOWN");
    expect(attention).toHaveLength(1);
    const presentation = attentionPresentation(attention, { catalogCount: locations.length });
    expect(presentation.globalUnavailable).toBe(false);
    expect(presentation.groups).toHaveLength(1);
    expect(presentation.groups[0].items).toHaveLength(1);
    expect(presentation.label).toBe("1 update unavailable");
  });

  it("does not flag normal destinations when current source health is known", () => {
    const now = new Date("2026-08-25T10:00:00Z");
    const state = createEmptyState(now);
    for (const source of [
      ...Object.values(state.sources),
      ...Object.values(state.sourcePartitions.meteoalarm),
      ...Object.values(state.sourcePartitions.eea),
    ]) {
      if (source.status === "not_monitored") continue;
      source.status = "ok";
      source.lastAttempt = now.toISOString();
      source.lastSuccess = now.toISOString();
      source.nextExpectedUpdate = new Date(now.getTime() + 10 * 60_000).toISOString();
      source.error = null;
    }
    expect(attentionLocationSummaries(locations, buildSnapshot(state, now))).toHaveLength(0);
  });

  it("describes empty, alert-only, and unavailable-only attention states", () => {
    const attention = attentionLocationSummaries(locations, snapshot);
    expect(attentionPresentation([]).label).toBe("No destinations flagged");
    expect(attentionPresentation([]).compactLabel).toBe("None flagged");
    expect(attentionPresentation([])).toMatchObject({ railTitle: "No destinations flagged", railDetail: "Monitoring limits still apply" });
    expect(attentionPresentation(attention.filter(({ state }) => state.level !== "UNKNOWN")).label).toBe("1 emergency · 6 need attention");
    expect(attentionPresentation(attention.filter(({ state }) => state.level === "UNKNOWN")).label).toBe("1 update unavailable");
    expect(attentionPresentation(attention.filter(({ state }) => state.level === "UNKNOWN")).compactLabel).toBe("1 unavailable");
    expect(attentionPresentation(attention.filter(({ state }) => state.level === "UNKNOWN"))).toMatchObject({ railTitle: "1 update unavailable", railDetail: "Open affected destinations" });
    expect(attentionPresentation(attention.filter(({ state }) => state.level === "HIGH")).label).toBe("1 change plan · 1 need attention");
    expect(attentionPresentation(attention.filter(({ state }) => state.level === "HIGH")).compactLabel).toBe("1 needs attention");
    expect(attentionPresentation(attention.filter(({ state }) => state.level === "HIGH"))).toMatchObject({ railTitle: "1 needs attention", railDetail: "1 may need plan changes" });
    expect(attentionPresentation(Array.from({ length: 125 }, () => attention[2]))).toMatchObject({ railTitle: "125 need attention", railDetail: "125 marked Be aware" });
  });

  it("does not describe a failed destination catalog as a healthy empty result", () => {
    expect(attentionPresentation([], { catalogAvailable: false })).toMatchObject({
      label: "Destinations unavailable", compactLabel: "Unavailable", globalUnavailable: true,
    });
  });

  it("derives loading and failure states without discarding a valid snapshot", () => {
    const base = { locationsLoaded: true, catalogError: false, snapshot, snapshotError: false, tilesFailed: false };
    expect(deriveUiDataState({ ...base, locationsLoaded: false })).toBe("initial-loading");
    expect(deriveUiDataState({ ...base, catalogError: true, locationsLoaded: false })).toBe("catalog-unavailable");
    expect(deriveUiDataState({ ...base, snapshot: null, snapshotError: true })).toBe("snapshot-unavailable");
    expect(deriveUiDataState({ ...base, snapshotError: true })).toBe("refresh-delayed");
    expect(deriveUiDataState({ ...base, tilesFailed: true })).toBe("tiles-unavailable");
  });

  it("derives exact live, loading, demo, delayed, and unavailable status labels", () => {
    const now = new Date("2026-08-25T10:04:00Z");
    expect(liveStatusPresentation({ mode: "live", uiState: "ready", generatedAt: "2026-08-25T10:00:00Z", now })).toMatchObject({
      label: "Live",
      detail: "4 min ago",
      desktopLabel: "Live · 4 min ago",
    });
    expect(liveStatusPresentation({ mode: "live", uiState: "initial-loading", generatedAt: null, now })).toMatchObject({ label: "Loading", detail: "updates", desktopLabel: "Checking updates" });
    expect(liveStatusPresentation({ mode: "demo", uiState: "ready", generatedAt: snapshot.generatedAt, now })).toMatchObject({ label: "Demo data", detail: "Not live", desktopLabel: "Demo · not live" });
    expect(liveStatusPresentation({ mode: "demo", uiState: "initial-loading", generatedAt: null, now })).toMatchObject({ label: "Loading", detail: "updates" });
    expect(liveStatusPresentation({ mode: "live", uiState: "refresh-delayed", generatedAt: "2026-08-25T10:00:00Z", now })).toMatchObject({ label: "Delayed", detail: "4 min ago", desktopLabel: "Delayed · 4 min ago" });
    expect(liveStatusPresentation({ mode: "live", uiState: "snapshot-unavailable", generatedAt: null, now })).toMatchObject({ label: "Updates", detail: "unavailable", desktopLabel: "Unavailable" });
    expect(liveStatusPresentation({ mode: "live", uiState: "ready", generatedAt: "2026-08-25T10:10:00Z", now })).toMatchObject({ label: "Live", detail: "Time unavailable", desktopLabel: "Live · time unavailable" });
    expect(liveStatusPresentation({ mode: "live", uiState: "ready", generatedAt: "2026-08-25T08:33:00Z", now })).toMatchObject({ desktopLabel: "Live · 2 hours ago" });
    expect(liveStatusPresentation({ mode: "demo", uiState: "initial-loading", generatedAt: null, now }).accessibleLabel).toBe("Loading updates.");
  });

  it("validates self-hosted status and preserves its disclosure while unavailable", () => {
    expect(parseSelfHostedInstanceStatus({ health: "ok", restrictedSources: { active: true } })).toEqual({
      health: "ok", restrictedSources: { active: true },
    });
    expect(parseSelfHostedInstanceStatus({ health: "ok", restrictedSources: {} })).toBeNull();
    expect(parseSelfHostedInstanceStatus(null)).toBeNull();
    expect(unavailableInstanceStatus({ health: "ok", restrictedSources: { active: true } })).toEqual({
      health: "unavailable", restrictedSources: { active: true },
    });
    expect(unavailableInstanceStatus(null)).toEqual({ health: "unavailable", restrictedSources: { active: false } });
  });

  it("creates destination-first briefing copy without replacing official evidence", () => {
    const location = locations.find(({ id }) => id === "at-klagenfurt-am-woerthersee")!;
    const state = snapshot.locations[location.id];
    const hazard = state.hazards[0];
    expect(destinationHeadline(location, hazard)).toBe("Flooding is affecting Klagenfurt am Wörthersee.");
    expect(hazard.affectedArea.label).not.toBe(location.name);
    expect(destinationSummary(state, location.name)).toContain("official emergency instructions");
    expect(evidenceLabel(hazard)).toBe("Official source");

    const securityHazard = { ...hazard, type: "security" as const };
    expect(destinationHeadline(location, securityHazard)).toBe("Security incidents are affecting Klagenfurt am Wörthersee.");
  });

  it("states each empty destination result once in location-specific language", () => {
    expect(destinationSummary(snapshot.locations["at-vienna"], "Vienna")).toBe(
      "Review source freshness and monitoring gaps for Vienna below.",
    );
    expect(publicLabels.NORMAL).toBe("No major alert found");
    expect(publicAccessibleLabels.NORMAL).toBe("No major alert found in checked sources");
    expect(destinationSummary(snapshot.locations["at-linz"], "Linz")).toBe(
      "Check official local sources before relying on this result.",
    );
  });

});
