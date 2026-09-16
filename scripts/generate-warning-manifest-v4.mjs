import { readFile, writeFile } from "node:fs/promises";
import { catalogMembershipHash } from "../src/lib/catalog-membership.ts";

const manifestPath = new URL("../data/national-warning-sources.json", import.meta.url);
const capabilitiesPath = new URL("../data/meteoalarm-capabilities.json", import.meta.url);
const presentationPath = new URL("../data/national-warning-presentation.json", import.meta.url);
const expandedCoveragePath = new URL("../data/expanded-national-warning-coverage.json", import.meta.url);
const membershipPath = new URL("../data/catalog-membership.json", import.meta.url);
const release2Path = new URL("../data/catalog-releases/2.json", import.meta.url);
const release3Path = new URL("../data/catalog-releases/3.json", import.meta.url);
const linksPath = new URL("../data/country-information-links.json", import.meta.url);
const [manifest, capabilities, links, release2, release3] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(capabilitiesPath, "utf8").then(JSON.parse),
  readFile(linksPath, "utf8").then(JSON.parse),
  readFile(release2Path, "utf8").then(JSON.parse),
  readFile(release3Path, "utf8").then(JSON.parse),
]);

const reviewedAt = "2026-09-13";
const nextReviewAt = "2027-03-13";
const countryNames = {
  AD: "Andorra", AL: "Albania", BA: "Bosnia and Herzegovina", BY: "Belarus", GB: "United Kingdom",
  IS: "Iceland", LI: "Liechtenstein", MC: "Monaco", MD: "Moldova", ME: "Montenegro",
  MK: "North Macedonia", NO: "Norway", RS: "Serbia", SM: "San Marino", TR: "Türkiye",
  VA: "Vatican City", XK: "Kosovo",
};
const slugs = {
  AD: "andorra", BA: "bosnia-herzegovina", GB: "united-kingdom", IS: "iceland", MD: "moldova",
  ME: "montenegro", MK: "republic-of-north-macedonia", NO: "norway", RS: "serbia",
};
const meteoEvidence = {
  AD: { supportedHazards: ["severe-weather", "extreme-heat"], polygon: true, patterns: ["Moderate storms warning", "Moderate high temperature"] },
  BA: { supportedHazards: [], polygon: false, patterns: [] },
  GB: { supportedHazards: [], polygon: false, patterns: [] },
  IS: { supportedHazards: ["severe-weather"], polygon: true, patterns: ["Weather Warning: Wind"] },
  MD: { supportedHazards: [], polygon: false, patterns: [] },
  ME: { supportedHazards: [], polygon: false, patterns: [] },
  MK: { supportedHazards: [], polygon: false, patterns: [] },
  // The retained NO polygons are marine gale areas, not evidence of land-destination coverage.
  NO: { supportedHazards: [], polygon: true, patterns: [] },
  RS: { supportedHazards: [], polygon: false, patterns: [] },
};
const coreMeteoHazards = ["severe-weather", "extreme-heat", "extreme-cold", "snow-ice"];

for (const [countryCode, evidence] of Object.entries(meteoEvidence)) {
  const fixture = new URL(`../tests/fixtures/europe-expansion/${countryCode.toLowerCase()}-meteoalarm.xml`, import.meta.url);
  const xml = await readFile(fixture, "utf8");
  if (evidence.polygon !== xml.includes("<cap:polygon>")) throw new Error(`${countryCode} polygon evidence disagrees with retained fixture`);
  for (const pattern of evidence.patterns) if (!xml.includes(pattern)) throw new Error(`${countryCode} is missing capability evidence: ${pattern}`);
  if (evidence.supportedHazards.length && (!evidence.polygon || evidence.patterns.length !== evidence.supportedHazards.length)) {
    throw new Error(`${countryCode} capabilities require one retained positive event and polygon evidence per hazard`);
  }
}

