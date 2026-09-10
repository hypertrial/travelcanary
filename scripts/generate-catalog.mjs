import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const geonamesPath = process.env.GEONAMES_PATH || "/tmp/travelcanary-cities15000.txt";
const nutsPath = process.env.NUTS_PATH || "/tmp/travelcanary-nuts.geojson";
const admin1Path = process.env.GEONAMES_ADMIN1_PATH || "/tmp/travelcanary-admin1.txt";
const admin2Path = process.env.GEONAMES_ADMIN2_PATH || "/tmp/travelcanary-admin2.txt";

const countries = {
  AT: ["Austria", "Vienna"], BE: ["Belgium", "Brussels"], BG: ["Bulgaria", "Sofia"], HR: ["Croatia", "Zagreb"],
  CY: ["Cyprus", "Nicosia"], CZ: ["Czechia", "Prague"], DK: ["Denmark", "Copenhagen"], EE: ["Estonia", "Tallinn"],
  FI: ["Finland", "Helsinki"], FR: ["France", "Paris"], DE: ["Germany", "Berlin"], GR: ["Greece", "Athens"],
  HU: ["Hungary", "Budapest"], IE: ["Ireland", "Dublin"], IT: ["Italy", "Rome"], LV: ["Latvia", "Riga"],
  LT: ["Lithuania", "Vilnius"], LU: ["Luxembourg", "Luxembourg"], MT: ["Malta", "Valletta"], NL: ["Netherlands", "Amsterdam"],
  PL: ["Poland", "Warsaw"], PT: ["Portugal", "Lisbon"], RO: ["Romania", "Bucharest"], SK: ["Slovakia", "Bratislava"],
  SI: ["Slovenia", "Ljubljana"], ES: ["Spain", "Madrid"], SE: ["Sweden", "Stockholm"], CH: ["Switzerland", "Bern"],
};

