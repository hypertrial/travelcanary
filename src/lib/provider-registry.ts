import type { HazardType, ProviderId, SourceHealth, SourceId } from "./domain/schemas";

export const providerRegistry: Record<ProviderId, {
  sourceId: SourceId;
  mode: "authoritative" | "complementary" | "fallback" | "discovery" | "disabled";
  cadenceMinutes: number | null;
  hazards: HazardType[];
  limitationCode: string | null;
  displayName: string;
  roleLabel: string;
  officialUrl: string;
  limitation: string | null;
  healthScope?: "global" | "coverage" | "non_blocking";
  satisfiesCoverage?: boolean;
}> = {
  meteoalarm: { sourceId: "meteoalarm", mode: "authoritative", cadenceMinutes: 10, hazards: ["severe-weather", "flood", "extreme-heat", "extreme-cold", "wildfire", "snow-ice", "avalanche", "coastal"], limitationCode: null, displayName: "MeteoAlarm", roleLabel: "Official warning source", officialUrl: "https://meteoalarm.org/", limitation: null },
  usgs: { sourceId: "usgs", mode: "authoritative", cadenceMinutes: 10, hazards: ["earthquake"], limitationCode: null, displayName: "USGS", roleLabel: "Primary earthquake source", officialUrl: "https://earthquake.usgs.gov/", limitation: null },
  "effis-fire-danger": { sourceId: "effis", mode: "authoritative", cadenceMinutes: 60, hazards: ["fire-danger"], limitationCode: null, displayName: "EFFIS fire danger", roleLabel: "Official forecast source", officialUrl: "https://forest-fire.emergency.copernicus.eu/", limitation: "A danger forecast does not confirm an active fire.", healthScope: "coverage" },
  "cems-rapid-mapping": { sourceId: "cems", mode: "complementary", cadenceMinutes: 10, hazards: ["wildfire", "industrial", "civil-emergency", "flood"], limitationCode: null, displayName: "Copernicus EMS Rapid Mapping", roleLabel: "Complementary emergency source", officialUrl: "https://mapping.emergency.copernicus.eu/", limitation: "Rapid Mapping is not a complete civil-alert service.", healthScope: "non_blocking" },
  gdacs: { sourceId: "gdacs", mode: "discovery", cadenceMinutes: 60, hazards: [], limitationCode: "discovery_only", displayName: "GDACS", roleLabel: "Discovery source", officialUrl: "https://www.gdacs.org/", limitation: "Hourly discovery data never changes risk or satisfies coverage.", healthScope: "non_blocking" },
  gfm: { sourceId: "gfm", mode: "complementary", cadenceMinutes: 120, hazards: ["flood"], limitationCode: null, displayName: "Copernicus Global Flood Monitoring", roleLabel: "Satellite flood corroboration", officialUrl: "https://global-flood.emergency.copernicus.eu/", limitation: "Satellite corroboration is environment-gated and never satisfies coverage.", healthScope: "non_blocking", satisfiesCoverage: false },
  emsc: { sourceId: "emsc", mode: "fallback", cadenceMinutes: 10, hazards: ["earthquake"], limitationCode: "preliminary_fallback", displayName: "EMSC", roleLabel: "Preliminary fallback", officialUrl: "https://www.seismicportal.eu/", limitation: "Fallback evidence cannot replace ShakeMap intensity or establish monitoring coverage.", satisfiesCoverage: false },
  "slf-avalanche": { sourceId: "slf-avalanche", mode: "authoritative", cadenceMinutes: 60, hazards: ["avalanche"], limitationCode: null, displayName: "SLF avalanche bulletins", roleLabel: "Official avalanche source", officialUrl: "https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/", limitation: "Coverage is limited to destinations intersecting official bulletin geometry.", healthScope: "coverage" },
  "euregio-avalanche": { sourceId: "euregio-avalanche", mode: "authoritative", cadenceMinutes: 60, hazards: ["avalanche"], limitationCode: null, displayName: "Avalanche.report", roleLabel: "Official avalanche source", officialUrl: "https://avalanche.report/", limitation: "Coverage is limited to destinations mapped to licensed official warning regions.", healthScope: "coverage" },
  "effis-active-fire": { sourceId: "effis-active-fire", mode: "complementary", cadenceMinutes: 60, hazards: ["wildfire"], limitationCode: "satellite_context_only", displayName: "EFFIS / NASA FIRMS active fire", roleLabel: "Satellite fire context", officialUrl: "https://forest-fire.emergency.copernicus.eu/", limitation: "Satellite hotspots and derived perimeters can miss fires and do not establish complete official wildfire-warning coverage.", healthScope: "non_blocking", satisfiesCoverage: false },
  "eea-aqi": { sourceId: "eea", mode: "authoritative", cadenceMinutes: 60, hazards: ["air-quality"], limitationCode: null, displayName: "European Environment Agency", roleLabel: "Official air-quality index", officialUrl: "https://airindex.eea.europa.eu/", limitation: "The current European AQI layer may use modelled estimates and is published with a reporting delay.", healthScope: "coverage" },
  gdelt: { sourceId: "gdelt", mode: "discovery", cadenceMinutes: 60, hazards: ["civil-unrest", "security", "terrorism", "armed-conflict"], limitationCode: "corroborated_context_only", displayName: "GDELT", roleLabel: "Corroborated news context", officialUrl: "https://www.gdeltproject.org/", limitation: "Requires three independently owned reviewed publishers; never satisfies coverage.", healthScope: "non_blocking", satisfiesCoverage: false },
  "national-civil-alerts": { sourceId: "national-civil-alerts", mode: "authoritative", cadenceMinutes: 10, hazards: ["flood", "civil-unrest", "security", "terrorism", "armed-conflict", "industrial", "nuclear", "civil-emergency"], limitationCode: "country_readiness_varies", displayName: "National public warning systems", roleLabel: "Official national warning source", officialUrl: "https://www.berec.europa.eu/en/pws", limitation: "Availability and covered emergency categories vary by country.", healthScope: "coverage" },
  vigicrues: { sourceId: "vigicrues", mode: "authoritative", cadenceMinutes: 10, hazards: ["flood"], limitationCode: null, displayName: "Vigicrues", roleLabel: "Official French flood warning source", officialUrl: "https://www.vigicrues.gouv.fr/", limitation: "Coverage is limited to destinations mapped to official river sections.", healthScope: "coverage" },
  "foen-flood": { sourceId: "foen-flood", mode: "authoritative", cadenceMinutes: 60, hazards: ["flood"], limitationCode: null, displayName: "FOEN flood warning map", roleLabel: "Official Swiss flood warning source", officialUrl: "https://www.hydrodaten.admin.ch/", limitation: "Coverage uses the national warning map at destination geometry.", healthScope: "coverage" },
  "ehyd-flood": { sourceId: "ehyd-flood", mode: "authoritative", cadenceMinutes: 60, hazards: ["flood"], limitationCode: null, displayName: "eHYD flood stages", roleLabel: "Official Austrian flood warning source", officialUrl: "https://ehyd.gv.at/", limitation: "Coverage is limited to destinations intersecting official hydrographic stations with documented flood-warning stages.", healthScope: "coverage" },
  eonet: { sourceId: "eonet", mode: "complementary", cadenceMinutes: 60, hazards: ["wildfire", "volcano"], limitationCode: "context_only", displayName: "NASA EONET", roleLabel: "Context only", officialUrl: "https://eonet.gsfc.nasa.gov/", limitation: "Open disaster records provide recent satellite context and do not replace local warnings.", healthScope: "non_blocking", satisfiesCoverage: false },
  "edo-drought": { sourceId: "edo-drought", mode: "complementary", cadenceMinutes: 1440, hazards: ["drought"], limitationCode: "context_only", displayName: "Copernicus European Drought Observatory", roleLabel: "Context only", officialUrl: "https://drought.emergency.copernicus.eu/", limitation: "Dekadal agricultural and ecosystem drought context is not an immediate emergency warning.", healthScope: "non_blocking", satisfiesCoverage: false },
  "fcdo-travel-advice": { sourceId: "fcdo-travel-advice", mode: "complementary", cadenceMinutes: 60, hazards: ["security"], limitationCode: "context_only", displayName: "GOV.UK foreign travel advice", roleLabel: "Context only", officialUrl: "https://www.gov.uk/foreign-travel-advice", limitation: "Whole-country travel advice is contextual and does not replace local emergency warnings.", healthScope: "non_blocking", satisfiesCoverage: false },
};

export function publicProviderState(id: ProviderId, health?: SourceHealth) {
  const definition = providerRegistry[id];
  if (definition.mode === "disabled") return { mode: definition.mode, status: "disabled" as const, lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, limitationCode: definition.limitationCode };
  return {
    mode: definition.mode,
    status: health?.status === "not_monitored" ? "disabled" as const : (health?.status || "failed") as "ok" | "partial" | "delayed" | "failed",
    lastSuccess: health?.lastSuccess || null,
    sourceUpdatedAt: health?.sourceUpdatedAt || null,
    nextExpectedUpdate: health?.nextExpectedUpdate || null,
    limitationCode: health?.status === "not_monitored" ? health.error || definition.limitationCode : definition.limitationCode,
  };
}

export function publicProviderPartitionState(health: SourceHealth) {
  const status = health.status === "not_monitored"
    ? "disabled" as const
    : health.status === "ok" || health.status === "partial" || health.status === "delayed"
      ? health.status
      : "failed" as const;
  return {
    status,
    lastSuccess: health.lastSuccess,
    sourceUpdatedAt: health.sourceUpdatedAt,
    nextExpectedUpdate: health.nextExpectedUpdate,
    limitationCode: status === "disabled" ? health.error || "not_supported" : null,
  };
}
