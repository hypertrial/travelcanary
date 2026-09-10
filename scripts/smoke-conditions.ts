import { performance } from "node:perf_hooks";
import { forecastUrl, parseMetNorway, parseOpenMeteo } from "../src/lib/conditions/forecast";
import { parseMetars } from "../src/lib/conditions/metar";
import { parseDigitraffic } from "../src/lib/conditions/digitraffic";
import { readBytesWithLimit } from "../src/lib/ingestion/fetch";
import { locations } from "../src/lib/data";
import { conditionSources } from "../src/lib/conditions/sources";
import { parseRwsWater, rwsWaterEndpoint, rwsWaterRequest } from "../src/lib/conditions/rws-water";
import { marineMappingByLocation } from "../src/lib/conditions/marine";
import { ipmaObservationEndpoint, parseIpmaEarthquakes, parseIpmaObservations } from "../src/lib/conditions/ipma";
import { opwHydroEndpoint, opwHydroMappings, parseOpwHydrology } from "../src/lib/conditions/opw";
import { arsoHydroEndpoint, arsoHydroMappings, parseArsoHydrology } from "../src/lib/conditions/arso-hydro";
import { gunzipSync } from "node:zlib";
import { parseAutobahnInfrastructure, parseEnemaltaInfrastructure, parseKrisinformationInfrastructure, parseNdwInfrastructure, parsePseEnergyCompass } from "../src/lib/conditions/infrastructure";
import { distanceKm } from "../src/lib/geospatial";

