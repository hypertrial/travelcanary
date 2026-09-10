import booleanIntersects from "@turf/boolean-intersects";
import { point, polygon } from "@turf/helpers";
import { readFile, writeFile } from "node:fs/promises";
import { radiusRing } from "./mapping-geometry.mjs";

const catalog = JSON.parse(await readFile("data/locations.json", "utf8"));
const endpoint = "https://gis.lfrz.gv.at/api/geodata/i000501/ogc/features/v1/collections/i000501:pegel_aktuell/items?f=application/geo%2Bjson&limit=500";

const austrian = catalog.filter((location) => location.countryCode === "AT").sort((a, b) => a.id.localeCompare(b.id));
const destinations = austrian.map((location) => [
  location.id,
  polygon(location.geometry.kind === "polygon" ? location.geometry.coordinates : [radiusRing(location.geometry.center, location.geometry.radiusKm)]),
]);
const byLocation = new Map(austrian.map((location) => [location.id, []]));

const response = await fetch(endpoint);
if (!response.ok) throw new Error(`eHYD mapping fetch failed: ${response.status}`);
const geojson = await response.json();
if (!Array.isArray(geojson.features)) throw new Error("eHYD mapping response is not a FeatureCollection");

for (const feature of geojson.features) {
  const stationId = String(feature.properties?.hzbnr || "").trim();
  const coordinates = feature.geometry?.type === "Point" ? feature.geometry.coordinates : null;
  if (!stationId || !Array.isArray(coordinates) || coordinates.length < 2) continue;
  const station = point([Number(coordinates[0]), Number(coordinates[1])]);
  for (const [locationId, destination] of destinations) {
    if (booleanIntersects(station, destination)) byLocation.get(locationId).push(stationId);
  }
}

const output = {
  schemaVersion: 1,
  generatedFrom: endpoint,
  license: "CC BY 4.0",
  attribution: "Datenquelle: ehyd.gv.at",
  mappings: austrian.flatMap((location) => {
    const stationIds = [...new Set(byLocation.get(location.id))].sort();
    return stationIds.length ? [{ locationId: location.id, stationIds }] : [];
  }),
};
await writeFile("data/ehyd-station-mapping.json", `${JSON.stringify(output, null, 2)}\n`);
console.log(`Mapped ${output.mappings.length} of ${austrian.length} Austrian destinations.`);
