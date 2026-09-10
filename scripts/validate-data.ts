import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { CoverageMatrixSchema, HazardTypeSchema, LocationSchema, PublicLocationSchema, countryCodes } from "../src/lib/domain/schemas";
import { CompleteSnapshotSchema } from "../src/lib/snapshot-validation";
import { providerRegistry } from "../src/lib/provider-registry";
import { nationalWarningManifest, nationalWarningSources } from "../src/lib/national-warning-sources";
import { hazardApplicability } from "../src/lib/hazard-applicability";
import { meteoAlarmFeedSlugs } from "../src/lib/ingestion/adapters/meteoalarm";
import { conditionSources } from "../src/lib/conditions/sources";
import dhmzMapping from "../data/dhmz-warning-mapping.json";

const locations = LocationSchema.array().parse(JSON.parse(await readFile("data/locations.json", "utf8")));
const publicLocations = PublicLocationSchema.array().parse(JSON.parse(await readFile("public/locations.json", "utf8")));
const coverage = CoverageMatrixSchema.parse(JSON.parse(await readFile("data/coverage.json", "utf8")));
const imgwMapping = JSON.parse(await readFile("data/imgw-hydrology-mapping.json", "utf8")) as { reviewedAt: string; mappings: Array<{ locationId: string; stationIds: string[]; bulletinTokens: string[] }> };
const chmiMapping = JSON.parse(await readFile("data/chmi-hydrology-mapping.json", "utf8")) as {
  reviewedAt: string;
  geometrySource: { url: string; downloadedAt: string; sha256: string; featureCount: number };
  mappings: Array<{ locationId: string; orpCodes: string[]; stations: Array<{ objID: string; kind: string; spa1: number; spa2: number; spa3: number }> }>;
};
const gdeltPublishers = JSON.parse(await readFile("data/gdelt-publishers.json", "utf8")) as { reviewedAt: string; publishers: Array<{ domain: string; parentGroup: string; sourceName: string }> };
const meteoalarmCapabilities = JSON.parse(await readFile("data/meteoalarm-capabilities.json", "utf8")) as {
  reviewedAt: string;
  verifiedCoreHazards: string[];
  countries: Record<string, { feedSlug: string; regionalCodesVerified: boolean; unsupportedCoreHazards: string[] }>;
};
const catalogMetadata = JSON.parse(await readFile("data/catalog-metadata.json", "utf8")) as {
  provenance: { coastalClassification: string; airQualitySampling: string; airQualityCoverage: string; meteoalarmRegions: string };
  coastalLocationIds: string[];
  airQualitySamplePointOverrides: Record<string, [number, number][]>;
  airQualityUnsupportedLocationIds: string[];
  sourceRegionCodeOverrides: Record<string, { meteoalarm?: string[]; slf?: string[]; euregio?: string[]; nationalCivilAlerts?: string[] }>;
};
const infrastructureMapping = JSON.parse(await readFile("data/infrastructure-condition-mapping.json", "utf8")) as {
  reviewedAt: string; sources: string[]; sweden: Record<string, string[]>; germany: Array<[string, string]>; cyprus: Record<string, string[]>;
  unsupported: Array<{ locationId: string; reason: string }>;
};
const infrastructureReview = JSON.parse(await readFile("data/infrastructure-source-review.json", "utf8")) as {
  reviewedAt: string; nextReviewAt: string;
  active: Array<{ id: string; country: string; authority: string; status: string; accessBasis: string; endpoint: string; officialUrl: string; evidence: string[]; terms: string; requestsPerRun: number; bytesPerResponse: number; blocker: null }>;
  inactive: Array<{ id: string; status: string; authority: string; accessBasis: string; endpoint: string | null; officialUrl: string; evidence: string[]; terms: string;
    requestsPerRun: number; bytesPerResponse: number; blocker: string; reason: string; trigger: string }>;
};
const coastalLocationIds = new Set(catalogMetadata.coastalLocationIds);
const verifiedCoreHazards = HazardTypeSchema.array().nonempty().parse(meteoalarmCapabilities.verifiedCoreHazards);
const implementedNationalTransports = new Set([
  "at-alert", "chmi-hydrology", "fmi-cap", "fr-alert", "ipma-warnings-json", "lhp-flood", "met-eireann-json",
  "dpc-flood-bulletin", "lu-alert", "imgw-hydrology", "catalonia-plans", "krisinformation",
  "aemet-cap", "dhmz-cap", "lvgmc-flood",
]);
if (Number.isNaN(Date.parse(meteoalarmCapabilities.reviewedAt))) throw new Error("MeteoAlarm capability review date is invalid");

