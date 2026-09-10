import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import booleanIntersects from "@turf/boolean-intersects";
import { feature, polygon } from "@turf/helpers";

const SOURCE_URL = "https://ags.cuzk.cz/arcgis/rest/services/RUIAN/Vyhledavaci_sluzba_nad_daty_RUIAN/MapServer/14";

function radiusRing([longitude, latitude], radiusKm, steps = 48) {
  const latitudeScale = 110.574;
  const longitudeScale = 111.32 * Math.cos((latitude * Math.PI) / 180);
  const ring = Array.from({ length: steps }, (_, index) => {
    const angle = (index / steps) * Math.PI * 2;
    return [longitude + (Math.cos(angle) * radiusKm) / longitudeScale, latitude + (Math.sin(angle) * radiusKm) / latitudeScale];
  });
  return [...ring, ring[0]];
}

export function intersectingOrpCodes(location, collection) {
  const destination = location.geometry.kind === "polygon"
    ? polygon(location.geometry.coordinates)
    : polygon([radiusRing(location.geometry.center, location.geometry.radiusKm)]);
  return collection.features.flatMap((item) => {
    const code = String(item?.properties?.kod || "").trim();
    if (!code || !item?.geometry || !["Polygon", "MultiPolygon"].includes(item.geometry.type)) throw new Error("RÚIAN ORP feature is malformed");
    try { return booleanIntersects(destination, feature(item.geometry)) ? [code] : []; } catch { throw new Error(`RÚIAN ORP geometry is invalid for ${code}`); }
  }).sort((a, b) => Number(a) - Number(b));
}

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  if (inputIndex < 0 || !args[inputIndex + 1]) throw new Error("Usage: node scripts/generate-chmi-orp-mapping.mjs --input <RÚIAN ORP GeoJSON> [--reviewed-at YYYY-MM-DD]");
  const dateIndex = args.indexOf("--reviewed-at");
  const reviewedAt = dateIndex >= 0 ? args[dateIndex + 1] : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) throw new Error("Review date must be YYYY-MM-DD");
  const [locationText, mappingText, sourceText] = await Promise.all([
    readFile("data/locations.json", "utf8"), readFile("data/chmi-hydrology-mapping.json", "utf8"), readFile(args[inputIndex + 1], "utf8"),
  ]);
  const locations = JSON.parse(locationText).filter(({ countryCode }) => countryCode === "CZ");
  const previous = JSON.parse(mappingText);
  const collection = JSON.parse(sourceText);
  if (collection?.type !== "FeatureCollection" || collection.features?.length !== 206) throw new Error("Expected the complete 206-feature RÚIAN ORP layer");
  const stations = new Map(previous.mappings.map(({ locationId, stations: reviewedStations }) => [locationId, reviewedStations]));
  const mappings = locations.map((location) => ({
    locationId: location.id,
    orpCodes: intersectingOrpCodes(location, collection),
    stations: stations.get(location.id) || [],
  }));
  if (mappings.some(({ orpCodes }) => orpCodes.length === 0)) throw new Error("Every Czech destination must intersect at least one RÚIAN ORP");
  const result = {
    schemaVersion: 2,
    reviewedAt,
    stationSource: previous.source,
    geometrySource: { url: SOURCE_URL, downloadedAt: reviewedAt, sha256: createHash("sha256").update(sourceText).digest("hex"), featureCount: collection.features.length },
    bulletinContract: "https://opendata.chmi.cz/hydrology/product/metadata/flash_flood/popis_flash_flood.pdf",
    mappings,
  };
  await writeFile("data/chmi-hydrology-mapping.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Generated exact ORP mappings for ${mappings.length} Czech destinations (${new Set(mappings.flatMap(({ orpCodes }) => orpCodes)).size} ORPs).`);
}

if (process.argv[1]?.endsWith("generate-chmi-orp-mapping.mjs")) await main();