function officialLinkSystem(countryCode) {
  const first = links[countryCode][0];
  return {
    id: `${countryCode.toLowerCase()}-official-information`, reviewedAt, nextReviewAt,
    evidenceUrls: links[countryCode].slice(0, 6).map(({ url }) => url),
    authority: `${countryNames[countryCode]} public authorities`, systemName: first.label, officialUrl: first.url,
    runtimeTarget: "none", role: "context", status: "evidence_gated", endpoint: null, format: null,
    cadenceMinutes: null, maxBytes: null, hazards: [], accessStatus: "approved", reuseStatus: "unverified",
    severityStatus: "unverified", lifecycleStatus: "unverified", geometryStatus: "unverified",
    completenessStatus: "unverified", coverageContribution: "none", credentialEnvVar: null,
    limitationCode: "official_link_only", blocker: "No reviewed reusable machine-warning transport is available; the app links to authoritative public information without implying monitoring.",
    contactUrl: first.url, reReviewTrigger: "A public machine feed with documented reuse, geometry, severity, lifecycle, and completeness semantics becomes available.", license: null,
  };
}

function meteoAlarmSystem(countryCode) {
  const slug = slugs[countryCode];
  const evidence = meteoEvidence[countryCode];
  const active = evidence.supportedHazards.length > 0;
  return {
    id: "meteoalarm-atom", reviewedAt, nextReviewAt,
    evidenceUrls: ["https://feeds.meteoalarm.org/", "https://api.meteoalarm.org/edr/v1/docs?f=html"],
    authority: "MeteoAlarm / EUMETNET members", systemName: "MeteoAlarm keyless Atom warning feed",
    officialUrl: "https://www.meteoalarm.org/", runtimeTarget: active ? "meteoalarm-primary" : "none",
    role: active ? "coverage" : "context", status: active ? "active" : "evidence_gated",
    endpoint: `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`, format: "atom", cadenceMinutes: 10,
    maxBytes: 4194304, hazards: evidence.supportedHazards, accessStatus: "approved", reuseStatus: "approved",
    severityStatus: "approved", lifecycleStatus: "approved", geometryStatus: evidence.polygon ? "partial" : "unverified",
    completenessStatus: active ? "partial" : "unverified", coverageContribution: active ? "partial" : "none",
    credentialEnvVar: null, limitationCode: active ? null : "mapping_not_verified",
    blocker: active ? null : "The retained Atom evidence does not prove reusable destination geometry and hazard capability for this country; authoritative links remain visible.",
    contactUrl: "https://www.meteoalarm.org/", reReviewTrigger: "Feed contract, member participation, CAP geometry, or EDR access terms change.",
    license: { name: "MeteoAlarm public warning redistribution", url: "https://www.meteoalarm.org/en/live/terms-and-conditions/" },
  };
}