if (locations.length !== 503) throw new Error(`Catalog must contain exactly 503 locations; found ${locations.length}`);
if (publicLocations.length !== 503) throw new Error("Public catalog count differs from internal catalog");

const ids = new Set<string>();
const searchKeys = new Set<string>();
let countryFallbackOnly = 0;
for (const location of locations) {
  if (ids.has(location.id)) throw new Error(`Duplicate location id: ${location.id}`);
  ids.add(location.id);
  if (location.sourceRegionCodes.meteoalarm.length === 0) throw new Error(`Missing MeteoAlarm mapping: ${location.id}`);
  if (location.isCoastal !== coastalLocationIds.has(location.id)) throw new Error(`Coastal classification differs from reviewed metadata: ${location.id}`);
  if (location.type === "coastal" && !location.isCoastal) throw new Error(`Coastal destination type requires coastal classification: ${location.id}`);
  if (location.type === "coastal" && ["AT", "CZ", "HU", "LU", "SK", "CH"].includes(location.countryCode)) {
    throw new Error(`Landlocked country cannot have a coastal destination type: ${location.id}`);
  }
  if (location.airQualitySamplePoints.length < 1 || location.airQualitySamplePoints.length > 3) throw new Error(`Invalid EEA sample points: ${location.id}`);
  if (location.sourceRegionCodes.meteoalarm.every((code) => code.endsWith(":country") || code.startsWith("area:"))) countryFallbackOnly += 1;
  if (location.geometry.kind === "polygon") {
    const vertices = location.geometry.coordinates.reduce((count, ring) => count + ring.length, 0);
    if (vertices > 250) throw new Error(`Geometry exceeds 250 vertices: ${location.id}`);
  }
  new Intl.DateTimeFormat("en", { timeZone: location.timezone }).format(new Date());
  for (const name of [location.name, ...location.aliases]) {
    const key = `${location.countryCode}:${name.toLocaleLowerCase("en")}`;
    if (searchKeys.has(key)) throw new Error(`Duplicate in-country name or alias: ${key}`);
    searchKeys.add(key);
  }
}

const expectedPublicLocations = locations.map(({ id, name, aliases, country, countryCode, type, centroid, isCoastal, timezone }) => ({
  id, name, aliases, country, countryCode, type, centroid, isCoastal, timezone,
}));
if (JSON.stringify(publicLocations) !== JSON.stringify(expectedPublicLocations)) {
  throw new Error("Public catalog is stale or differs from the internal catalog projection");
}

