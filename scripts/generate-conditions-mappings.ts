import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { coverageByCountry, coverageByLocation, locations } from "../src/lib/data";
import { distanceKm } from "../src/lib/geospatial";
import { marineConditionMapping } from "../src/lib/conditions/marine";
import { ipmaConditionMapping } from "../src/lib/conditions/ipma";
import { opwHydroMapping, opwHydroMappings } from "../src/lib/conditions/opw";
import { arsoHydroMappings } from "../src/lib/conditions/arso-hydro";

const raw = await readFile("data/review-inputs/airports.json", "utf8");
const input = JSON.parse(raw) as { reviewedAt: string; source: string; stations: Array<{ id: string; name: string; coordinates: [number, number]; elevationM: number }> };
if (new URL(input.source).hostname !== "aviationweather.gov" || !Number.isFinite(Date.parse(input.reviewedAt))
  || Date.now() - Date.parse(input.reviewedAt) > 90 * 86400000 || Date.parse(input.reviewedAt) > Date.now() + 86400000) throw new Error("Airport review metadata is invalid or stale");
if (new Set(input.stations.map(({ id }) => id)).size !== input.stations.length
  || input.stations.some(({ id, name, coordinates }) => !/^[A-Z0-9]{4}$/.test(id) || !name.trim() || coordinates.length !== 2 || !coordinates.every(Number.isFinite))) throw new Error("Invalid reviewed airport metadata");
const mappings = locations.filter((location) => ["capital", "city", "resort", "coastal"].includes(location.type)).flatMap((location) => {
  const match = input.stations.map((station) => ({ station, distance: distanceKm(location.centroid, station.coordinates) }))
    .filter(({ distance }) => distance <= 25).sort((a, b) => a.distance - b.distance || a.station.id.localeCompare(b.station.id))[0];
  return match ? [{ locationId: location.id, stationId: match.station.id, name: match.station.name, coordinates: match.station.coordinates,
    elevationM: match.station.elevationM, distanceKm: Math.round(match.distance * 10) / 10 }] : [];
});
const artifact = { schemaVersion: 1, reviewedAt: input.reviewedAt, source: input.source, inputSha256: createHash("sha256").update(raw).digest("hex"),
  rule: "Named airport within 25 km of city/capital/coastal/resort centroid; airport observation only, not destination-wide weather. Mountain, park and large-island areas excluded.", mappings };
async function output(path: string, value: unknown) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes("--check")) { if (await readFile(path, "utf8") !== text) throw new Error(`${path} must be regenerated`); }
  else await writeFile(path, text);
}
await output("data/airport-condition-mapping.json", artifact);

const rwsRaw = await readFile("data/review-inputs/rws-water-stations.json", "utf8");
const rwsInput = JSON.parse(rwsRaw) as {
  reviewedAt: string; source: string; documentation: string; catalogSha256: string;
  stations: Array<{ stationId: string; stationName: string; coordinates: [number, number]; locationId: string; waterBody: string; rationale: string }>;
};
if (new URL(rwsInput.source).hostname !== "ddapi20-waterwebservices.rijkswaterstaat.nl"
  || new URL(rwsInput.documentation).hostname !== "rijkswaterstaatdata.nl"
  || !/^[a-f0-9]{64}$/.test(rwsInput.catalogSha256) || !Number.isFinite(Date.parse(rwsInput.reviewedAt))
  || Date.now() - Date.parse(rwsInput.reviewedAt) > 90 * 86400000 || Date.parse(rwsInput.reviewedAt) > Date.now() + 86400000) throw new Error("Rijkswaterstaat review metadata is invalid or stale");
const rwsStations = new Set<string>(); const rwsLocations = new Set<string>();
const rwsMappings = rwsInput.stations.map((station) => {
  const location = locations.find(({ id }) => id === station.locationId);
  if (!location || location.countryCode !== "NL" || rwsStations.has(station.stationId) || rwsLocations.has(station.locationId)
    || !/^[a-z0-9.]+$/.test(station.stationId) || !station.stationName.trim() || !station.waterBody.trim() || !station.rationale.trim()
    || station.coordinates.length !== 2 || !station.coordinates.every(Number.isFinite)) throw new Error(`Invalid Rijkswaterstaat mapping: ${station.locationId}`);
  const distance = distanceKm(location.centroid, station.coordinates);
  if (distance > 5) throw new Error(`Rijkswaterstaat station is not locally representative: ${station.locationId}`);
  rwsStations.add(station.stationId); rwsLocations.add(station.locationId);
  return { ...station, distanceKm: Math.round(distance * 10) / 10 };
});
await output("data/rws-water-mapping.json", { schemaVersion: 1, reviewedAt: rwsInput.reviewedAt, source: rwsInput.source,
  documentation: rwsInput.documentation, catalogSha256: rwsInput.catalogSha256, inputSha256: createHash("sha256").update(rwsRaw).digest("hex"),
  datum: "NAP", qualityCodes: ["00", "10", "20", "25", "30", "40"], mappings: rwsMappings });
