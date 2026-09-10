import booleanIntersects from "@turf/boolean-intersects";
import { feature, polygon } from "@turf/helpers";
import { readFile, writeFile } from "node:fs/promises";
import { radiusRing } from "./mapping-geometry.mjs";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/generate-vigicrues-mapping.mjs /path/to/InfoVigiCru.geojson");

const [catalog, geojson] = await Promise.all([
  readFile("data/locations.json", "utf8").then(JSON.parse),
  readFile(input, "utf8").then(JSON.parse),
]);

const frenchDestinations = catalog.filter((location) => location.countryCode === "FR");
const destinationFeatures = frenchDestinations.map((location) => [
  location.id,
  polygon(location.geometry.kind === "polygon" ? location.geometry.coordinates : [radiusRing(location.geometry.center, location.geometry.radiusKm)]),
]);
const mappings = frenchDestinations.map((location) => ({ locationId: location.id, sectionCodes: [] }));
const byLocation = new Map(mappings.map((mapping) => [mapping.locationId, mapping]));

for (const section of geojson.features || []) {
  const code = String(section.properties?.CdEntCru || "").trim();
  if (!code || !section.geometry) continue;
  const sectionFeature = feature(section.geometry);
  for (const [locationId, destination] of destinationFeatures) {
    if (booleanIntersects(sectionFeature, destination)) byLocation.get(locationId).sectionCodes.push(code);
  }
}

const output = {
  schemaVersion: 1,
  generatedFrom: "https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson",
  license: "Licence Ouverte / Open Licence 2.0",
  mappings: mappings.filter(({ sectionCodes }) => sectionCodes.length).map(({ locationId, sectionCodes }) => ({
    locationId,
    sectionCodes: [...new Set(sectionCodes)].sort(),
  })),
};
await writeFile("data/vigicrues-section-mapping.json", `${JSON.stringify(output, null, 2)}\n`);
console.log(`Mapped ${output.mappings.length} of ${frenchDestinations.length} French destinations.`);