const now = new Date();
const islands = locations.filter(({ id }) => ["pt-ponta-delgada", "pt-horta", "pt-santa-cruz-das-flores", "es-las-palmas-de-gran-canaria", "es-santa-cruz-de-tenerife"].includes(id));
let totalBytes = 0; let requests = 0;
let infrastructureRequests = 0; let infrastructureBytes = 0;
const readRaw = async (url: string, limit = 512 * 1024, init: RequestInit = {}, infrastructure = false) => {
  requests += 1;
  if (infrastructure) infrastructureRequests += 1;
  const headers = new Headers(init.headers); headers.set("User-Agent", "TravelCanary source review (+https://travelcanary.org/)");
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(4000), redirect: "error", headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readBytesWithLimit(response, limit); totalBytes += bytes.length; if (infrastructure) infrastructureBytes += bytes.length;
  return bytes;
};
const read = async (url: string, limit = 512 * 1024, init: RequestInit = {}, infrastructure = false) => new TextDecoder().decode(await readRaw(url, limit, init, infrastructure));
const outcomes: Record<string, unknown> = {};
for (const kind of ["weather", "airQuality", "marine"] as const) {
  const started = performance.now(); const before = totalBytes;
  if (process.env.NONCOMMERCIAL_DATA_ENABLED !== "true") { outcomes[kind] = { status: "disabled", reason: "NONCOMMERCIAL_DATA_ENABLED must be exactly true" }; continue; }
  try {
    const rows = JSON.parse(await read(forecastUrl(kind, islands.map((location) => kind === "marine" ? marineMappingByLocation.get(location.id)!.queryCoordinates : location.centroid))));
    if (!Array.isArray(rows) || rows.length !== islands.length) throw new Error("Batch mismatch");
    const parsed = rows.map((row) => parseOpenMeteo(row, kind, now));
    outcomes[kind] = { status: "ok", weightedCalls: islands.length, locations: islands.map(({ id }) => id), samples: parsed.map((item) => Object.values(item).find(Array.isArray)!.length), bytes: totalBytes - before, durationMs: Math.round(performance.now() - started) };
  } catch (error) { outcomes[kind] = { status: "failed", error: String(error).slice(0, 240) }; }
}
if (process.env.NONCOMMERCIAL_DATA_ENABLED === "true") try {
  const galway = locations.find(({ id }) => id === "ie-galway")!; const query = marineMappingByLocation.get(galway.id)!.queryCoordinates;
  const row = JSON.parse(await read(forecastUrl("marine", [query])));
  const parsed = parseOpenMeteo(row, "marine", now) as { waveHeight: Array<number | null>; wavePeriod: Array<number | null>; seaTemperature: Array<number | null> };
  const samples = [parsed.waveHeight, parsed.wavePeriod, parsed.seaTemperature].map((series) => series.filter((value) => value !== null).length);
  const returned = [Number(row.longitude), Number(row.latitude)] as [number, number]; const returnedDistanceKm = distanceKm(query, returned);
  if (samples.some((count) => count !== 24) || returnedDistanceKm > 5) throw new Error("Galway marine live gate failed");
  outcomes.galwayMarine = { status: "ok", query, samples, returnedDistanceKm: Math.round(returnedDistanceKm * 10) / 10 };
} catch (error) { outcomes.galwayMarine = { status: "failed", error: String(error).slice(0, 240) }; }
if (process.env.NONCOMMERCIAL_DATA_ENABLED === "true") try {
  const swiss = locations.filter(({ countryCode }) => countryCode === "CH");
  if (swiss.length !== 11) throw new Error("Swiss weather smoke catalog changed");
  const rows = JSON.parse(await read(forecastUrl("weather", swiss.map(({ centroid }) => centroid))));
  if (!Array.isArray(rows) || rows.length !== swiss.length) throw new Error("Swiss weather batch mismatch");
  rows.forEach((row) => parseOpenMeteo(row, "weather", now));
  outcomes.swissWeather = { status: "ok", locations: swiss.length, samples: rows.map((row) => row.hourly?.time?.length) };
} catch (error) { outcomes.swissWeather = { status: "failed", error: String(error).slice(0, 240) }; }
try { outcomes.metar = { status: "ok", stations: parseMetars(JSON.parse(await read("https://aviationweather.gov/api/data/metar?ids=LPPD,LPHR,LPFL,GCLP,GCXO&format=json")), now).size }; }
catch (error) { outcomes.metar = { status: "failed", error: String(error) }; }
try { outcomes.metNorway = { status: "ok", hours: parseMetNorway(JSON.parse(await read("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=37.7412&lon=-25.6756", 128 * 1024)), now).temperature.length }; }
catch (error) { outcomes.metNorway = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const [geo, xml] = await Promise.all([read("https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements", 1024 * 1024, {}, true), read("https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements/datex2-3.7.xml", 1024 * 1024, {}, true)]);
  const parsed = parseDigitraffic(xml, JSON.parse(geo), now);
  outcomes.digitraffic = { status: "ok", destinations: Object.values(parsed.locations).filter((items) => items.length).length, overflow: parsed.overflow };
} catch (error) { outcomes.digitraffic = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const body = await read(rwsWaterEndpoint, 512 * 1024, { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": "TravelCanary" }, body: JSON.stringify(rwsWaterRequest()) });
  const parsed = parseRwsWater(JSON.parse(body), now);
  outcomes.rijkswaterstaat = { status: "ok", reviewedStations: rwsWaterRequest().LocatieLijst.length, currentStations: parsed.size };
} catch (error) { outcomes.rijkswaterstaat = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const parsed = parseOpwHydrology(JSON.parse(await read(opwHydroEndpoint, 1024 * 1024)), now);
  outcomes.opw = { status: "ok", reviewedStations: opwHydroMappings.length, currentStations: parsed.size };
} catch (error) { outcomes.opw = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const parsed = parseArsoHydrology(await read(arsoHydroEndpoint, 256 * 1024), now);
  outcomes.arso = { status: "ok", reviewedStations: new Set(arsoHydroMappings.map(({ stationId }) => stationId)).size, currentStations: parsed.size };
} catch (error) { outcomes.arso = { status: "failed", error: String(error).slice(0, 240) }; }
if (process.env.NONCOMMERCIAL_DATA_ENABLED !== "true") outcomes.ipma = { status: "disabled", reason: "NONCOMMERCIAL_DATA_ENABLED must be exactly true" };
else try {
  const [observations, azores, mainland] = await Promise.all([
    read(ipmaObservationEndpoint, 512 * 1024),
    read("https://api.ipma.pt/open-data/observation/seismic/3.json", 512 * 1024),
    read("https://api.ipma.pt/open-data/observation/seismic/7.json", 512 * 1024),
  ]);
  const stationRecords = parseIpmaObservations(JSON.parse(observations), now);
  const earthquakeRecords = parseIpmaEarthquakes([JSON.parse(azores), JSON.parse(mainland)], now);
  outcomes.ipma = { status: "ok", currentStationMappings: stationRecords.size,
    destinationsWithEarthquakeContext: Object.values(earthquakeRecords).filter((records) => records.length).length };
} catch (error) { outcomes.ipma = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const parsed = parseKrisinformationInfrastructure(JSON.parse(await read("https://api.krisinformation.se/v3/news?language=sv&allCounties=true&days=1&includeTest=false", 512 * 1024, {}, true)), now);
  outcomes.krisinformationInfrastructure = { status: "ok", destinations: Object.values(parsed.locations).filter((records) => records.length).length, overflow: parsed.overflow };
} catch (error) { outcomes.krisinformationInfrastructure = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const [safety, closures] = await Promise.all([
    readRaw("https://opendata.ndw.nu/veiligheidsgerelateerde_berichten_srti.xml.gz", 512 * 1024, {}, true),
    readRaw("https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz", 512 * 1024, {}, true),
  ]);
  const parsed = [safety, closures].map((bytes) => parseNdwInfrastructure(gunzipSync(bytes, { maxOutputLength: 3 * 1024 * 1024 }).toString("utf8"), now));
  outcomes.ndwTraffic = { status: "ok", destinations: new Set(parsed.flatMap((result) => Object.entries(result.locations).filter(([, records]) => records.length).map(([id]) => id))).size,
    overflow: parsed.reduce((sum, result) => sum + result.overflow, 0) };
} catch (error) { outcomes.ndwTraffic = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const [closures, warnings] = await Promise.all([
    read("https://verkehr.autobahn.de/o/autobahn/A100/services/closure", 64 * 1024, {}, true), read("https://verkehr.autobahn.de/o/autobahn/A100/services/warning", 64 * 1024, {}, true),
  ]);
  const parsed = [parseAutobahnInfrastructure(JSON.parse(closures), "A100", "closure", now), parseAutobahnInfrastructure(JSON.parse(warnings), "A100", "warning", now)];
  outcomes.autobahnTraffic = { status: "ok", representativeRoad: "A100", records: parsed.reduce((sum, result) => sum + Object.values(result.locations).flat().length, 0) };
} catch (error) { outcomes.autobahnTraffic = { status: "failed", error: String(error).slice(0, 240) }; }
if (!conditionSources["enemalta-power"].enabled) outcomes.enemaltaPower = { status: "disabled", reason: conditionSources["enemalta-power"].blocker };
else try {
  const [current, planned] = await Promise.all([
    read("https://mobilegis.enemalta.com.mt/mobilegis_rest/api/currentoutages/GetOutages", 512 * 1024, {}, true),
    read("https://mobilegis.enemalta.com.mt/mobilegis_Rest/api/currentoutages/GetPlannedOutages", 512 * 1024, {}, true),
  ]);
  const parsed = parseEnemaltaInfrastructure(JSON.parse(current), JSON.parse(planned), now);
  outcomes.enemaltaPower = { status: "ok", destinations: Object.values(parsed.locations).filter((records) => records.length).length, overflow: parsed.overflow };
} catch (error) { outcomes.enemaltaPower = { status: "failed", error: String(error).slice(0, 240) }; }
try {
  const parsed = parsePseEnergyCompass(JSON.parse(await read("https://api.raporty.pse.pl/api/pdgsz?$filter=is_active%20eq%20true&$orderby=dtime_utc%20desc&$first=48", 256 * 1024, {}, true)), now);
  outcomes.pseEnergyCompass = { status: "ok", advisoryDestinations: Object.values(parsed).filter((records) => records.length).length };
} catch (error) { outcomes.pseEnergyCompass = { status: "failed", error: String(error).slice(0, 240) }; }
console.log(JSON.stringify({ checkedAt: now.toISOString(), requests, upstreamBytes: totalBytes, maximumWeightedCalls: 27, productionWrites: 0, outcomes,
  infrastructure: { role: "context", activeSources: ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"],
    requests: infrastructureRequests, bytes: infrastructureBytes, requestLimit: 64, byteLimit: 8 * 1024 * 1024 },
  gated: Object.entries(conditionSources).filter(([, source]) => !source.enabled).map(([id, source]) => ({ id, blocker: source.blocker })) }, null, 2));
if (Object.values(outcomes).some((result) => (result as { status: string }).status === "failed")) process.exitCode = 1;
