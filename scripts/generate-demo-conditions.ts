import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createEmptyState } from "../src/lib/risk";
import { locations } from "../src/lib/data";
import { parseOpenMeteo } from "../src/lib/conditions/forecast";
import { buildConditionsFiles } from "../src/lib/conditions/state";
import { emptyConditions } from "../src/lib/domain/conditions";
import { airportMappings, parseMetars } from "../src/lib/conditions/metar";
import { parseRwsWater, rwsWaterMappings } from "../src/lib/conditions/rws-water";

import { parseOpwHydrology, opwHydroMappings } from "../src/lib/conditions/opw";

const snapshot = JSON.parse(await readFile("public/demo-snapshot.json", "utf8"));
const now = new Date(snapshot.generatedAt);
const fixtureTime = new Date("2026-08-31T17:45:00Z");
const state = createEmptyState(now);
for (const sourceId of ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"] as const) {
  state.conditions.health[sourceId] = { checkedAt: now.toISOString(), status: "ok", matched: sourceId === "digitraffic" || sourceId === "ndw-traffic" || sourceId === "pse-energy-compass" ? 1 : 0, code: null };
}
const weather = parseOpenMeteo(JSON.parse(await readFile("tests/fixtures/conditions/forecast.json", "utf8")), "weather", fixtureTime);
const air = parseOpenMeteo(JSON.parse(await readFile("tests/fixtures/conditions/air.json", "utf8")), "airQuality", fixtureTime);
const marineTime = new Date("2026-08-31T18:58:55.507Z");
const marine = parseOpenMeteo(JSON.parse(await readFile("tests/fixtures/conditions/marine.json", "utf8")), "marine", marineTime);
const observations = parseMetars(JSON.parse(await readFile("tests/fixtures/conditions/metar.json", "utf8")), fixtureTime);
const rwsTime = new Date("2026-09-01T13:00:00Z");
const rwsObservations = parseRwsWater(JSON.parse(await readFile("tests/fixtures/conditions/rws-water.json", "utf8")), rwsTime);
const shift = (item: typeof weather, retrieved = fixtureTime) => ({ ...item, checkedAt: now.toISOString(), startAt: now.toISOString(), expiresAt: new Date(now.getTime() + Date.parse(item.expiresAt) - retrieved.getTime()).toISOString() });
for (const location of locations) state.conditions.locations[location.id] = {
  ...emptyConditions(), weather: shift(weather) as NonNullable<ReturnType<typeof emptyConditions>["weather"]>, airQuality: shift(air) as NonNullable<ReturnType<typeof emptyConditions>["airQuality"]>,
  ...(location.isCoastal ? { marine: shift(marine, marineTime) as NonNullable<ReturnType<typeof emptyConditions>["marine"]> } : {}),
};
state.conditions.locations["fi-helsinki"].infrastructureIncidents = [{ id: "demo-digitraffic", sourceId: "digitraffic", sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 2 * 3600000).toISOString(), kind: "road-closure", status: "active", scope: "destination", scopeLabel: "Road near Helsinki",
  startsAt: new Date(now.getTime() - 30 * 60000).toISOString(), endsAt: null, estimatedRestorationAt: null, sourceUrl: "https://liikennetilanne.fintraffic.fi/" }];
state.conditions.locations["nl-amsterdam"].infrastructureIncidents = [{ id: "demo-ndw", sourceId: "ndw-traffic", sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 4 * 3600000).toISOString(), kind: "road-closure", status: "planned", scope: "destination", scopeLabel: "Road near Amsterdam",
  startsAt: new Date(now.getTime() + 2 * 3600000).toISOString(), endsAt: new Date(now.getTime() + 4 * 3600000).toISOString(), estimatedRestorationAt: null, sourceUrl: "https://opendata.ndw.nu/" }];
state.conditions.locations["pl-warsaw"].systemConditions = [{ id: "demo-pse", sourceId: "pse-energy-compass", sourceUpdatedAt: now.toISOString(), checkedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3600000).toISOString(), kind: "electricity-use-advisory", state: "reduce-use", scope: "country", scopeLabel: "Poland",
  startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 3600000).toISOString(), sourceUrl: "https://www.energetycznykompas.pl/" }];
for (const mapping of airportMappings) {
  const item = observations.get(mapping.stationId);
  if (!item) continue;
  const shifted = (time: string) => new Date(Date.parse(time) + now.getTime() - fixtureTime.getTime()).toISOString();
  state.conditions.locations[mapping.locationId].observations = [{ ...item, checkedAt: now.toISOString(), observedAt: shifted(item.observedAt), sourceUpdatedAt: shifted(item.observedAt), expiresAt: shifted(item.expiresAt), distanceKm: mapping.distanceKm }];
}
for (const mapping of rwsWaterMappings) {
  const item = rwsObservations.get(mapping.stationId);
  if (!item) continue;
  const shifted = (time: string) => new Date(Date.parse(time) + now.getTime() - rwsTime.getTime()).toISOString();
  state.conditions.locations[mapping.locationId].rivers = [{ ...item, checkedAt: now.toISOString(), observedAt: shifted(item.observedAt),
    sourceUpdatedAt: shifted(item.observedAt), expiresAt: shifted(item.expiresAt) }];
}
const opwTime = new Date("2026-09-08T07:30:00Z");
const opwObservations = parseOpwHydrology(JSON.parse(await readFile("tests/fixtures/conditions/opw-hydrology.json", "utf8")), opwTime);
state.conditions.health["opw-hydro"] = { checkedAt: now.toISOString(), status: "ok", matched: opwObservations.size, code: null };
for (const mapping of opwHydroMappings) {
  const item = opwObservations.get(mapping.stationId);
  if (!item) continue;
  const shifted = (time: string) => new Date(Date.parse(time) + now.getTime() - opwTime.getTime()).toISOString();
  state.conditions.locations[mapping.locationId].rivers.push({ ...item, checkedAt: now.toISOString(), observedAt: shifted(item.observedAt),
    sourceUpdatedAt: shifted(item.observedAt), expiresAt: shifted(item.expiresAt) });
}
const files = buildConditionsFiles(state, now, { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true" });
await mkdir("public/conditions/v2", { recursive: true });
for (const file of files) {
  for (const source of Object.values(file.sources)) source.notice = `DEMONSTRATION ONLY: repeated fixture values, not conditions at this destination. ${source.notice}`;
  await writeFile(`public/conditions/v2/${file.countryCode}.json`, JSON.stringify(file) + "\n");
}
console.log(JSON.stringify({ countries: files.length, locations: locations.length, bytes: files.reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file)), 0), largest: Math.max(...files.map((file) => Buffer.byteLength(JSON.stringify(file)))) }));
