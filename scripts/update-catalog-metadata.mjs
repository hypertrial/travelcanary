import { readFile, writeFile } from "node:fs/promises";

const metadata = JSON.parse(await readFile("data/catalog-metadata.json", "utf8"));
const locations = JSON.parse(await readFile("data/locations.json", "utf8"));
const coastal = new Set(metadata.coastalLocationIds);

for (const location of locations) {
  location.isCoastal = coastal.has(location.id);
  location.airQualitySamplePoints = metadata.airQualitySamplePointOverrides[location.id] || [location.centroid];
  location.sourceRegionCodes = {
    meteoalarm: [...new Set([
      ...(metadata.sourceRegionCodeOverrides[location.id]?.meteoalarm || []),
      ...location.sourceRegionCodes.meteoalarm,
    ])],
    slf: metadata.sourceRegionCodeOverrides[location.id]?.slf || [],
    euregio: metadata.sourceRegionCodeOverrides[location.id]?.euregio || [],
    nationalCivilAlerts: metadata.sourceRegionCodeOverrides[location.id]?.nationalCivilAlerts || [],
  };
}

const publicLocations = locations.map(({ id, name, aliases, country, countryCode, type, centroid, isCoastal, timezone }) => ({
  id, name, aliases, country, countryCode, type, centroid, isCoastal, timezone,
}));

await writeFile("data/locations.json", `${JSON.stringify(locations, null, 2)}\n`);
await writeFile("public/locations.json", `${JSON.stringify(publicLocations)}\n`);