function meteoAlarmEdrSystem(countryCode) {
  const location = countryCode === "GB" ? "UK" : countryCode;
  const evidence = meteoEvidence[countryCode];
  const eligible = evidence.supportedHazards.length > 0;
  return {
    id: "meteoalarm-edr", reviewedAt, nextReviewAt,
    evidenceUrls: ["https://api.meteoalarm.org/edr/v1/docs?f=html", "https://api.meteoalarm.org/edr/v1/authentication"],
    authority: "MeteoAlarm / EUMETNET members", systemName: "MeteoAlarm authenticated EDR recovery",
    officialUrl: "https://www.meteoalarm.org/", runtimeTarget: eligible ? "meteoalarm-fallback" : "none",
    role: eligible ? "fallback" : "context", status: eligible ? "credential_gated" : "evidence_gated",
    endpoint: `https://api.meteoalarm.org/edr/v1/collections/warnings/locations/${location}`, format: "json", cadenceMinutes: 360,
    maxBytes: 2097152, hazards: evidence.supportedHazards, accessStatus: "credential_required", reuseStatus: "approved",
    severityStatus: "approved", lifecycleStatus: "approved", geometryStatus: "approved", completenessStatus: "approved",
    coverageContribution: "none", credentialEnvVar: eligible ? "METEOALARM_API_TOKEN" : null,
    limitationCode: eligible ? "credential_not_configured" : "mapping_not_verified",
    blocker: eligible ? "Optional authenticated recovery; catalog 3 launch and health rely on the keyless Atom primary, not this transport."
      : "EDR access cannot establish a capability that lacks reviewed destination and hazard evidence.",
    contactUrl: "https://api.meteoalarm.org/register", reReviewTrigger: "EDR endpoint, authentication, rate limit, pagination, CAP links, or geometry contract changes.",
    license: { name: "Creative Commons Attribution 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  };
}

for (const countryCode of Object.keys(countryNames)) {
  const systems = [];
  if (slugs[countryCode]) systems.push(meteoAlarmSystem(countryCode), meteoAlarmEdrSystem(countryCode));
  systems.push(officialLinkSystem(countryCode));
  manifest.countries[countryCode] = { reviewedAt, systems };
}

const noSystems = manifest.countries.NO.systems;
noSystems.unshift({
  id: "met-norway-alerts", reviewedAt, nextReviewAt, evidenceUrls: ["https://api.met.no/weatherapi/metalerts/2.0/documentation"],
  authority: "Norwegian Meteorological Institute", systemName: "MET Norway MetAlerts", officialUrl: "https://www.met.no/en/weather-and-climate/text-forecast-and-warnings",
  runtimeTarget: "national-civil-alerts", role: "coverage", status: "active", endpoint: "https://api.met.no/weatherapi/metalerts/2.0/current.json",
  format: "json", cadenceMinutes: 10, maxBytes: 2097152, hazards: ["severe-weather", "coastal", "snow-ice", "fire-danger"],
  accessStatus: "approved", reuseStatus: "approved", severityStatus: "approved", lifecycleStatus: "approved", geometryStatus: "approved",
  completenessStatus: "approved", coverageContribution: "complete", credentialEnvVar: null, limitationCode: null, blocker: null,
  contactUrl: "https://api.met.no/weatherapi/metalerts/2.0/documentation", reReviewTrigger: "MetAlerts API contract, event taxonomy, or geographicDomain semantics change.",
  license: { name: "Norwegian Licence for Open Government Data 2.0 / CC BY 4.0", url: "https://api.met.no/doc/TermsOfService" },
});
noSystems.splice(1, 0, {
  id: "nve-flood", reviewedAt, nextReviewAt, evidenceUrls: ["https://api.nve.no/doc/flomvarsling/"],
  authority: "Norwegian Water Resources and Energy Directorate", systemName: "NVE flood warnings", officialUrl: "https://www.varsom.no/en/flood-and-landslide-warning-service/",
  runtimeTarget: "national-civil-alerts", role: "coverage", status: "active", endpoint: "https://api01.nve.no/hydrology/forecast/flood/v1.0.10/Warning/en/",
  format: "json", cadenceMinutes: 30, maxBytes: 2097152, hazards: ["flood"], accessStatus: "approved", reuseStatus: "approved",
  severityStatus: "approved", lifecycleStatus: "approved", geometryStatus: "partial", completenessStatus: "approved",
  coverageContribution: "partial", credentialEnvVar: null, limitationCode: null, blocker: null,
  contactUrl: "https://api.nve.no/doc/flomvarsling/", reReviewTrigger: "NVE API version, activity-level semantics, municipality identifiers, or time fields change.",
  license: { name: "NVE open data terms", url: "https://www.nve.no/about-nve/privacy-policy/terms-of-use/" },
});

const englandIds = ["gb-bath", "gb-birmingham", "gb-brighton", "gb-cambridge", "gb-exeter", "gb-lake-district-national-park", "gb-leeds", "gb-liverpool", "gb-london", "gb-manchester", "gb-newcastle-upon-tyne", "gb-oxford", "gb-plymouth", "gb-portsmouth", "gb-york"];
const gbSystems = manifest.countries.GB.systems;
gbSystems.unshift({
  id: "ea-flood", reviewedAt, nextReviewAt, evidenceUrls: ["https://environment.data.gov.uk/flood-monitoring/doc/reference"],
  authority: "Environment Agency", systemName: "England flood warnings", officialUrl: "https://check-for-flooding.service.gov.uk/",
  runtimeTarget: "national-civil-alerts", role: "coverage", status: "active", endpoint: "https://environment.data.gov.uk/flood-monitoring/id/floods",
  format: "json", cadenceMinutes: 15, maxBytes: 2097152, hazards: ["flood"], accessStatus: "approved", reuseStatus: "approved",
  severityStatus: "approved", lifecycleStatus: "approved", geometryStatus: "partial", completenessStatus: "approved",
  coverageContribution: "partial", coverageLocationIds: englandIds, credentialEnvVar: null, limitationCode: null, blocker: null,
  contactUrl: "https://environment.data.gov.uk/flood-monitoring/doc/reference", reReviewTrigger: "Flood warning pagination, severity, flood-area identifiers, or geometry contracts change.",
  license: { name: "Open Government Licence v3.0", url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" },
});
gbSystems.push({
  id: "met-office-nswws", reviewedAt, nextReviewAt, evidenceUrls: ["https://metoffice.github.io/nswws-public-api/atom-feed.html"],
  authority: "Met Office", systemName: "National Severe Weather Warning Service", officialUrl: "https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings",
  runtimeTarget: "national-civil-alerts", role: "coverage", status: "active", endpoint: "https://warnings.api.metoffice.gov.uk/",
  format: "atom", cadenceMinutes: 10, maxBytes: 2097152, hazards: ["severe-weather", "extreme-heat", "extreme-cold", "snow-ice", "flood", "coastal"],
  accessStatus: "credential_required", reuseStatus: "approved", severityStatus: "approved", lifecycleStatus: "approved", geometryStatus: "approved",
  completenessStatus: "approved", coverageContribution: "complete", credentialEnvVar: "MET_OFFICE_API_KEY", limitationCode: null,
  blocker: null, contactUrl: "https://metoffice.github.io/nswws-public-api/atom-feed.html",
  reReviewTrigger: "The feed, authentication, lifecycle, severity, geometry, or hazard taxonomy contract changes.", license: { name: "Met Office data licence", url: "https://www.metoffice.gov.uk/about-us/legal" },
});
gbSystems.push({
  id: "nrw-flood", reviewedAt, nextReviewAt, evidenceUrls: ["https://naturalresources.wales/flooding/check-flood-warnings/?lang=en"],
  authority: "Natural Resources Wales", systemName: "Wales flood warnings", officialUrl: "https://naturalresources.wales/flooding/check-flood-warnings/?lang=en",
  runtimeTarget: "national-civil-alerts", role: "fallback", status: "credential_gated", endpoint: "https://api.naturalresources.wales/floodwarnings/",
  format: "json", cadenceMinutes: 15, maxBytes: 2097152, hazards: ["flood"], accessStatus: "credential_required", reuseStatus: "approved",
  severityStatus: "partial", lifecycleStatus: "partial", geometryStatus: "partial", completenessStatus: "partial", coverageContribution: "none",
  credentialEnvVar: "NRW_FLOOD_API_KEY", limitationCode: "credential_not_configured", blocker: "Optional enhancement; Wales remains authoritative-link coverage without credentials.",
  contactUrl: "https://naturalresources.wales/flooding/check-flood-warnings/?lang=en", reReviewTrigger: "Credentials are provisioned or the API contract changes.", license: null,
});

const dwd = manifest.countries.DE.systems.find(({ id }) => id === "dwd-cap");
Object.assign(dwd, {
  reviewedAt, nextReviewAt, evidenceUrls: ["https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_EVENT_STAT/", "https://github.com/advisories/GHSA-px8p-9vwx-vf98"],
  runtimeTarget: "meteoalarm-fallback", role: "fallback", status: "active",
  endpoint: "https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_EVENT_STAT/Z_CAP_C_EDZW_LATEST_PVW_STATUS_PREMIUMEVENT_COMMUNEUNION_EN.zip",
  format: "cap", accessStatus: "approved", reuseStatus: "approved", severityStatus: "approved", lifecycleStatus: "approved",
  geometryStatus: "approved", completenessStatus: "approved", limitationCode: null, blocker: null,
  reReviewTrigger: "DWD archive filename, CAP status-product contract, municipality geometry, or fflate security posture changes.",
  license: { name: "Datenlizenz Deutschland – Namensnennung – Version 2.0", url: "https://www.govdata.de/dl-de/by-2-0" },
});

manifest.schemaVersion = 4;
manifest.reviewedAt = reviewedAt;
capabilities.schemaVersion = 2;
capabilities.reviewedAt = reviewedAt;
for (const [countryCode, feedSlug] of Object.entries(slugs)) capabilities.countries[countryCode] = {
  feedSlug, regionalCodesVerified: false, polygonGeometryVerified: meteoEvidence[countryCode].polygon,
  supportedHazards: meteoEvidence[countryCode].supportedHazards,
  unsupportedCoreHazards: coreMeteoHazards.filter((hazard) => !meteoEvidence[countryCode].supportedHazards.includes(hazard)),
  evidenceFixture: `tests/fixtures/europe-expansion/${countryCode.toLowerCase()}-meteoalarm.xml`,
};

const presentation = { schemaVersion: 1, countries: Object.fromEntries(Object.entries(manifest.countries).map(([countryCode, country]) => {
  const runtime = country.systems.filter((system) => system.status === "active" && system.runtimeTarget === "national-civil-alerts");
  const coverage = runtime.filter((system) => system.coverageContribution !== "none");
  const primary = runtime[0] || country.systems.find(({ runtimeTarget }) => runtimeTarget !== "meteoalarm-fallback" && runtimeTarget !== "meteoalarm-primary") || country.systems[0];
  const coverageLocationIds = coverage.some((system) => !system.coverageLocationIds) ? []
    : [...new Set(coverage.flatMap((system) => system.coverageLocationIds || []))];
  return [countryCode, {
    reviewedAt: country.reviewedAt,
    source: {
      systemName: runtime.length > 1 ? `${primary.authority} national warning sources` : primary.systemName,
      officialUrl: primary.officialUrl,
      enabled: runtime.length > 0,
      hazards: [...new Set(coverage.flatMap((system) => system.hazards))],
      limitationCode: runtime.length ? null : primary.limitationCode,
      satisfiesCoverage: coverage.length > 0,
      ...(coverageLocationIds.length ? { coverageLocationIds } : {}),
    },
    systems: country.systems.map((system) => ({
      id: system.id, systemName: system.systemName, officialUrl: system.officialUrl,
      role: system.role, status: system.status, hazards: system.hazards,
      coverageContribution: system.coverageContribution,
      ...(system.coverageLocationIds ? { coverageLocationIds: system.coverageLocationIds } : {}),
      ...(system.blocker ? { blocker: system.blocker } : {}),
    })),
  }];
})) };
const release2Ids = new Set(release2.locationIds);
const addedCountryCodes = [...new Set(release3.locationIds.filter((id) => !release2Ids.has(id))
  .map((id) => id.slice(0, 2).toUpperCase()))].sort();
const expandedCoverage = {
  schemaVersion: 1,
  countries: Object.fromEntries(addedCountryCodes.flatMap((countryCode) => {
    const systems = manifest.countries[countryCode].systems.filter((system) => system.status === "active"
      && system.runtimeTarget === "national-civil-alerts" && system.role === "coverage" && system.coverageContribution !== "none")
      .map((system) => ({ hazards: system.hazards, coverageContribution: system.coverageContribution,
        ...(system.coverageLocationIds ? { coverageLocationIds: system.coverageLocationIds } : {}) }));
    return systems.length ? [[countryCode, systems]] : [];
  })),
};
const membershipContract = (ids) => ({
  count: ids.length,
  hash: catalogMembershipHash(ids),
  countries: Object.fromEntries([...Map.groupBy(ids, (id) => id.slice(0, 2).toUpperCase())]
    .map(([code, countryIds]) => [code, { count: countryIds.length, hash: catalogMembershipHash(countryIds) }])),
});
const membership = { schemaVersion: 1, releases: {
  2: membershipContract(release2.locationIds),
  3: membershipContract(release3.locationIds),
} };

const outputs = [
  [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
  [capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`],
  [presentationPath, `${JSON.stringify(presentation)}\n`],
  [expandedCoveragePath, `${JSON.stringify(expandedCoverage)}\n`],
  [membershipPath, `${JSON.stringify(membership)}\n`],
];
if (process.argv.includes("--check")) {
  for (const [path, expected] of outputs) {
    if (await readFile(path, "utf8") !== expected) throw new Error(`${path.pathname} is stale; run npm run warning-manifest:generate`);
  }
} else await Promise.all(outputs.map(([path, output]) => writeFile(path, output)));
