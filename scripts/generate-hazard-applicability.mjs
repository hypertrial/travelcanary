import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const MAX_DISTANCE_KM = 200;
const GVP_VERSION = "5.4.0";
const CITATION_URL = "https://doi.org/10.5479/si.GVP.VOTW5-2026.5.4";
const WFS_URL = "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=GVP-VOTW%3ASmithsonian_VOTW_Holocene_Volcanoes&outputFormat=application%2Fjson";

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointSegmentDistanceKm(point, start, end) {
  const latitude = point[1] * Math.PI / 180;
  const project = ([longitude, sourceLatitude]) => [
    (longitude - point[0]) * 111.32 * Math.cos(latitude),
    (sourceLatitude - point[1]) * 110.574,
  ];
  const [ax, ay] = project(start);
  const [bx, by] = project(end);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToLocationKm(coordinates, location) {
  if (location.geometry.kind === "radius") {
    return Math.max(0, distanceKm(coordinates, location.geometry.center) - location.geometry.radiusKm);
  }
  const rings = location.geometry.coordinates;
  if (pointInRing(coordinates, rings[0]) && !rings.slice(1).some((ring) => pointInRing(coordinates, ring))) return 0;
  return Math.min(...rings.flatMap((ring) => ring.slice(1).map((end, index) => pointSegmentDistanceKm(coordinates, ring[index], end))));
}

export function generateApplicability(locations, collection, reviewedAt) {
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) throw new Error("GVP input must be a GeoJSON FeatureCollection");
  const volcanoes = collection.features.map((feature) => {
    const coordinates = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null;
    const volcanoId = String(feature?.properties?.Volcano_Number || "");
    const name = String(feature?.properties?.Volcano_Name || "");
    if (!coordinates || coordinates.length !== 2 || !volcanoId || !name) throw new Error("GVP feature is missing point geometry, volcano ID, or name");
    return { volcanoId, name, coordinates };
  });
  if (new Set(volcanoes.map(({ volcanoId }) => volcanoId)).size !== volcanoes.length) throw new Error("GVP input contains duplicate volcano IDs");
  const applicable = locations.flatMap((location) => {
    const contributing = volcanoes.map((volcano) => ({
      volcanoId: volcano.volcanoId,
      name: volcano.name,
      distanceKm: distanceToLocationKm(volcano.coordinates, location),
    })).filter(({ distanceKm: minimum }) => minimum <= MAX_DISTANCE_KM)
      .map((volcano) => ({ ...volcano, distanceKm: Math.round(volcano.distanceKm * 10) / 10 }))
      .sort((a, b) => a.distanceKm - b.distanceKm || a.volcanoId.localeCompare(b.volcanoId));
    return contributing.length ? [{
      locationId: location.id,
      minimumDistanceKm: contributing[0].distanceKm,
      volcanoes: contributing,
    }] : [];
  });
  return {
    schemaVersion: 1,
    reviewedAt,
    source: {
      publisher: "Smithsonian Global Volcanism Program",
      dataset: "Volcanoes of the World — Holocene Volcanoes",
      version: GVP_VERSION,
      citationUrl: CITATION_URL,
      wfsUrl: WFS_URL,
    },
    rule: { maximumDistanceKm: MAX_DISTANCE_KM, aviationAshExcluded: true },
    overrides: [],
    locations: applicable,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  if (inputIndex < 0 || !args[inputIndex + 1]) throw new Error("Usage: node scripts/generate-hazard-applicability.mjs --input <GVP GeoJSON> [--reviewed-at YYYY-MM-DD]");
  const dateIndex = args.indexOf("--reviewed-at");
  const reviewedAt = dateIndex >= 0 ? args[dateIndex + 1] : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) throw new Error("Review date must be YYYY-MM-DD");
  const [locationText, sourceText] = await Promise.all([readFile("data/locations.json", "utf8"), readFile(args[inputIndex + 1], "utf8")]);
  const artifact = generateApplicability(JSON.parse(locationText), JSON.parse(sourceText), reviewedAt);
  artifact.source.sha256 = createHash("sha256").update(sourceText).digest("hex");
  const generated = `${JSON.stringify(artifact, null, 2)}\n`;
  if (args.includes("--check")) {
    if (await readFile("data/hazard-applicability.json", "utf8") !== generated) throw new Error("Volcanic applicability must be regenerated from the reviewed input");
  } else await writeFile("data/hazard-applicability.json", generated);
  console.log(`Generated volcanic applicability for ${artifact.locations.length} of ${JSON.parse(locationText).length} destinations.`);
}

if (process.argv[1]?.endsWith("generate-hazard-applicability.mjs")) await main();
