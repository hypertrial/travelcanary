import { readFile, writeFile } from "node:fs/promises";

const [locations, meteoalarmCapabilities, vigicruesMapping, avalancheReportMapping, ehydMapping, nationalWarningManifest, catalogMetadata] = await Promise.all([
  readFile("data/locations.json", "utf8").then(JSON.parse),
  readFile("data/meteoalarm-capabilities.json", "utf8").then(JSON.parse),
  readFile("data/vigicrues-section-mapping.json", "utf8").then(JSON.parse),
  readFile("data/avalanche-report-region-mapping.json", "utf8").then(JSON.parse),
  readFile("data/ehyd-station-mapping.json", "utf8").then(JSON.parse),
  readFile("data/national-warning-sources.json", "utf8").then(JSON.parse),
  readFile("data/catalog-metadata.json", "utf8").then(JSON.parse),
]);
const countries = [...new Set(locations.map(({ countryCode }) => countryCode))].sort();
const fallbackIds = locations
  .filter((location) => location.sourceRegionCodes.meteoalarm.every((code) => code.endsWith(":country") || code.startsWith("area:")))
  .map(({ id }) => id);

const entry = (status, providerIds) => ({ status, providerIds });
const coverageSystems = (country) => country.systems.filter((system) => system.status === "active"
  && system.runtimeTarget === "national-civil-alerts" && system.role === "coverage"
  && system.coverageContribution !== "none");
const hazardCoverage = {
  "severe-weather": entry("monitored", ["meteoalarm"]),
  flood: entry("partial", ["meteoalarm", "cems-rapid-mapping", "gfm"]),
  "extreme-heat": entry("monitored", ["meteoalarm"]),
  "extreme-cold": entry("monitored", ["meteoalarm"]),
  wildfire: entry("partial", ["meteoalarm", "cems-rapid-mapping", "effis-active-fire"]),
  "fire-danger": entry("monitored", ["effis-fire-danger"]),
  "air-quality": entry("monitored", ["eea-aqi"]),
  earthquake: entry("monitored", ["usgs", "emsc"]),
  volcano: entry("not_monitored", ["eonet"]),
  drought: entry("not_monitored", ["edo-drought"]),
  "snow-ice": entry("monitored", ["meteoalarm"]),
  avalanche: entry("partial", ["meteoalarm"]),
  coastal: entry("partial", ["meteoalarm"]),
  "civil-unrest": entry("not_monitored", ["national-civil-alerts"]),
  security: entry("not_monitored", ["national-civil-alerts"]),
  terrorism: entry("not_monitored", ["national-civil-alerts"]),
  "armed-conflict": entry("not_monitored", ["national-civil-alerts"]),
  industrial: entry("partial", ["cems-rapid-mapping", "national-civil-alerts"]),
  nuclear: entry("not_monitored", ["national-civil-alerts"]),
  "civil-emergency": entry("partial", ["cems-rapid-mapping", "national-civil-alerts"]),
};

const locationOverrides = Object.fromEntries(fallbackIds.map((id) => [id, {
  "severe-weather": entry("partial", ["meteoalarm"]),
  "extreme-heat": entry("partial", ["meteoalarm"]),
  "extreme-cold": entry("partial", ["meteoalarm"]),
  "snow-ice": entry("partial", ["meteoalarm"]),
}]));
for (const { locationId } of vigicruesMapping.mappings) locationOverrides[locationId] = {
  ...locationOverrides[locationId], flood: entry("partial", ["meteoalarm", "cems-rapid-mapping", "gfm", "vigicrues"]),
};
for (const { locationId } of ehydMapping.mappings) locationOverrides[locationId] = {
  ...locationOverrides[locationId], flood: entry("partial", ["meteoalarm", "cems-rapid-mapping", "gfm", "ehyd-flood"]),
};
for (const location of locations.filter(({ countryCode, type }) => countryCode === "CH" && ["mountain", "resort", "park"].includes(type))) {
  locationOverrides[location.id] = { ...locationOverrides[location.id], avalanche: entry("monitored", ["slf-avalanche"]) };
}
const enabledAvalancheFeeds = new Set(avalancheReportMapping.partitions.filter(({ enabled }) => enabled).map(({ feedCode }) => feedCode));
for (const { locationId } of avalancheReportMapping.mappings.filter(({ feedCodes }) => feedCodes.some((feedCode) => enabledAvalancheFeeds.has(feedCode)))) locationOverrides[locationId] = {
  ...locationOverrides[locationId], avalanche: entry("monitored", ["euregio-avalanche"]),
};
for (const locationId of catalogMetadata.airQualityUnsupportedLocationIds) locationOverrides[locationId] = {
  ...locationOverrides[locationId], "air-quality": entry("not_monitored", []),
};

const coverage = {
  schemaVersion: 2,
  countries: Object.fromEntries(countries.map((countryCode) => {
    const capability = meteoalarmCapabilities.countries[countryCode];
    if (!capability) throw new Error(`Missing MeteoAlarm capability audit for ${countryCode}`);
    const hazards = structuredClone(hazardCoverage);
    for (const hazard of meteoalarmCapabilities.verifiedCoreHazards) {
      if (!capability.regionalCodesVerified || capability.unsupportedCoreHazards.includes(hazard)) {
        hazards[hazard] = entry("partial", ["meteoalarm"]);
      }
    }
    if (countryCode === "CH") hazards.flood = entry("partial", ["meteoalarm", "cems-rapid-mapping", "gfm", "foen-flood"]);
    const nationalCountry = nationalWarningManifest.countries[countryCode];
    if (!nationalCountry) throw new Error(`Missing national-warning audit for ${countryCode}`);
    for (const system of coverageSystems(nationalCountry)) for (const hazard of system.hazards) {
      if (system.coverageLocationIds?.length) continue;
      const status = system.coverageContribution === "complete" ? "monitored" : "partial";
      hazards[hazard] = entry(status, [...new Set([...hazards[hazard].providerIds, "national-civil-alerts"])]);
    }
    return [countryCode, { hazards }];
  })),
  locationOverrides,
};

for (const [countryCode, nationalCountry] of Object.entries(nationalWarningManifest.countries)) {
  for (const system of coverageSystems(nationalCountry)) {
    if (!system.coverageLocationIds?.length) continue;
    for (const locationId of system.coverageLocationIds) for (const hazard of system.hazards) {
      const base = coverage.countries[countryCode].hazards[hazard];
      const status = system.coverageContribution === "complete" ? "monitored" : "partial";
      locationOverrides[locationId] = { ...locationOverrides[locationId], [hazard]: entry(status, [...new Set([...base.providerIds, "national-civil-alerts"])]) };
    }
  }
}

const serialized = `${JSON.stringify(coverage, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile("data/coverage.json", "utf8");
  if (current !== serialized) throw new Error("data/coverage.json is stale; run npm run coverage:generate");
} else {
  await writeFile("data/coverage.json", serialized);
}
