import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const stationPath = argument("stations");
const revision = argument("revision");
if (!stationPath || !revision || !/^raw_stations\.json\.\d{8}$/.test(revision)) {
  throw new Error("Usage: node scripts/generate-eea-station-mapping.mjs --stations=<official-index-file> --revision=raw_stations.json.YYMMDDHH");
}

const legacy = JSON.parse(readFileSync(resolve(root, "data/locations.json"), "utf8"));
const expansion = JSON.parse(readFileSync(resolve(root, "data/review-inputs/europe-expansion-catalog.json"), "utf8"));
const stationBytes = readFileSync(resolve(stationPath));
const stations = JSON.parse(stationBytes.toString("utf8"));
if (!Array.isArray(stations) || stations.length > 20_000) throw new Error("Official EEA station index is malformed or unbounded");

const radians = (value) => value * Math.PI / 180;
function distanceKm([aLon, aLat], [bLon, bLat]) {
  const dLat = radians(bLat - aLat); const dLon = radians(bLon - aLon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const validStations = stations.filter((station) => station?.operational === 1 && /^[A-Z]{2}[A-Z0-9]{3,10}$/.test(station.code)
  && Number.isFinite(station.lon) && Number.isFinite(station.lat) && Math.abs(station.lon) <= 180 && Math.abs(station.lat) <= 90);
const locations = [...legacy, ...expansion.locations];
const mappings = {};
for (const location of locations) {
  const candidates = validStations.filter(({ code }) => code.startsWith(location.countryCode)).map((station) => ({
    code: station.code, name: station.name, coordinates: [station.lon, station.lat], distanceKm: Number(distanceKm(location.centroid, [station.lon, station.lat]).toFixed(1)),
  })).filter(({ distanceKm }) => distanceKm <= 75).sort((left, right) => left.distanceKm - right.distanceKm || left.code.localeCompare(right.code)).slice(0, 2);
  if (candidates.length) mappings[location.id] = candidates;
}

const artifact = {
  schemaVersion: 1,
  reviewStatus: "reviewed",
  reviewedAt: "2026-09-13",
  methodology: "Nearest one or two operational stations in the same ISO country within 75 km; destination mappings are frozen and runtime metadata must match station identity and coordinates.",
  source: "https://dis2datalake.blob.core.windows.net/airquality-derivated/AQI-noRunningMeans/content/index.json",
  stationMetadataRevision: revision,
  stationMetadataSha256: createHash("sha256").update(stationBytes).digest("hex"),
  locations: mappings,
};
writeFileSync(resolve(root, "data/eea-station-mapping.json"), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${Object.keys(mappings).length} reviewed destination mappings from ${validStations.length} operational stations.`);