for (const code of countryCodes) {
  const countryLocations = locations.filter((location) => location.countryCode === code);
  if (countryLocations.length < 5) throw new Error(`${code} has fewer than five locations`);
  if (countryLocations.filter((location) => location.type === "capital").length !== 1) throw new Error(`${code} must have exactly one capital`);
  if (!coverage.countries[code]) throw new Error(`Coverage matrix is missing ${code}`);
  if (!nationalWarningSources[code]) throw new Error(`National-warning audit is missing ${code}`);
  const meteoalarm = meteoalarmCapabilities.countries[code];
  if (!meteoalarm || meteoalarm.feedSlug !== meteoAlarmFeedSlugs[code]) throw new Error(`MeteoAlarm capability audit is missing or stale for ${code}`);
  if (!meteoalarm.regionalCodesVerified) throw new Error(`MeteoAlarm regional matching has not been verified for ${code}`);
  if (meteoalarm.unsupportedCoreHazards.some((hazard) => !verifiedCoreHazards.includes(HazardTypeSchema.parse(hazard)))) {
    throw new Error(`MeteoAlarm capability audit contains an invalid core-hazard exception for ${code}`);
  }
}
for (const [countryCode, country] of Object.entries(nationalWarningManifest.countries)) for (const system of country.systems) {
  if (Date.parse(system.nextReviewAt) <= Date.parse(system.reviewedAt)) throw new Error(`${countryCode}/${system.id} next review must follow its review date`);
  if (system.status === "active" && !implementedNationalTransports.has(system.id)) throw new Error(`${countryCode}/${system.id} is active without a typed runtime adapter`);
  for (const locationId of system.coverageLocationIds || []) {
    if (!ids.has(locationId) || !locationId.startsWith(`${countryCode.toLowerCase()}-`)) throw new Error(`${countryCode}/${system.id} has an invalid coverage destination ${locationId}`);
  }
}
if (dhmzMapping.schemaVersion !== 1 || dhmzMapping.mappings.length !== 14 || dhmzMapping.sources.length !== 2
  || dhmzMapping.sources.some((source) => !/^https:\/\/meteo\.hr\/upozorenja\//.test(source.url) || !/^[a-f0-9]{64}$/.test(source.sha256))) throw new Error("DHMZ mapping provenance is invalid");
const dhmzIds = new Set<string>();
for (const region of dhmzMapping.mappings) {
  if (!["land", "sea"].includes(region.kind) || !region.name || new Set(region.locationIds).size !== region.locationIds.length) throw new Error("Invalid DHMZ region");
  for (const id of region.locationIds) {
    const location = locations.find((location) => location.id === id);
    if (!location || location.countryCode !== "HR" || region.kind === "sea" && !location.isCoastal) throw new Error(`Invalid DHMZ destination ${id}`);
    dhmzIds.add(id);
  }
}
if (locations.some((location) => location.countryCode === "HR" && !dhmzIds.has(location.id))) throw new Error("Croatian catalog changes require a DHMZ mapping review");
if (Object.keys(meteoalarmCapabilities.countries).length !== countryCodes.length) throw new Error("MeteoAlarm capability audit must contain exactly 28 countries");
if (countryFallbackOnly !== 0) throw new Error(`Catalog still has ${countryFallbackOnly} fallback-only MeteoAlarm mappings`);
if (Object.values(catalogMetadata.provenance).some((value) => value.length < 20)) throw new Error("Catalog metadata provenance is incomplete");
for (const id of [
  ...catalogMetadata.coastalLocationIds,
  ...Object.keys(catalogMetadata.airQualitySamplePointOverrides),
  ...catalogMetadata.airQualityUnsupportedLocationIds,
  ...Object.keys(catalogMetadata.sourceRegionCodeOverrides),
]) {
  if (!ids.has(id)) throw new Error(`Catalog metadata references unknown location: ${id}`);
}
const infrastructureActiveIds = ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"];
if (Number.isNaN(Date.parse(infrastructureReview.reviewedAt)) || Date.parse(infrastructureReview.nextReviewAt) <= Date.parse(infrastructureReview.reviewedAt)
  || Date.now() - Date.parse(infrastructureReview.reviewedAt) > 370 * 86400000) throw new Error("Infrastructure review dates are missing or stale");
if (new Set(infrastructureReview.active.map(({ id }) => id)).size !== infrastructureReview.active.length
  || JSON.stringify(infrastructureReview.active.map(({ id }) => id).sort()) !== JSON.stringify(infrastructureActiveIds.slice().sort())) throw new Error("Infrastructure review must cover every active source exactly once");
for (const source of infrastructureReview.active) {
  if (!(source.id in conditionSources) || !conditionSources[source.id as keyof typeof conditionSources].enabled || source.status !== "active" || source.blocker !== null
    || !countryCodes.includes(source.country as typeof countryCodes[number]) || !source.authority || !source.accessBasis || source.terms.length < 20
    || !source.endpoint.startsWith("https://") || !source.officialUrl.startsWith("https://") || source.evidence.length < 2
    || source.evidence.some((url) => !url.startsWith("https://")) || source.requestsPerRun < 1 || source.requestsPerRun > 48
    || source.bytesPerResponse < 1 || source.bytesPerResponse > 1024 * 1024) throw new Error(`Invalid active infrastructure review: ${source.id}`);
}
if (new Set(infrastructureReview.inactive.map(({ id }) => id)).size !== infrastructureReview.inactive.length || infrastructureReview.inactive.some((source) =>
  source.status !== "blocked" || source.authority.length < 2 || !source.accessBasis || source.endpoint !== null && !source.endpoint.startsWith("https://")
  || !source.officialUrl.startsWith("https://") || !source.evidence.length || source.evidence.some((url) => !url.startsWith("https://")) || source.terms.length < 20
  || source.requestsPerRun !== 0 || source.bytesPerResponse !== 0 || source.blocker !== source.reason || source.reason.length < 20 || source.trigger.length < 20)) throw new Error("Inactive infrastructure review is incomplete");
if (Number.isNaN(Date.parse(infrastructureMapping.reviewedAt)) || Date.now() - Date.parse(infrastructureMapping.reviewedAt) > 370 * 86400000
  || infrastructureMapping.sources.length < 3 || infrastructureMapping.sources.some((url) => !url.startsWith("https://"))) throw new Error("Infrastructure mapping provenance is incomplete");
const germanyIds = locations.filter(({ countryCode }) => countryCode === "DE").map(({ id }) => id).sort();
if (JSON.stringify(infrastructureMapping.germany.map(([id]) => id).sort()) !== JSON.stringify(germanyIds)
  || new Set(infrastructureMapping.germany.map(([, road]) => road)).size > 24
  || infrastructureMapping.germany.some(([, road]) => !/^A\d{1,3}$/.test(road))) throw new Error("Germany infrastructure mapping is incomplete or invalid");
const swedenIds = new Set(locations.filter(({ countryCode }) => countryCode === "SE").map(({ id }) => id));
if (!Object.keys(infrastructureMapping.sweden).length || Object.values(infrastructureMapping.sweden).flat().some((id) => !swedenIds.has(id))
  || [...swedenIds].some((id) => !Object.values(infrastructureMapping.sweden).flat().includes(id))) throw new Error("Sweden infrastructure county mapping is incomplete or invalid");
const cyprusIds = locations.filter(({ countryCode }) => countryCode === "CY").map(({ id }) => id).sort();
if (JSON.stringify(Object.keys(infrastructureMapping.cyprus).sort()) !== JSON.stringify(cyprusIds)
  || infrastructureMapping.unsupported.some(({ locationId, reason }) => !cyprusIds.includes(locationId) || reason.length < 20)
  || Object.entries(infrastructureMapping.cyprus).some(([id, aliases]) => !aliases.length && !infrastructureMapping.unsupported.some((entry) => entry.locationId === id))) throw new Error("Cyprus infrastructure mapping is incomplete or invalid");
const applicabilityLocationIds = hazardApplicability.locations.map(({ locationId }) => locationId);
if (new Set(applicabilityLocationIds).size !== applicabilityLocationIds.length) throw new Error("Volcanic applicability contains duplicate destinations");
if (Date.now() - Date.parse(hazardApplicability.reviewedAt) > 370 * 24 * 60 * 60_000) throw new Error("Volcanic applicability review is older than one year");
for (const location of hazardApplicability.locations) {
  if (!ids.has(location.locationId)) throw new Error(`Volcanic applicability references unknown destination: ${location.locationId}`);
  const volcanoIds = location.volcanoes.map(({ volcanoId }) => volcanoId);
  if (new Set(volcanoIds).size !== volcanoIds.length) throw new Error(`Volcanic applicability repeats a volcano for ${location.locationId}`);
  if (location.minimumDistanceKm !== Math.min(...location.volcanoes.map(({ distanceKm }) => distanceKm))) throw new Error(`Volcanic minimum distance is inconsistent for ${location.locationId}`);
}
for (const override of hazardApplicability.overrides) {
  if (!ids.has(override.locationId)) throw new Error(`Volcanic override references unknown destination: ${override.locationId}`);
}
for (const [locationId, overrides] of Object.entries(coverage.locationOverrides)) {
  if (!ids.has(locationId)) throw new Error(`Coverage override references unknown location: ${locationId}`);
  for (const entry of Object.values(overrides)) {
    if (!entry) continue;
    if (entry.status === "monitored" && !entry.providerIds.some((id) => providerRegistry[id].mode !== "disabled" && providerRegistry[id].satisfiesCoverage !== false)) {
      throw new Error(`${locationId} is monitored only by disabled providers`);
    }
  }
}
for (const [name, artifact] of [["IMGW", imgwMapping], ["CHMI", chmiMapping]] as const) {
  if (Number.isNaN(Date.parse(artifact.reviewedAt))) throw new Error(`${name} mapping review date is invalid`);
  const mappingIds = artifact.mappings.map(({ locationId }) => locationId);
  if (new Set(mappingIds).size !== mappingIds.length || mappingIds.some((id) => !ids.has(id))) throw new Error(`${name} mapping contains duplicate or unknown destinations`);
  if (artifact.mappings.some((item) => item.locationId.slice(0, 2).toUpperCase() !== (name === "IMGW" ? "PL" : "CZ"))) throw new Error(`${name} mapping contains a destination in the wrong country`);
}
if (imgwMapping.mappings.some(({ stationIds, bulletinTokens }) => stationIds.length < 1 || stationIds.length > 3 || new Set(stationIds).size !== stationIds.length || bulletinTokens.length < 1)) throw new Error("IMGW mappings require one to three unique stations and bulletin tokens");
if (chmiMapping.geometrySource.featureCount !== 206 || !/^https:\/\/ags\.cuzk\.cz\//.test(chmiMapping.geometrySource.url)
  || !/^[a-f0-9]{64}$/.test(chmiMapping.geometrySource.sha256) || Number.isNaN(Date.parse(chmiMapping.geometrySource.downloadedAt))) throw new Error("CHMI mapping requires reviewed complete RÚIAN geometry provenance");
if (chmiMapping.mappings.some(({ stations, orpCodes }) => stations.length < 1 || stations.length > 3 || orpCodes.length < 1 || new Set(orpCodes).size !== orpCodes.length
  || orpCodes.some((code) => !/^\d{1,4}$/.test(code)) || stations.some(({ objID, kind, spa1, spa2, spa3 }) => !objID || !["H", "Q"].includes(kind) || ![spa1, spa2, spa3].every(Number.isFinite) || spa1 >= spa2 || spa2 >= spa3))) throw new Error("CHMI mappings require exact unique ORP codes and one to three stations with ordered reviewed SPA thresholds");
if (JSON.stringify(nationalWarningSources.PL.coverageLocationIds?.slice().sort()) !== JSON.stringify(imgwMapping.mappings.map(({ locationId }) => locationId).sort())
  || JSON.stringify(nationalWarningSources.CZ.coverageLocationIds?.slice().sort()) !== JSON.stringify(chmiMapping.mappings.map(({ locationId }) => locationId).sort())) throw new Error("PL/CZ coverage claims differ from reviewed mappings");
if (Number.isNaN(Date.parse(gdeltPublishers.reviewedAt)) || new Set(gdeltPublishers.publishers.map(({ domain }) => domain)).size !== gdeltPublishers.publishers.length
  || new Set(gdeltPublishers.publishers.map(({ parentGroup }) => parentGroup)).size < 3
  || gdeltPublishers.publishers.some(({ domain, parentGroup, sourceName }) => !/^[a-z0-9.-]+$/.test(domain) || !parentGroup || !sourceName)) throw new Error("GDELT publisher review must contain unique domains from at least three parent groups");
for (const country of Object.values(coverage.countries)) for (const entry of Object.values(country.hazards)) {
  if (entry.status === "monitored" && !entry.providerIds.some((id) => providerRegistry[id].mode !== "disabled" && providerRegistry[id].satisfiesCoverage !== false)) throw new Error("A monitored hazard has only disabled or non-covering providers");
}

const publicBytes = Buffer.byteLength(JSON.stringify(publicLocations));
if (publicBytes > 150_000) throw new Error(`Public catalog exceeds 150 KB: ${publicBytes} bytes`);

try {
  const snapshotText = await readFile("public/demo-snapshot.json", "utf8");
  CompleteSnapshotSchema.parse(JSON.parse(snapshotText));
  const rawBytes = Buffer.byteLength(snapshotText);
  if (rawBytes > 500_000) throw new Error(`Snapshot exceeds 500 KB hard limit: ${rawBytes}`);
  if (rawBytes >= 300_000) throw new Error(`Demo snapshot reaches the 300 KB warning threshold: ${rawBytes}`);
  console.log(`Snapshot: ${rawBytes} bytes raw, ${gzipSync(snapshotText).byteLength} bytes gzip`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

console.log(`Catalog: ${locations.length} locations, ${publicBytes} public bytes, ${countryFallbackOnly} without a provider/NUTS MeteoAlarm code (area-label fallback only).`);