// Two intentionally broad traveler regions per country. These are conservative
// matching polygons, not legal or administrative boundaries.
const regions = [
  ["AT", "Austrian Alps", "mountain", 13.2, 46.5, 16.0, 47.8, "Europe/Vienna"], ["AT", "Salzkammergut", "resort", 13.2, 47.4, 14.2, 48.0, "Europe/Vienna"],
  ["BE", "Ardennes", "park", 4.4, 49.6, 6.4, 50.7, "Europe/Brussels"], ["BE", "Belgian Coast", "coastal", 2.5, 51.0, 3.4, 51.4, "Europe/Brussels"],
  ["BG", "Rila Mountains", "mountain", 23.0, 41.9, 24.1, 42.4, "Europe/Sofia"], ["BG", "Bulgarian Black Sea Coast", "coastal", 27.4, 42.0, 28.7, 43.8, "Europe/Sofia"],
  ["HR", "Plitvice Lakes", "park", 15.4, 44.7, 15.8, 45.0, "Europe/Zagreb"], ["HR", "Dalmatian Coast", "coastal", 14.9, 42.4, 18.5, 44.4, "Europe/Zagreb"],
  ["CY", "Troodos Mountains", "mountain", 32.6, 34.7, 33.2, 35.1, "Asia/Nicosia"], ["CY", "Ayia Napa Coast", "resort", 33.8, 34.8, 34.2, 35.1, "Asia/Nicosia"],
  ["CZ", "Bohemian Switzerland", "park", 14.1, 50.7, 14.6, 51.1, "Europe/Prague"], ["CZ", "Krkonose Mountains", "mountain", 15.3, 50.5, 16.1, 50.9, "Europe/Prague"],
  ["DK", "Bornholm", "island", 14.6, 54.9, 15.2, 55.3, "Europe/Copenhagen"], ["DK", "North Zealand Coast", "coastal", 11.8, 55.8, 12.7, 56.2, "Europe/Copenhagen"],
  ["EE", "Saaremaa", "island", 21.8, 57.8, 23.4, 58.7, "Europe/Tallinn"], ["EE", "Lahemaa National Park", "park", 25.6, 59.4, 26.3, 59.7, "Europe/Tallinn"],
  ["FI", "Finnish Lapland", "mountain", 20.5, 66.0, 30.0, 70.1, "Europe/Helsinki"], ["FI", "Finnish Lakeland", "resort", 25.0, 60.8, 31.0, 63.5, "Europe/Helsinki"],
  ["FR", "French Alps", "mountain", 5.5, 44.0, 7.7, 46.5, "Europe/Paris"], ["FR", "French Riviera", "coastal", 5.8, 43.0, 7.6, 43.9, "Europe/Paris"],
  ["DE", "Black Forest", "mountain", 7.5, 47.5, 8.6, 49.0, "Europe/Berlin"], ["DE", "Bavarian Alps", "mountain", 10.0, 47.2, 13.0, 48.0, "Europe/Berlin"],
  ["GR", "Crete", "island", 23.4, 34.7, 26.4, 35.7, "Europe/Athens"], ["GR", "Cyclades", "island", 24.0, 36.0, 26.0, 38.0, "Europe/Athens"],
  ["HU", "Lake Balaton", "resort", 17.1, 46.6, 18.2, 47.1, "Europe/Budapest"], ["HU", "Hortobagy National Park", "park", 20.7, 47.4, 21.4, 47.9, "Europe/Budapest"],
  ["IE", "Killarney National Park", "park", -9.8, 51.8, -9.3, 52.1, "Europe/Dublin"], ["IE", "Wild Atlantic Way", "coastal", -10.7, 51.4, -8.7, 55.4, "Europe/Dublin"],
  ["IT", "Dolomites", "mountain", 10.8, 45.9, 12.7, 47.1, "Europe/Rome"], ["IT", "Amalfi Coast", "coastal", 14.4, 40.5, 14.8, 40.8, "Europe/Rome"],
  ["LV", "Gauja National Park", "park", 24.8, 57.1, 25.6, 57.6, "Europe/Riga"], ["LV", "Jurmala Coast", "resort", 23.4, 56.8, 24.1, 57.1, "Europe/Riga"],
  ["LT", "Curonian Spit", "coastal", 20.9, 54.9, 21.2, 55.8, "Europe/Vilnius"], ["LT", "Aukstaitija National Park", "park", 25.7, 55.2, 26.4, 55.6, "Europe/Vilnius"],
  ["LU", "Mullerthal", "park", 6.1, 49.6, 6.5, 49.9, "Europe/Luxembourg"], ["LU", "Luxembourg Moselle", "resort", 6.2, 49.4, 6.5, 49.7, "Europe/Luxembourg"],
  ["MT", "Gozo", "island", 14.1, 36.0, 14.4, 36.1, "Europe/Malta"], ["MT", "Comino", "island", 14.3, 36.0, 14.35, 36.03, "Europe/Malta"],
  ["NL", "Wadden Islands", "island", 4.7, 52.8, 7.2, 53.6, "Europe/Amsterdam"], ["NL", "Zeeland Coast", "coastal", 3.3, 51.2, 4.3, 51.8, "Europe/Amsterdam"],
  ["PL", "Tatra Mountains", "mountain", 19.7, 49.1, 20.3, 49.4, "Europe/Warsaw"], ["PL", "Masurian Lakes", "resort", 20.5, 53.5, 22.2, 54.3, "Europe/Warsaw"],
  ["PT", "Algarve", "coastal", -9.0, 36.9, -7.4, 37.5, "Europe/Lisbon"], ["PT", "Madeira", "island", -17.3, 32.5, -16.6, 32.9, "Atlantic/Madeira"],
  ["RO", "Romanian Carpathians", "mountain", 22.0, 45.0, 26.8, 47.8, "Europe/Bucharest"], ["RO", "Danube Delta", "park", 28.5, 44.5, 29.8, 45.5, "Europe/Bucharest"],
  ["SK", "High Tatras", "mountain", 19.5, 49.0, 20.5, 49.4, "Europe/Bratislava"], ["SK", "Slovak Paradise", "park", 20.1, 48.8, 20.6, 49.1, "Europe/Bratislava"],
  ["SI", "Julian Alps", "mountain", 13.4, 46.1, 14.3, 46.6, "Europe/Ljubljana"], ["SI", "Lake Bled", "resort", 14.0, 46.3, 14.2, 46.5, "Europe/Ljubljana"],
  ["ES", "Mallorca", "island", 2.2, 39.2, 3.5, 40.0, "Europe/Madrid"], ["ES", "Costa del Sol", "coastal", -5.4, 36.3, -3.8, 36.9, "Europe/Madrid"],
  ["SE", "Swedish Lapland", "mountain", 14.0, 65.5, 23.8, 69.2, "Europe/Stockholm"], ["SE", "Gotland", "island", 18.1, 56.9, 19.4, 58.0, "Europe/Stockholm"],
  ["CH", "Swiss Alps", "mountain", 6.5, 45.8, 10.5, 47.0, "Europe/Zurich"], ["CH", "Bernese Oberland", "mountain", 7.3, 46.3, 8.5, 47.0, "Europe/Zurich"],
];

