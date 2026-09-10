import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const versionIndex = args.indexOf("--catalog");
const version = versionIndex < 0 ? 2 : Number(args[versionIndex + 1]);
if (![2, 3].includes(version) || args.some((arg, index) => !["--check", "--catalog"].includes(arg) && !(versionIndex >= 0 && index === versionIndex + 1))) throw new Error("Use --catalog 2|3 and optional --check");
const release = JSON.parse(await readFile(`data/catalog-releases/${version}.json`, "utf8"));
const identities = JSON.parse(await readFile("data/country-identities.json", "utf8"));
const legacyGeography = JSON.parse(await readFile("data/catalog-releases/2-geography.json", "utf8"));
const countryCodes = version === 2 ? legacyGeography.countryOrder
  : [...new Set(release.locationIds.map((id) => id.slice(0, 2).toUpperCase()))].sort();
if (countryCodes.some((code) => !identities.countries[code])) throw new Error("Catalog country identity is missing");
const scope = version === 3 ? JSON.parse(await readFile("data/catalog-releases/3-geography.json", "utf8")) : null;
const covered = new Set(countryCodes);
const envelope = scope?.envelope || legacyGeography.envelope;
const sourcePath = process.env.NATURAL_EARTH_PATH || scope?.input || "/tmp/travelcanary-ne-admin0.geojson";
const outputPath = path.join(process.cwd(), "public", ...(version === 3 ? ["catalogs", "3"] : []), "covered-countries.geojson");

function countryCode(properties) {
  for (const value of [properties.ISO_A2_EH, properties.ISO_A2, properties.WB_A2]) {
    if (typeof value === "string" && /^[A-Z]{2}$/.test(value)) return value;
  }
  return null;
}

function ringBbox(ring) {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function roundCoord(value, code) {
  return scope?.preservePrecision.includes(code) ? value : Math.round(value * 100) / 100;
}

function simplifyRing(ring, code) {
  const simplified = [];
  for (const [lng, lat] of ring) {
    const point = [roundCoord(lng, code), roundCoord(lat, code)];
    const previous = simplified[simplified.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) simplified.push(point);
  }
  if (simplified.length < 4) return null;
  const [firstLng, firstLat] = simplified[0];
  const [lastLng, lastLat] = simplified[simplified.length - 1];
  if (firstLng !== lastLng || firstLat !== lastLat) simplified.push([firstLng, firstLat]);
  if (version === 2) return simplified.length >= 4 ? simplified : null;
  if (new Set(simplified.map((point) => point.join(","))).size < 3) return null;
  let area = 0;
  for (let index = 1; index < simplified.length; index += 1) area += simplified[index - 1][0] * simplified[index][1] - simplified[index][0] * simplified[index - 1][1];
  return Math.abs(area) > 1e-12 ? simplified : null;
}

function keepPolygon(polygon, code) {
  const outer = polygon[0];
  if (!outer || !bboxIntersects(ringBbox(outer), scope?.countryEnvelopes[code] || envelope)) return null;
  if (version === 2) {
    const rings = polygon.map((ring) => simplifyRing(ring, code)).filter(Boolean);
    return rings.length > 0 ? rings : null;
  }
  const outerRing = simplifyRing(outer, code);
  if (!outerRing) return null;
  return [outerRing, ...polygon.slice(1).map((ring) => simplifyRing(ring, code)).filter(Boolean)];
}

function keepGeometry(geometry, code) {
  if (geometry.type === "Polygon") {
    const polygon = keepPolygon(geometry.coordinates, code);
    return polygon ? { type: "Polygon", coordinates: polygon } : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates.map((polygon) => keepPolygon(polygon, code)).filter(Boolean);
    if (polygons.length === 0) return null;
    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

const input = await readFile(sourcePath);
const hash = createHash("sha256").update(input).digest("hex");
if (scope && ![scope.inputSha256, scope.sourceSha256].includes(hash)) throw new Error("Unreviewed country geometry input");
const raw = JSON.parse(input.toString("utf8"));
const byCountry = new Map();
for (const feature of raw.features || []) {
  const code = countryCode(feature.properties || {});
  if (!code || !covered.has(code) || !feature.geometry) continue;
  const geometry = keepGeometry(feature.geometry, code);
  if (!geometry) continue;
  const existing = byCountry.get(code);
  if (!existing) {
    byCountry.set(code, geometry);
    continue;
  }
  const existingPolygons = existing.type === "Polygon" ? [existing.coordinates] : existing.coordinates;
  const nextPolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  byCountry.set(code, { type: "MultiPolygon", coordinates: [...existingPolygons, ...nextPolygons] });
}

const missing = countryCodes.filter((code) => !byCountry.has(code));
if (missing.length > 0) throw new Error(`Covered-country geometry is missing ${missing.join(", ")}`);

const collection = {
  type: "FeatureCollection",
  features: countryCodes.map((code) => ({
    type: "Feature",
    properties: { countryCode: code },
    geometry: byCountry.get(code),
  })),
};

const body = `${JSON.stringify(collection)}\n`;
if (args.includes("--check")) {
  if (await readFile(outputPath, "utf8") !== body) throw new Error("Covered-country artifact is out of date");
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body);
}
console.log(`Catalog ${version}: ${collection.features.length} countries, ${Buffer.byteLength(body)} display-geometry bytes`);
