import { describe, expect, it } from "vitest";
import { HazardApplicabilitySchema, hazardApplicability, volcanoAppliesToLocation } from "@/lib/hazard-applicability";
import { locations } from "@/lib/data";
// The generator is deliberately offline and dependency-free.
// @ts-expect-error JavaScript generator has no declaration file.
import { generateApplicability } from "../../scripts/generate-hazard-applicability.mjs";

const source = (longitude: number) => ({
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, 0] },
    properties: { Volcano_Number: 123456, Volcano_Name: "Boundary Volcano" },
  }],
});
const location = {
  id: "test-place",
  geometry: { kind: "radius", center: [0, 0], radiusKm: 1 },
};

describe("reviewed volcanic applicability", () => {
  it("keeps the generated artifact internally consistent and catalog-scoped", () => {
    expect(HazardApplicabilitySchema.parse(hazardApplicability)).toEqual(hazardApplicability);
    const ids = new Set(locations.map(({ id }) => id));
    expect(hazardApplicability.locations.every(({ locationId }) => ids.has(locationId))).toBe(true);
    expect(hazardApplicability.source.version).toBe("5.4.0");
  });

  it("applies at the reviewed 200 km boundary and excludes points beyond it", () => {
    const kmPerDegree = Math.PI * 6371.0088 / 180;
    const atBoundary = generateApplicability([location], source((201 - 1e-9) / kmPerDegree), "2026-08-30");
    const beyondBoundary = generateApplicability([location], source(201.04 / kmPerDegree), "2026-08-30");
    expect(atBoundary.locations).toHaveLength(1);
    expect(atBoundary.locations[0].minimumDistanceKm).toBeLessThanOrEqual(200);
    expect(beyondBoundary.locations).toHaveLength(0);
  });

  it("omits Vienna and Budapest while retaining reviewed volcanic destinations", () => {
    expect(volcanoAppliesToLocation("at-vienna")).toBe(false);
    expect(volcanoAppliesToLocation("hu-budapest")).toBe(false);
    expect(volcanoAppliesToLocation("it-naples")).toBe(true);
    expect(volcanoAppliesToLocation("gr-cyclades")).toBe(true);
    expect(volcanoAppliesToLocation("es-santa-cruz-de-tenerife")).toBe(true);
    expect(volcanoAppliesToLocation("pt-madeira")).toBe(true);
    for (const id of ["pt-ponta-delgada", "pt-horta", "pt-santa-cruz-das-flores"]) expect(volcanoAppliesToLocation(id)).toBe(true);
  });

  it("is deterministic for identical inputs and review metadata", () => {
    expect(generateApplicability([location], source(1), "2026-08-30"))
      .toEqual(generateApplicability([location], source(1), "2026-08-30"));
  });
});