function slug(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function areaCode(value) {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return normalized ? `area:${normalized}` : null;
}

function ring(minLon, minLat, maxLon, maxLat) {
  return [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
}

function pointInRing([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function geometryContains(point, geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

const [geoText, nutsText, admin1Text, admin2Text, catalogMetadataText] = await Promise.all([
  readFile(geonamesPath, "utf8"), readFile(nutsPath, "utf8"), readFile(admin1Path, "utf8"), readFile(admin2Path, "utf8"),
  readFile(path.join(root, "data/catalog-metadata.json"), "utf8"),
]);
const catalogMetadata = JSON.parse(catalogMetadataText);
const coastalLocationIds = new Set(catalogMetadata.coastalLocationIds);
const administrativeNames = new Map([...admin1Text.trim().split("\n"), ...admin2Text.trim().split("\n")].flatMap((line) => {
  const [code, name, ascii] = line.split("\t");
  return [[code, [...new Set([name, ascii].filter(Boolean))]]];
}));
const nuts = JSON.parse(nutsText).features.filter((feature) => Number(feature.properties.LEVL_CODE) === 2);
function nutsCode(point, countryCode) {
  const nutsCountry = countryCode === "GR" ? "EL" : countryCode;
  return nuts.find((feature) => feature.properties.CNTR_CODE === nutsCountry && geometryContains(point, feature.geometry))?.properties.NUTS_ID;
}

const parsedCities = geoText.trim().split("\n").map((line) => {
  const fields = line.split("\t");
  return {
    id: fields[0], name: fields[1], ascii: fields[2], alternates: fields[3], latitude: Number(fields[4]), longitude: Number(fields[5]),
    featureCode: fields[7], countryCode: fields[8], admin1: fields[10], admin2: fields[11], population: Number(fields[14] || 0), timezone: fields[17],
  };
}).filter((city) => countries[city.countryCode] && ["PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLC"].includes(city.featureCode) && Number.isFinite(city.latitude) && Number.isFinite(city.longitude));

const byCountry = Object.fromEntries(Object.keys(countries).map((code) => [code, parsedCities.filter((city) => city.countryCode === code).sort((a, b) => b.population - a.population)]));
const selected = new Map();
for (const [code, [, capital]] of Object.entries(countries)) {
  const candidates = byCountry[code];
  const capitalCity = candidates.find((city) => city.name === capital || city.ascii === capital);
  if (!capitalCity) throw new Error(`Capital not found: ${capital}, ${code}`);
  selected.set(capitalCity.id, capitalCity);
  for (const city of candidates.slice(0, 5)) selected.set(city.id, city);
}

const cityTarget = 500 - regions.length;
const countryCounts = () => Object.fromEntries(Object.keys(countries).map((code) => [code, [...selected.values()].filter((city) => city.countryCode === code).length]));
for (const city of parsedCities.sort((a, b) => b.population - a.population)) {
  if (selected.size >= cityTarget) break;
  const counts = countryCounts();
  if (counts[city.countryCode] < 28) selected.set(city.id, city);
}
for (const city of parsedCities.sort((a, b) => b.population - a.population)) {
  if (selected.size >= cityTarget) break;
  selected.set(city.id, city);
}
if (selected.size !== cityTarget) throw new Error(`Expected ${cityTarget} cities, got ${selected.size}`);

const cityLocations = [...selected.values()].map((city) => {
  const [country, capital] = countries[city.countryCode];
  const center = [city.longitude, city.latitude];
  const aliases = [...new Set([city.ascii, ...city.alternates.split(",")])]
    .filter((alias) => alias && alias !== city.name && alias.length <= 40 && /^[\p{L}\p{M} .'-]+$/u.test(alias)).slice(0, 4);
  const code = nutsCode(center, city.countryCode);
  const adminCodes = [`${city.countryCode}.${city.admin1}`, `${city.countryCode}.${city.admin1}.${city.admin2}`];
  const areaCodes = [city.name, city.ascii, ...adminCodes.flatMap((adminCode) => administrativeNames.get(adminCode) || [])].map(areaCode).filter(Boolean);
  return {
    id: `${city.countryCode.toLowerCase()}-${slug(city.ascii || city.name)}`,
    name: city.name,
    aliases,
    country,
    countryCode: city.countryCode,
    type: city.name === capital || city.ascii === capital ? "capital" : "city",
    centroid: center,
    geometry: { kind: "radius", center, radiusKm: 15 },
    timezone: city.timezone,
    sourceRegionCodes: { meteoalarm: [...new Set([code, ...areaCodes, `${city.countryCode}:country`].filter(Boolean))] },
    coverageRef: city.countryCode,
    provenance: { name: `https://www.geonames.org/${city.id}`, license: "CC-BY-4.0" },
  };
});

const regionLocations = regions.map(([countryCode, name, type, minLon, minLat, maxLon, maxLat, timezone]) => {
  const centroid = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const code = nutsCode(centroid, countryCode);
  return {
    id: `${countryCode.toLowerCase()}-${slug(name)}`,
    name,
    aliases: [],
    country: countries[countryCode][0],
    countryCode,
    type,
    centroid,
    geometry: { kind: "polygon", coordinates: [ring(minLon, minLat, maxLon, maxLat)] },
    timezone,
    sourceRegionCodes: { meteoalarm: [...new Set([code, areaCode(name), `${countryCode}:country`].filter(Boolean))] },
    coverageRef: countryCode,
    provenance: { name: "https://github.com/hypertrial/travelcanary/blob/main/data/locations.json", license: "CC0-1.0 approximate matching area" },
  };
});

const supplementalLocations = [
  ["pt-ponta-delgada", "Ponta Delgada", ["Sao Miguel"], -25.6666, 37.7412, "oriental", "https://www.geonames.org/3372783"],
  ["pt-horta", "Horta", ["Faial"], -28.6265, 38.5347, "central", "https://www.geonames.org/3372988"],
  ["pt-santa-cruz-das-flores", "Santa Cruz das Flores", ["Flores"], -31.127, 39.4556, "ocidental", "https://www.geonames.org/3372745"],
].map(([id, name, aliases, longitude, latitude, azoresGroup, provenance]) => ({
  id, name, aliases, country: "Portugal", countryCode: "PT", type: "city",
  centroid: [longitude, latitude], geometry: { kind: "radius", center: [longitude, latitude], radiusKm: 15 },
  timezone: "Atlantic/Azores",
  sourceRegionCodes: { meteoalarm: ["PT20", areaCode(name), "PT:country"], slf: [], euregio: [], nationalCivilAlerts: [`azores:${azoresGroup}`] },
  coverageRef: "PT", provenance: { name: provenance, license: "CC-BY-4.0" },
  isCoastal: true, airQualitySamplePoints: [[longitude, latitude]],
}));

const locations = [...cityLocations, ...regionLocations, ...supplementalLocations].sort((a, b) => a.countryCode.localeCompare(b.countryCode) || a.name.localeCompare(b.name));
const ids = new Set();
for (const location of locations) {
  let id = location.id;
  let suffix = 2;
  while (ids.has(id)) id = `${location.id}-${suffix++}`;
  location.id = id;
  ids.add(id);
}

for (const location of locations) {
  location.isCoastal = coastalLocationIds.has(location.id);
  location.airQualitySamplePoints = catalogMetadata.airQualitySamplePointOverrides[location.id] || [location.centroid];
  location.sourceRegionCodes = {
    meteoalarm: [...new Set([
      ...(catalogMetadata.sourceRegionCodeOverrides[location.id]?.meteoalarm || []),
      ...location.sourceRegionCodes.meteoalarm,
    ])],
    slf: catalogMetadata.sourceRegionCodeOverrides[location.id]?.slf || [],
    euregio: catalogMetadata.sourceRegionCodeOverrides[location.id]?.euregio || [],
    nationalCivilAlerts: catalogMetadata.sourceRegionCodeOverrides[location.id]?.nationalCivilAlerts || [],
  };
}

const primaryNames = new Set(locations.map((location) => `${location.countryCode}:${location.name.toLocaleLowerCase("en")}`));
const usedAliases = new Set();
for (const location of locations) {
  location.aliases = location.aliases.filter((alias) => {
    const key = `${location.countryCode}:${alias.toLocaleLowerCase("en")}`;
    if (primaryNames.has(key) || usedAliases.has(key)) return false;
    usedAliases.add(key);
    return true;
  });
}

const publicLocations = locations.map(({ id, name, aliases, country, countryCode, type, centroid, isCoastal, timezone }) => ({
  id, name, aliases, country, countryCode, type, centroid, isCoastal, timezone,
}));

await mkdir(path.join(root, "data"), { recursive: true });
await mkdir(path.join(root, "public"), { recursive: true });
await writeFile(path.join(root, "data/locations.json"), `${JSON.stringify(locations, null, 2)}\n`);
await writeFile(path.join(root, "public/locations.json"), `${JSON.stringify(publicLocations)}\n`);
console.log(`Generated ${locations.length} locations (${cityLocations.length + supplementalLocations.length} cities, ${regionLocations.length} regions).`);
