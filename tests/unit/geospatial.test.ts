import { describe, expect, it } from "vitest";
import { bboxesOverlap, distanceKm, distanceToLocationKm, eventAffectsLocation, eventAffectsLocationExact, eventBbox, locationBbox } from "@/lib/geospatial";
import { locations } from "@/lib/data";
import type { NormalizedEvent } from "@/lib/domain/schemas";

function event(geometry: NormalizedEvent["geometry"]): NormalizedEvent {
  return { id: "test", sourceId: "usgs", providerId: "usgs", type: "earthquake", level: "ELEVATED", timing: "ACTIVE", headline: "Test event", explanation: "Test explanation", action: "Follow local advice.", affectedArea: "Test area", geometry, startsAt: "2026-08-25T00:00:00Z", endsAt: "2026-08-25T06:00:00Z", sourceUpdatedAt: "2026-08-25T00:00:00Z", checkedAt: "2026-08-25T00:00:00Z", expiresAt: "2026-08-25T06:00:00Z", sourceName: "Test", sourceUrl: "https://example.com/", confidence: "HIGH" };
}

describe("geospatial matching", () => {
  it("matches a regional code exactly", () => {
    const location = locations.find((item) => item.sourceRegionCodes.meteoalarm.some((code) => !code.includes(":")))!;
    const code = location.sourceRegionCodes.meteoalarm.find((value) => !value.includes(":"))!;
    expect(eventAffectsLocation(event({ kind: "regions", countryCode: location.countryCode, codes: [code] }), location)).toBe(true);
  });

  it("keeps a destination-targeted event scoped to that destination", () => {
    expect(eventAffectsLocation(event({ kind: "locations", ids: [locations[0].id] }), locations[0])).toBe(true);
    expect(eventAffectsLocation(event({ kind: "locations", ids: [locations[0].id] }), locations[1])).toBe(false);
  });

  it("matches point impacts using the configured radius", () => {
    const location = locations[0];
    expect(eventAffectsLocation(event({ kind: "point", coordinates: location.centroid, radiusKm: 1 }), location)).toBe(true);
    expect(eventAffectsLocation(event({ kind: "point", coordinates: [0, 0], radiusKm: 1 }), location)).toBe(false);
  });

  it("matches a point impact near the edge of a polygon destination", () => {
    const base = locations[0];
    const polygonLocation = {
      ...base,
      centroid: [10, 10] as [number, number],
      geometry: { kind: "polygon" as const, coordinates: [[[9, 9], [11, 9], [11, 11], [9, 11], [9, 9]]] as [number, number][][] },
    };
    expect(eventAffectsLocation(event({ kind: "point", coordinates: [11.05, 10], radiusKm: 10 }), polygonLocation)).toBe(true);
    expect(eventAffectsLocation(event({ kind: "point", coordinates: [12, 10], radiusKm: 10 }), polygonLocation)).toBe(false);
  });
});


it("rejects non-overlapping polygon bboxes and fails open on wrapping boxes", () => {
  const europe = {
    ...locations[0],
    geometry: { kind: "polygon" as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] as [number, number][][] },
  };
  const far = event({ kind: "polygon", coordinates: [[[40, 40], [42, 40], [42, 42], [40, 42], [40, 40]]] });
  expect(eventAffectsLocation(far, europe)).toBe(false);
  expect(eventAffectsLocationExact(far, europe)).toBe(false);
  expect(bboxesOverlap(eventBbox(far), locationBbox(europe))).toBe(false);

  const wrapping = event({ kind: "polygon", coordinates: [[[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]]] });
  expect(bboxesOverlap(eventBbox(wrapping), locationBbox(europe))).toBeNull();
  expect(eventAffectsLocation(wrapping, europe)).toBe(eventAffectsLocationExact(wrapping, europe));
});

it("matches the exact Turf path for catalog locations against nearby and distant polygons", () => {
  const samples = locations.filter((_, index) => index % 17 === 0);
  for (const location of samples) {
    const nearby = event(location.geometry.kind === "polygon"
      ? { kind: "polygon", coordinates: location.geometry.coordinates }
      : { kind: "point", coordinates: location.geometry.center, radiusKm: location.geometry.radiusKm });
    const distant = event({ kind: "polygon", coordinates: [[[-170, -70], [-169, -70], [-169, -69], [-170, -69], [-170, -70]]] });
    expect(eventAffectsLocation(nearby, location)).toBe(eventAffectsLocationExact(nearby, location));
    expect(eventAffectsLocation(distant, location)).toBe(eventAffectsLocationExact(distant, location));
    const point = event({ kind: "point", coordinates: location.centroid, radiusKm: 5 });
    expect(eventAffectsLocation(point, location)).toBe(eventAffectsLocationExact(point, location));
  }
});

it("measures polygon proximity to edge interiors and clamps beyond the endpoints", () => {
  const region = { ...locations[0], geometry: { kind: "polygon" as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] as [number, number][][] } };
  expect(distanceToLocationKm([1, -1], region)).toBeCloseTo(distanceKm([1, -1], [1, 0]), 5);
  expect(distanceToLocationKm([-1, -1], region)).toBeCloseTo(distanceKm([-1, -1], [0, 0]), 5);
  expect(distanceToLocationKm([3, -1], region)).toBeCloseTo(distanceKm([3, -1], [2, 0]), 5);
  expect(distanceToLocationKm([1, 1], region)).toBe(0);
  const algarve = locations.find(({ id }) => id === "pt-algarve")!;
  expect(distanceToLocationKm([-8.2, 36.1], algarve)).toBeLessThan(90);
});
