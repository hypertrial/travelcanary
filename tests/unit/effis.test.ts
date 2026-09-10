import { describe, expect, it } from "vitest";
import { EffisAdapter, effisSourceTimestamp, fwiLevel, sampleEffisDestinations, sampleFwi } from "@/lib/ingestion/adapters/effis";
import { locations } from "@/lib/data";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

describe("EFFIS raster sampling", () => {
  it("retains unavailable destinations while clearing normal samples and recovers on a complete raster", async () => {
    const now = new Date("2026-08-31T10:00:00Z");
    const destinations = ["at-austrian-alps", "pt-madeira"].map((id) => locations.find((location) => location.id === id)!);
    const raster = new Float32Array(1200 * 752).fill(50);
    // Encode the real full-size fixture once: the writer allocates per pixel, unlike the reader under test.
    const encoded = writeArrayBuffer(raster, { width: 1200, height: 752 });
    const image = await (await fromArrayBuffer(encoded)).getImage();
    const offset = Number(await image.getFileDirectory().loadValueIndexed("StripOffsets", 0));
    const bytes = new DataView(encoded);
    const run = () => {
      for (let i = 0; i < raster.length; i += 1) bytes.setFloat32(offset + i * 4, raster[i], image.littleEndian);
      return new EffisAdapter().fetch({ now, locations: destinations, fetch: (async () => new Response(encoded)) as typeof fetch });
    };
    let state = mergeSourceResults(createEmptyState(now), [await run()], now);
    expect(state.events).toHaveLength(2);
    raster.fill(65535);
    const point = destinations[1].centroid;
    const x = Math.floor((point[0] + 25) / 75 * 1200), y = Math.floor((72 - point[1]) / 47 * 752);
    raster[y * 1200 + x] = 10;
    const partial = await run();
    expect(partial).toMatchObject({ status: "partial", events: [], checkedLocationIds: ["pt-madeira"], unavailableLocationIds: ["at-austrian-alps"] });
    state = mergeSourceResults(state, [partial], now);
    expect(state.events.map(({ geometry }) => geometry)).toEqual([{ kind: "locations", ids: ["at-austrian-alps"] }]);
    raster.fill(10);
    state = mergeSourceResults(state, [await run()], now);
    expect(state.events).toEqual([]);
    expect(state.providerCoverage["effis-fire-danger"]?.unavailableLocationIds).toEqual([]);
  });
  it("uses the requested product date rather than the HTTP response time", () => {
    const now = new Date("2026-08-25T12:00:00Z");
    expect(effisSourceTimestamp("2026-08-25", now)).toBe("2026-08-25T00:00:00.000Z");
    expect(() => effisSourceTimestamp("", now)).toThrow(/missing or stale/);
    expect(() => effisSourceTimestamp("2026-08-23", now)).toThrow(/missing or stale/);
    expect(() => effisSourceTimestamp("2026-08-26", now)).toThrow(/missing or stale/);
  });

  it("maps the official very-high threshold without inventing higher levels", () => {
    expect(fwiLevel(37.99)).toBeNull();
    expect(fwiLevel(38)).toBe("ELEVATED");
    expect(fwiLevel(50)).toBe("ELEVATED");
    expect(fwiLevel(70)).toBe("ELEVATED");
  });

  it("samples the destination cell", () => {
    const location = { ...locations[0], centroid: [0.5, 0.5] as [number, number], geometry: { kind: "radius" as const, center: [0.5, 0.5] as [number, number], radiusKm: 15 } };
    expect(sampleFwi(new Float32Array([10, 20, 38, 70]), 2, 2, [0, 0, 1, 1], location)).toBe(70);
  });

  it("ignores invalid no-data values", () => {
    const location = { ...locations[0], centroid: [0.5, 0.5] as [number, number], geometry: { kind: "radius" as const, center: [0.5, 0.5] as [number, number], radiusKm: 15 } };
    expect(sampleFwi(new Float32Array([-999, -999, -999, -999]), 2, 2, [0, 0, 1, 1], location)).toBeNull();
    expect(() => sampleEffisDestinations(new Float32Array([-999, -999, -999, -999]), 2, 2, [0, 0, 1, 1], [{ ...location, type: "mountain" }])).toThrow(/no usable destination samples/);
  });

  it("uses the highest raster cell intersecting a polygon", () => {
    const location = {
      ...locations[0],
      centroid: [0.5, 0.5] as [number, number],
      geometry: { kind: "polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] as [number, number][][] },
    };
    expect(sampleFwi(new Float32Array([37.9, 38, 50, 70]), 2, 2, [0, 0, 1, 1], location)).toBe(70);
  });

  it("rejects oversized TIFFs at the shared fetch boundary", async () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const result = await new EffisAdapter().fetch({
      now,
      locations,
      fetch: (async () => new Response("x", { headers: { "content-length": String(5 * 1024 * 1024 + 1) } })) as typeof fetch,
    });

    expect(result).toMatchObject({ status: "failed", events: [] });
    expect(result.error).toContain("exceeds 5242880 bytes");
  });
});
