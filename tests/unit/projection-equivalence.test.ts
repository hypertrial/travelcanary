import { describe, expect, it } from "vitest";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { buildCatalog3Conditions, buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { eventAffectsLocation, eventAffectsLocationExact } from "@/lib/geospatial";
import { publicationSha256 } from "@/lib/publication-store";
import { createEmptyState } from "@/lib/risk-state";
import type { NormalizedEvent } from "@/lib/domain/schemas";
import release2 from "../../data/catalog-releases/2.json";
import release3 from "../../data/catalog-releases/3.json";

const now = new Date("2026-09-08T12:00:00Z");

function polygonEvent(id: string, coordinates: [number, number][][]): NormalizedEvent {
  return {
    id, sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
    headline: "Equivalence earthquake", explanation: "Deterministic projection fixture.", action: "Follow local advice.",
    affectedArea: "Fixture area", geometry: { kind: "polygon", coordinates },
    startsAt: now.toISOString(), endsAt: "2026-09-08T18:00:00Z", sourceUpdatedAt: now.toISOString(),
    checkedAt: now.toISOString(), expiresAt: "2026-09-08T18:00:00Z",
    sourceName: "USGS", sourceUrl: "https://example.com/equivalence", confidence: "HIGH",
  };
}

function fixtureState() {
  const value = createEmptyState(now);
  value.collection = { catalogVersion: 3, revision: 1 };
  const added = release3.locationIds.filter((id) => !release2.locationIds.includes(id));
  value.expandedSourceHealth.usgs = {
    health: { ...value.sources.usgs, status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(),
      sourceUpdatedAt: now.toISOString(), nextExpectedUpdate: "2026-09-08T12:10:00Z", error: null },
    checkedLocationIds: [...added], unavailableLocationIds: [],
  };
  value.events = catalogLocationsV3.filter((_, index) => index % 23 === 0).map((location, index) => (
    location.geometry.kind === "polygon"
      ? polygonEvent(`eq-${index}`, location.geometry.coordinates)
      : polygonEvent(`eq-${index}`, [[
        [location.centroid[0] - 0.2, location.centroid[1] - 0.2],
        [location.centroid[0] + 0.2, location.centroid[1] - 0.2],
        [location.centroid[0] + 0.2, location.centroid[1] + 0.2],
        [location.centroid[0] - 0.2, location.centroid[1] + 0.2],
        [location.centroid[0] - 0.2, location.centroid[1] - 0.2],
      ]])
  ));
  return value;
}

describe("catalog 3 projection equivalence", () => {
  it("matches the exact-path affect result for every fixture event and catalog location", () => {
    const value = fixtureState();
    for (const event of value.events) {
      for (const location of catalogLocationsV3) {
        expect(eventAffectsLocation(event, location)).toBe(eventAffectsLocationExact(event, location));
      }
    }
  });

  it("keeps the published object SHA set identical to the exact-path result", () => {
    const value = fixtureState();
    const snapshot = buildCatalog3Snapshot(value, now);
    const exactMatches = new Map<string, string[]>();
    for (const location of catalogLocationsV3) {
      const ids = value.events.filter((event) => eventAffectsLocationExact(event, location)).map(({ id }) => id).sort();
      const prefiltered = value.events.filter((event) => eventAffectsLocation(event, location)).map(({ id }) => id).sort();
      expect(prefiltered).toEqual(ids);
      if (ids.length) exactMatches.set(location.id, ids);
    }
    const conditions = buildCatalog3Conditions(value, now, { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) });
    const shas = [publicationSha256(JSON.stringify(snapshot)), ...conditions.map((file) => publicationSha256(serializeCatalog3Conditions(file)))].sort();
    expect(new Set(shas).size).toBe(shas.length);
    expect([...exactMatches.keys()].every((id) => id in snapshot.locations)).toBe(true);
  });
});
