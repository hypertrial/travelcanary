import { writeFile } from "node:fs/promises";
import { locations } from "../src/lib/data";
import { buildSnapshot, createEmptyState, mergeSourceResults } from "../src/lib/risk";
import { countryCodes, providerIdForSourceId, type HazardLevel, type HazardType, type NormalizedEvent, type SourceId } from "../src/lib/domain/schemas";
import { CompleteSnapshotSchema } from "../src/lib/snapshot-validation";
import { nationalWarningSources } from "../src/lib/national-warning-sources";
import { sourceCadenceMinutes } from "../src/lib/risk-policy";

const now = new Date("2026-08-25T12:00:00.000Z");
let state = createEmptyState(now);
for (const id of ["meteoalarm", "usgs", "effis", "cems", "eea", "effis-active-fire", "ehyd-flood", "eonet", "edo-drought", "fcdo-travel-advice"] as SourceId[]) {
  const cadence = sourceCadenceMinutes[id];
  if (cadence === null) throw new Error(`Demo source ${id} must be enabled`);
  state.sources[id] = {
    status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(),
    nextExpectedUpdate: new Date(now.getTime() + cadence * 60_000).toISOString(), itemCount: id === "meteoalarm" ? 2 : 1, consecutiveFailures: 0, error: null,
  };
}
for (const countryCode of countryCodes) {
  state.sourcePartitions.meteoalarm[countryCode as keyof typeof state.sourcePartitions.meteoalarm] = structuredClone(state.sources.meteoalarm);
  state.sourcePartitions.eea[countryCode as keyof typeof state.sourcePartitions.eea] = structuredClone(state.sources.eea);
  const nationalSource = nationalWarningSources[countryCode as keyof typeof nationalWarningSources];
  state.sourcePartitions.nationalCivilAlerts[countryCode as keyof typeof state.sourcePartitions.nationalCivilAlerts] = nationalSource.enabled
    ? { ...structuredClone(state.sources.meteoalarm), itemCount: 0 }
    : { ...state.sourcePartitions.nationalCivilAlerts[countryCode as keyof typeof state.sourcePartitions.nationalCivilAlerts], error: nationalSource.limitationCode };
}
state.sources["national-civil-alerts"] = { ...structuredClone(state.sources.meteoalarm), itemCount: 0 };
state.providers["national-civil-alerts"] = structuredClone(state.sources["national-civil-alerts"]);

function demoEvent(index: number, type: HazardType, level: HazardLevel, sourceId: SourceId, timing: "ACTIVE" | "UPCOMING"): NormalizedEvent {
  const location = locations[index];
  const starts = timing === "UPCOMING" ? new Date(now.getTime() + 2 * 60 * 60 * 1000) : new Date(now.getTime() - 30 * 60 * 1000);
  const ends = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  return {
    id: `demo:${location.id}:${type}`, sourceId, providerId: providerIdForSourceId(sourceId), type, level, timing,
    headline: `${type === "earthquake" ? "Earthquake shaking" : type === "flood" ? "Serious flooding" : type === "fire-danger" ? "Very high fire danger" : type === "volcano" ? "Volcanic activity" : type === "drought" ? "Agricultural drought alert" : "Severe thunderstorms"} ${timing === "UPCOMING" ? "may affect" : "is affecting"} ${location.name}.`,
    explanation: `This is deterministic preview data showing the ${level.toLowerCase()} experience for ${location.name}.`,
    action: "Check official local advice before changing your plans.", affectedArea: `${location.name} and nearby areas`,
    geometry: { kind: "locations", ids: [location.id] }, startsAt: starts.toISOString(), endsAt: ends.toISOString(),
    sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(), expiresAt: ends.toISOString(), sourceName: sourceId === "meteoalarm" ? "MeteoAlarm" : sourceId === "usgs" ? "USGS" : sourceId === "effis" ? "EFFIS" : sourceId === "eonet" ? "NASA EONET" : sourceId === "edo-drought" ? "Copernicus EDO" : "Copernicus EMS",
    sourceUrl: sourceId === "usgs" ? "https://earthquake.usgs.gov/" : sourceId === "effis" ? "https://forest-fire.emergency.copernicus.eu/" : sourceId === "cems" ? "https://mapping.emergency.copernicus.eu/" : sourceId === "eonet" ? "https://eonet.gsfc.nasa.gov/" : sourceId === "edo-drought" ? "https://drought.emergency.copernicus.eu/" : "https://meteoalarm.org/", confidence: level === "ELEVATED" ? "MEDIUM" : "HIGH",
  };
}

const effisPrimary = demoEvent(0, "fire-danger", "ELEVATED", "effis", "ACTIVE");
const effisSupporting: NormalizedEvent = {
  ...structuredClone(effisPrimary),
  id: `${effisPrimary.id}:supporting`,
  sourceName: "Copernicus wildfire context",
  sourceUrl: "https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation/",
  sourceUpdatedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
};

state = mergeSourceResults(state, [
  { sourceId: "effis", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [effisPrimary, effisSupporting], status: "ok", error: null },
  { sourceId: "usgs", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [demoEvent(2, "earthquake", "ELEVATED", "usgs", "UPCOMING")], status: "ok", error: null },
  { sourceId: "cems", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null },
  { sourceId: "eonet", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [demoEvent(5, "volcano", "ELEVATED", "eonet", "ACTIVE")], status: "ok", error: null },
  { sourceId: "edo-drought", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [demoEvent(6, "drought", "ELEVATED", "edo-drought", "ACTIVE")], status: "ok", error: null },
  { sourceId: "fcdo-travel-advice", checkedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), events: [], status: "ok", error: null },
], now);
state.events.push(
  demoEvent(1, "severe-weather", "HIGH", "meteoalarm", "ACTIVE"),
  demoEvent(3, "flood", "SEVERE", "meteoalarm", "ACTIVE"),
);
const snapshot = buildSnapshot(state, now);
snapshot.locations[locations[4].id] = {
  level: "UNKNOWN",
  coverage: "delayed",
  coverageGaps: ["security"],
  delayedHazards: ["air-quality"],
  hazards: [],
};
await writeFile("public/demo-snapshot.json", `${JSON.stringify(CompleteSnapshotSchema.parse(snapshot))}\n`);
console.log("Generated public/demo-snapshot.json");