const airports = new Set(mappings.map(({ locationId }) => locationId));
const rws = new Set(rwsMappings.map(({ locationId }) => locationId));
const marine = new Map(marineConditionMapping.mappings.map((item) => [item.locationId, item]));
const ipma = new Set(ipmaConditionMapping.mappings.map(({ locationId }) => locationId));
const arso = new Set(arsoHydroMappings.map(({ locationId }) => locationId));
const footprints: Record<string, [number, number, number, number]> = {
  "effis-fire-danger": [-25, 25, 50, 72], "effis-active-fire": [-25, 25, 45, 72],
  "glofas-targets": [-36, 25, 45, 72], eonet: [-36, 27, 45, 72], "edo-drought": [-25, 22, 51, 72],
};
const report = locations.map((location) => ({ locationId: location.id, sources: {
  "open-meteo-weather": { status: "eligible", reason: "Global forecast; runtime validates the returned grid and data." },
  "open-meteo-air": { status: "eligible", reason: "Global/CAMS model; does not establish observed air-quality coverage." },
  "open-meteo-marine": { status: marine.get(location.id)?.status === "mapped" ? "mapped" : location.isCoastal ? "unsupported" : "excluded",
    reason: marine.get(location.id)?.provenance || "Inland destination." },
  "awc-metar": { status: airports.has(location.id) ? "mapped" : "excluded", reason: airports.has(location.id) ? "Reviewed named-airport mapping, within 25 km." : "No reviewed representative airport under the matching rule." },
  "rws-water": { status: rws.has(location.id) ? "mapped" : "excluded", reason: rws.has(location.id) ? "Reviewed named Rijkswaterstaat station on the destination's river or urban waterway, within 5 km; observation only." : "No reviewed exact Rijkswaterstaat station/waterway mapping." },
  "ipma-observations": { status: ipma.has(location.id) ? "mapped" : "excluded", reason: ipma.has(location.id) ? "Reviewed named IPMA station within 25 km; observation only." : "Outside Portugal or no reviewed representative station." },
  "ipma-seismic": { status: location.countryCode === "PT" ? "eligible" : "excluded", reason: location.countryCode === "PT" ? "IPMA Azores and mainland/Madeira regional feeds; runtime applies the 24-hour, M3+, 100 km rule." : "Outside the reviewed IPMA destination scope." },
  "opw-hydro": { status: opwHydroMappings.some(({ locationId }) => locationId === location.id) ? "mapped" : "excluded", reason: "Reviewed named OPW primary gauge inside destination geometry; provisional observation only. Unmapped destinations have no representative station." },
  "arso-hydro": { status: arso.has(location.id) ? "mapped" : "excluded", reason: arso.has(location.id) ? "Reviewed named ARSO river, lake, or coastal gauge intersecting the destination geometry; observation only." : "Outside Slovenia or no reviewed exact ARSO station/water-body mapping." },
  "eea-aqi": { status: (coverageByLocation[location.id]?.["air-quality"] || coverageByCountry[location.countryCode].hazards["air-quality"]).status === "not_monitored" ? "unsupported" : "mapped",
    reason: (coverageByLocation[location.id]?.["air-quality"] || coverageByCountry[location.countryCode].hazards["air-quality"]).status === "not_monitored" ? "No reviewed official AQI coverage at this destination; modeled conditions are separate." : "Committed sampling points; runtime must distinguish current official pixels from missing station data." },
  ...Object.fromEntries(Object.entries(footprints).map(([id, [west, south, east, north]]) => {
    const [longitude, latitude] = location.centroid;
    const within = longitude >= west && longitude <= east && latitude >= south && latitude <= north;
    return [id, { status: within ? "eligible" : "unsupported", reason: within ? "Inside current query footprint; hazard applicability and pixel validity remain separate." : "Outside the current product/query footprint; no coverage inferred." }];
  })),
} }));
await output("data/destination-source-eligibility.json", { schemaVersion: 1,
  reviewedAt: [input.reviewedAt, marineConditionMapping.reviewedAt, opwHydroMapping.reviewedAt].sort().at(-1), locations: report });
console.log(`Mapped ${mappings.length} destinations to ${new Set(mappings.map(({ stationId }) => stationId)).size} airports; audited ${report.length} destinations.`);
