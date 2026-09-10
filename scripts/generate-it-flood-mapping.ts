import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import booleanIntersects from "@turf/boolean-intersects";
import { multiPolygon, polygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { LocationSchema } from "../src/lib/domain/schemas";
import { locationPolygon } from "../src/lib/geospatial";

type Topology = {
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: Array<Array<[number, number]>>;
  objects: Record<string, { geometries?: Geometry[] }>;
};
type Geometry = { type: "Polygon" | "MultiPolygon"; arcs: number[][] | number[][][]; properties?: Record<string, unknown> };

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run mapping:it-flood -- <official-topology.json>");
const bytes = await readFile(input);
const topology = JSON.parse(bytes.toString()) as Topology;
const locations = LocationSchema.array().parse(JSON.parse(await readFile("data/locations.json", "utf8")))
  .filter(({ countryCode }) => countryCode === "IT");

const decodedArcs = topology.arcs.map((arc) => {
  let x = 0; let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx; y += dy;
    const scale = topology.transform?.scale || [1, 1];
    const translate = topology.transform?.translate || [0, 0];
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as [number, number];
  });
});
const ring = (indexes: number[]) => indexes.flatMap((index, position) => {
  const coordinates = index < 0 ? decodedArcs[~index].slice().reverse() : decodedArcs[index];
  return position ? coordinates.slice(1) : coordinates;
});
const feature = (geometry: Geometry): Feature<Polygon | MultiPolygon> => geometry.type === "Polygon"
  ? polygon((geometry.arcs as number[][]).map(ring))
  : multiPolygon((geometry.arcs as number[][][]).map((part) => part.map(ring)));
const zones = Object.values(topology.objects).flatMap(({ geometries }) => geometries || []).map((geometry) => ({
  geometry: feature(geometry),
  name: String(geometry.properties?.["Nome zona"] || "").trim(),
})).filter(({ name }) => name);
if (zones.length < 150) throw new Error(`Official bulletin topology is incomplete: ${zones.length} zones`);

const mappings = locations.map((location) => ({
  locationId: location.id,
  zoneNames: [...new Set(zones.filter(({ geometry }) => booleanIntersects(geometry, locationPolygon(location))).map(({ name }) => name))].sort(),
})).filter(({ zoneNames }) => zoneNames.length);
if (mappings.length < 20) throw new Error(`Too few Italian destinations intersect official zones: ${mappings.length}`);
const result = {
  schemaVersion: 1,
  reviewedAt: new Date().toISOString().slice(0, 10),
  source: {
    url: "https://github.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    featureCount: zones.length,
  },
  mappings,
};
await writeFile("data/italy-flood-zone-mapping.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(`Mapped ${mappings.length} Italian destinations to ${zones.length} official warning zones.`);
