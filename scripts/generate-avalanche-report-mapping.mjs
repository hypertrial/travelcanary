import booleanIntersects from "@turf/boolean-intersects";
import { feature, polygon } from "@turf/helpers";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { radiusRing } from "./mapping-geometry.mjs";

export function generateAvalancheMapping(catalog, collections, reviewed, currentDate) {
  if (reviewed.schemaVersion !== 2 || !Array.isArray(reviewed.partitions) || !Array.isArray(reviewed.mappings)) {
    throw new Error("A reviewed V2 avalanche mapping is required");
  }
  if (!collections.length || collections.some((collection) => collection.type !== "FeatureCollection" || !Array.isArray(collection.features))) {
    throw new Error("Expected official EAWS FeatureCollections");
  }
  const regions = collections.flatMap((collection) => collection.features).filter((region) => {
    const start = region.properties?.start_date;
    const end = region.properties?.end_date;
    return (!start || start <= currentDate) && (!end || end > currentDate);
  });
  const mappings = reviewed.mappings.map((mapping) => {
    const location = catalog.find(({ id }) => id === mapping.locationId);
    if (!location || !mapping.feedCodes?.length || !mapping.regionPrefixes?.length
      || mapping.feedCodes.some((code) => !reviewed.partitions.some(({ feedCode }) => feedCode === code))) {
      throw new Error(`Invalid reviewed mapping: ${mapping.locationId}`);
    }
    const destination = polygon(location.geometry.kind === "polygon" ? location.geometry.coordinates : [radiusRing(location.geometry.center, location.geometry.radiusKm)]);
    const regionIds = regions.filter((region) => typeof region.properties?.id === "string"
      && mapping.regionPrefixes.some((prefix) => region.properties.id.startsWith(prefix))
      && booleanIntersects(feature(region.geometry), destination)).map((region) => region.properties.id);
    if (!regionIds.length) throw new Error(`No current reviewed EAWS geometry intersects ${location.id}; refusing to erase its mapping`);
    // Bulletins may use parent regions rather than micro-region IDs. Preserve
    // reviewed prefix semantics instead of replacing them with geometry IDs.
    return { ...mapping, feedCodes: [...mapping.feedCodes], regionPrefixes: [...mapping.regionPrefixes] };
  });
  // Geometry regeneration must not enable feeds, add destinations, or manufacture a review.
  return { ...reviewed, mappings: mappings.sort((a, b) => a.locationId.localeCompare(b.locationId)) };
}

async function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error("Pass complete official EAWS micro-region GeoJSON files; reviewed V2 feed decisions are preserved");
  const catalog = JSON.parse(await readFile("data/locations.json", "utf8"));
  const reviewed = JSON.parse(await readFile("data/avalanche-report-region-mapping.json", "utf8"));
  const collections = await Promise.all(inputs.map((path) => readFile(path, "utf8").then(JSON.parse)));
  const output = generateAvalancheMapping(catalog, collections, reviewed, new Date().toISOString().slice(0, 10));
  await writeFile("data/avalanche-report-region-mapping.json", `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Mapped ${output.mappings.length} reviewed destinations; preserved all feed readiness decisions.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
