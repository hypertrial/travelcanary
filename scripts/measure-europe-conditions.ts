import { pathToFileURL } from "node:url";
import { airportMappings } from "../src/lib/conditions/metar";
import { ipmaStationMappings } from "../src/lib/conditions/ipma";
import { conditionSources, conditionSourceEnabled } from "../src/lib/conditions/sources";
import { serializeCatalog3Conditions } from "../src/lib/conditions/serialization";
import { createEmptyState } from "../src/lib/risk-state";
import { catalogLocationsV3 } from "../src/lib/catalog-data";
import { LocationConditionsV2Schema, type ConditionSourceId } from "../src/lib/domain/conditions";
import { marineConditionEligible } from "../src/lib/conditions/marine";
import { buildCatalog3Conditions } from "../src/lib/catalog-projections";
import { projectCatalog2Conditions } from "../src/lib/conditions/state";
import fixture from "../tests/fixtures/europe-expansion/conditions-populated-capacity.json";

export function measureEuropeConditions() {
  const now = new Date("2026-09-08T22:00:00Z");
  const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
  const retained = fixture.locations as Record<string, unknown>;
  for (const location of catalogLocationsV3) {
    const value = LocationConditionsV2Schema.parse(retained[location.id] || {});
    for (const kind of ["weather", "airQuality", ...(marineConditionEligible(location.id, 3) ? ["marine" as const] : [])] as const) {
      const forecast = structuredClone(fixture.forecastSamples[kind]);
      forecast.checkedAt = now.toISOString(); forecast.startAt = now.toISOString();
      forecast.expiresAt = new Date(+now + (kind === "weather" ? 6 : 12) * 3600000).toISOString();
      for (const [key, array] of Object.entries(forecast)) if (Array.isArray(array)) {
        Object.assign(forecast, { [key]: Array.from({ length: 25 }, (_, index) => array[index % array.length]) });
      }
      Object.assign(value, { [kind]: forecast });
    }
    // Capacity scenario only: retain simultaneous specialist activity and make
    // all records current. These synthetic times are never published as evidence.
    for (const kind of ["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions"] as const) {
      for (const item of value[kind]) {
        item.checkedAt = now.toISOString(); item.expiresAt = new Date(+now + 3600000).toISOString();
        if ("observedAt" in item) item.observedAt = now.toISOString();
        if ("occurredAt" in item) item.occurredAt = now.toISOString();
      }
    }
    state.conditions.locations[location.id] = value;
  }
  const stationGroups = [
    { source: "awc-metar", mappings: airportMappings.map((mapping) => ({ ...mapping, stationName: mapping.name })) },
    { source: "ipma-observations", mappings: ipmaStationMappings },
  ];
  for (const { source, mappings } of stationGroups) {
    const template = Object.values(state.conditions.locations).flatMap((value) => value.observations)
      .filter((record) => record.sourceId === source).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!template) throw new Error(`Missing capacity observation sample: ${source}`);
    for (const mapping of mappings) {
      const entry = state.conditions.locations[mapping.locationId];
      if (!entry.observations.some((record) => record.sourceId === source)) entry.observations.push({ ...structuredClone(template),
        stationId: mapping.stationId, stationName: mapping.stationName, distanceKm: mapping.distanceKm });
    }
  }
  const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: "a".repeat(40) };
  for (const source of Object.keys(conditionSources) as ConditionSourceId[]) if (conditionSourceEnabled(source, env)) {
    state.conditions.health[source] = { checkedAt: now.toISOString(), status: "ok", matched: 0, code: null };
  }
  const files = buildCatalog3Conditions(state, now, env);
  const legacy = projectCatalog2Conditions(state, now, env);
  const countryBytes = Object.fromEntries(files.map((file) => [file.countryCode, Buffer.byteLength(serializeCatalog3Conditions(file))]));
  const totalBytes = Object.values(countryBytes).reduce((sum, bytes) => sum + bytes, 0);
  const legacyBytes = legacy.reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file)), 0);
  return { state, files, metrics: { catalogVersion: 3, destinations: catalogLocationsV3.length, countries: files.length,
    totalBytes, countryBytes, cacheBytes: Buffer.byteLength(JSON.stringify(state.conditions.locations)),
    privateBytes: Buffer.byteLength(JSON.stringify(state)), legacyBytes, dualGenerationBytes: totalBytes + legacyBytes,
    // Each file: HEAD + GET + PUT normally; cold namespace HEAD + PUT.
    publication: { currentFiles: files.length, transitionFiles: files.length + legacy.length,
      steadyOperations: files.length * 3, dualOperations: (files.length + legacy.length) * 3,
      worstCaseDualAttempts: (files.length + legacy.length) * 3 * 3 } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(measureEuropeConditions().metrics, null, 2));
}
