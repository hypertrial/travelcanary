import { describe, expect, it } from "vitest";
import mapping from "../../data/chmi-hydrology-mapping.json";
import { locations } from "@/lib/data";
// @ts-expect-error JavaScript offline generator has no declaration file.
import { intersectingOrpCodes } from "../../scripts/generate-chmi-orp-mapping.mjs";

const geometry = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { kod: 101 }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
    { type: "Feature", properties: { kod: 202 }, geometry: { type: "Polygon", coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]] } },
  ],
};

describe("CHMI exact ORP mapping", () => {
  it("maps exact polygon intersections and excludes separated ORPs", () => {
    const location = { geometry: { kind: "polygon", coordinates: [[[0.5, 0.5], [1.5, 0.5], [1.5, 0.8], [0.5, 0.8], [0.5, 0.5]]] } };
    expect(intersectingOrpCodes(location, geometry)).toEqual(["101"]);
  });

  it("captures every Czech catalog destination with unique official codes", () => {
    const czechIds = locations.filter(({ countryCode }) => countryCode === "CZ").map(({ id }) => id).sort();
    expect(mapping.mappings.map(({ locationId }) => locationId).sort()).toEqual(czechIds);
    expect(mapping.mappings.every(({ orpCodes }) => orpCodes.length > 0 && new Set(orpCodes).size === orpCodes.length)).toBe(true);
    expect(mapping.geometrySource).toMatchObject({ featureCount: 206, url: expect.stringMatching(/^https:\/\/ags\.cuzk\.cz\//) });
  });
});
