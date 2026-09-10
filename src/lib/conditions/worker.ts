import { publishCommittedCatalog, type CatalogPublicationStores } from "../catalog-publication";
import { assertSupportedCollection, assertCatalog2Collection, CollectionChangedError, type CollectionControl, type IngestionStateV14 as IngestionState } from "../domain/catalog-state";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { locations } from "../data";
import { catalogLocationsV3 } from "../catalog-data";
import { emptyConditions, type ConditionSourceId, type Conditions, type LocationConditions } from "../domain/conditions";
import { ConcurrencyError, type ConditionsPublicationResult, type StateStore } from "../storage";
import { distanceKm } from "../geospatial";
import { mapConcurrent, readBytesWithLimit } from "../ingestion/fetch";
import { airportMappings, parseMetars } from "./metar";
import { parseDigitraffic } from "./digitraffic";
import { forecastProducts, forecastUrl, parseMetNorway, parseOpenMeteo, type ForecastKind } from "./forecast";
import { parseRwsWater, rwsWaterEndpoint, rwsWaterMappings, rwsWaterRequest } from "./rws-water";
import { conditionSourceEnabled, conditionsDisabledSources } from "./sources";
import { availableForecastWeight, buildConditionsFiles, fitConditionsState } from "./state";
import { marineMappingByLocation, marineConditionEligible, catalog3MarineMappingByLocation } from "./marine";
import { ipmaObservationEndpoint, ipmaStationMappings, parseIpmaEarthquakes, parseIpmaObservations } from "./ipma";
import { opwHydroEndpoint, opwHydroMappings, parseOpwHydrology } from "./opw";
import { arsoHydroEndpoint, arsoHydroMappings, parseArsoHydrology } from "./arso-hydro";
import { mergeInfrastructure, parseAutobahnInfrastructure, parseEacInfrastructure, parseEnemaltaInfrastructure, parseKrisinformationInfrastructure, parseNdwInfrastructure, parsePseEnergyCompass, rankInfrastructure } from "./infrastructure";
import { autobahnRoadIds } from "./infrastructure-mapping";

type Batch = { kind: ForecastKind; ids: string[] };
type FailureCode = "timeout" | "http_error" | "response_too_large" | "parse_failed" | "contract_mismatch" | "quota_exhausted" | "deadline_exhausted" | "unknown_failure";
const MAX_PUBLICATION_FAILURES = 8;
const SCHEDULER_JITTER_MS = 5 * 60_000;
const NEXT_RUN_GRACE_MS = 75 * 60_000;
const byId = new Map(catalogLocationsV3.map((location) => [location.id, location]));
const hosts = new Set(["api.open-meteo.com", "air-quality-api.open-meteo.com", "marine-api.open-meteo.com", "api.met.no", "aviationweather.gov", "tie.digitraffic.fi", "ddapi20-waterwebservices.rijkswaterstaat.nl", "api.ipma.pt", "waterlevel.ie", "www.arso.gov.si", "api.krisinformation.se", "opendata.ndw.nu", "verkehr.autobahn.de", "www.eac.com.cy", "mobilegis.enemalta.com.mt", "api.raporty.pse.pl"]);
function sourceIsDue(last: string | undefined, cadenceHours: number, now: Date) {
  return !last || now.getTime() - Date.parse(last) >= cadenceHours * 3_600_000 - SCHEDULER_JITTER_MS;
}
class ConditionsFailure extends Error {
  constructor(readonly code: FailureCode, readonly splitRetry = true) { super(code); }
}
function failureCode(error: unknown): FailureCode {
  if (error instanceof ConditionsFailure) return error.code;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  return "unknown_failure";
}
export function forecastSplitHasLocalHeadroom(input: { splitRetry: boolean; batchSize: number; requests: number; remainingBytes: number; remainingMs: number }) {
  return input.splitRetry && input.batchSize > 1 && input.remainingMs >= 8000 && input.requests <= 126 && input.remainingBytes >= 1024 * 1024;
}
export function forecastBatches(state: IngestionState, now: Date, env: Record<string, string | undefined>) {
  const catalog = state.collection.catalogVersion === 3 ? catalogLocationsV3 : locations;
  const available = availableForecastWeight(state, now);
  const limits: Record<ForecastKind, number> = { weather: 200, airQuality: 120, marine: 80 };
  const selected: Record<ForecastKind, string[]> = { weather: [], airQuality: [], marine: [] };
  const candidates: Array<{ kind: ForecastKind; id: string; urgency: number; attempt: number; sparse: number }> = [];
  for (const kind of ["weather", "airQuality", "marine"] as const) {
    const product = forecastProducts[kind];
    if (!conditionSourceEnabled(product.sourceId, env)) continue;
    for (const location of catalog.filter((item) => kind !== "marine" || marineConditionEligible(item.id, state.collection.catalogVersion))) {
      const last = state.conditions.attempts[`${kind}:${location.id}`];
      const record = state.conditions.locations[location.id]?.[kind];
      const expiry = Date.parse(record?.expiresAt || "1970-01-01T00:00:00Z");
      const urgency = record?.sourceId !== product.sourceId || expiry <= now.getTime() ? 0 : expiry <= now.getTime() + NEXT_RUN_GRACE_MS ? 1 : 2;
      if (urgency < 2 || sourceIsDue(last, product.hours, now)) candidates.push({ kind, id: location.id, urgency,
        attempt: Date.parse(last || "1970-01-01T00:00:00Z"),
        sparse: /^(pt-(?:horta|ponta-delgada|santa-cruz-das-flores)|es-(?:las-palmas-de-gran-canaria|santa-cruz-de-tenerife))$/.test(location.id) ? 0 : 1 });
    }
  }
  candidates.sort((a, b) => a.urgency - b.urgency || a.attempt - b.attempt || a.sparse - b.sparse
    || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
  let remaining = available;
  for (const item of candidates) if (remaining && selected[item.kind].length < limits[item.kind]) {
    selected[item.kind].push(item.id); remaining -= 1;
  }
  return (["weather", "airQuality", "marine"] as const).flatMap((kind) => {
    const batches: Batch[] = [];
    for (let offset = 0; offset < selected[kind].length; offset += 40) batches.push({ kind, ids: selected[kind].slice(offset, offset + 40) });
    return batches;
  });
}

async function releaseLease(stateStore: StateStore, leaseId: string, failedForecastAttempts: Set<string>, attemptAt: string, cooldown: string | null) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await stateStore.read();
    const ownsLease = latest.data.conditions.lease?.id === leaseId;
    const extendsCooldown = cooldown && Date.parse(cooldown) > Date.parse(latest.data.conditions.cooldownUntil || "1970-01-01T00:00:00Z");
    if (!ownsLease && !extendsCooldown) return;
    if (ownsLease) {
      for (const key of failedForecastAttempts) if (latest.data.conditions.attempts[key] === attemptAt) delete latest.data.conditions.attempts[key];
      latest.data.conditions.lease = null;
    }
    // A real throttle remains quota evidence even when its run's data is discarded.
    if (extendsCooldown) latest.data.conditions.cooldownUntil = cooldown;
    try { await stateStore.write(latest.data, latest); return; }
    catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 2) throw error; }
  }
}

export async function runConditions(options: {
  stateStore: StateStore; publish: (files: Conditions[]) => Promise<ConditionsPublicationResult>; fetch?: typeof fetch;
  now?: Date; env?: Record<string, string | undefined>; catalogPublication?: CatalogPublicationStores;
}) {
  const assertCollection = options.catalogPublication ? assertSupportedCollection : assertCatalog2Collection;
  const started = performance.now();
  const deadline = Date.now() + 45_000;
  const now = options.now || new Date(); const env = options.env || process.env;
  conditionsDisabledSources(env.CONDITIONS_DISABLED_SOURCES);
  const leaseId = randomUUID();
  const attemptAt = now.toISOString();
  const failedForecastAttempts = new Set<string>();
  const successfulAutobahnAttempts = new Set<string>();
  const failedAutobahnAttempts = new Set<string>();
  let state: IngestionState | undefined;
  let collection: CollectionControl | undefined;
  let cooldown: string | null = null;
  let batches: Batch[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const versioned = await options.stateStore.read();
    collection = assertCollection(versioned.data, collection);
    if (versioned.data.conditions.lease && Date.parse(versioned.data.conditions.lease.expiresAt) > now.getTime()) return { status: "skipped", code: "conditions_lease_held" };
    state = versioned.data;
    batches = forecastBatches(state, now, env);
    state.conditions.lease = { id: leaseId, expiresAt: new Date(now.getTime() + 90_000).toISOString() };
    const weight = batches.reduce((sum, batch) => sum + batch.ids.length, 0);
    // Reserve through the end of the source phase: late-starting requests cannot age out early.
    if (weight) state.conditions.reservations.push({ at: new Date(now.getTime() + 45000).toISOString(), weight });
    for (const batch of batches) for (const id of batch.ids) state.conditions.attempts[`${batch.kind}:${id}`] = attemptAt;
    try { await options.stateStore.write(fitConditionsState(state, now), versioned); break; }
    catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 2) throw error; state = undefined; }
  }
  if (!state) throw new Error("Could not reserve conditions work");
  try {
  const changes = new Map<string, Partial<LocationConditions>>();
  const health: IngestionState["conditions"]["health"] = {};
  const forecastDiagnostics = Object.fromEntries((["weather", "airQuality", "marine"] as const).map((kind) => [kind, {
    attempted: 0, matched: 0, failed: 0, splitRetried: 0, recovered: 0, skipped: 0,
    failureCodes: {} as Partial<Record<FailureCode, number>>, affectedCountries: new Set<string>(),
  }]));
  const infrastructureDiagnostics = new Map<ConditionSourceId, { attempted: number; succeeded: number; failed: number; skipped: number;
    healthyEmpty: boolean; failureCodes: Partial<Record<FailureCode, number>>; targetExamples: Array<{ target: string; code: FailureCode }> }>();
  const diagnostics = { requests: 0, bytes: 0, weightedCalls: batches.reduce((sum, batch) => sum + batch.ids.length, 0), matched: 0, failed: 0, skipped: 0, overflow: 0,
    infrastructureRequests: 0, infrastructureBytes: 0, infrastructureSkipped: 0 };
  const failedWeather = new Set<string>();
  let remainingBytes = 16 * 1024 * 1024;
  const cacheUpdates: Record<string, string> = {};
  let forecastFailure: Error | undefined;
  const request = async (url: string, maxBytes = 1024 * 1024, format: "json" | "xml" | "bytes" = "json", taskDeadline = deadline, init: RequestInit = {}) => {
    if (forecastFailure) throw forecastFailure;
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || !hosts.has(target.hostname)) throw new ConditionsFailure("contract_mismatch", false);
    if (Date.now() + 4000 > Math.min(deadline, taskDeadline)) { diagnostics.skipped += 1; throw new ConditionsFailure("deadline_exhausted", false); }
    if (diagnostics.requests >= 128 || remainingBytes < maxBytes) { diagnostics.skipped += 1; throw new ConditionsFailure("quota_exhausted", false); }
    diagnostics.requests += 1; remainingBytes -= maxBytes;
    let consumed = 0;
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", "TravelCanary/1.0 (+https://travelcanary.org/)");
      if (target.hostname === "tie.digitraffic.fi") headers.set("Digitraffic-User", "TravelCanary/1.0");
      const response = await (options.fetch || fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(Math.min(4000, deadline - Date.now())), headers });
      if (response.status === 429 && target.hostname.endsWith("open-meteo.com")) {
        const retry = response.headers.get("retry-after");
        const until = retry && /^\d+$/.test(retry) ? now.getTime() + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
        const retryAt = Math.min(now.getTime() + 7 * 86400000, Math.max(now.getTime() + 3_600_000, Number.isFinite(until) ? until : 0));
        cooldown = new Date(Math.max(retryAt, cooldown ? Date.parse(cooldown) : 0)).toISOString();
        await response.body?.cancel();
        throw new ConditionsFailure("http_error", false);
      }
      if (!response.ok) { await response.body?.cancel(); throw new ConditionsFailure("http_error"); }
      let bytes: Uint8Array;
      try { bytes = await readBytesWithLimit(response, maxBytes, (size) => { consumed += size; diagnostics.bytes += size; }); }
      catch (error) {
        if (error instanceof Error && /(?:too large|exceeds|limit)/i.test(error.message)) throw new ConditionsFailure("response_too_large");
        throw new ConditionsFailure(failureCode(error));
      }
      const text = new TextDecoder().decode(bytes);
      let body: unknown;
      try { body = format === "bytes" ? bytes : format === "xml" ? text : bytes.length ? JSON.parse(text) : []; }
      catch { throw new ConditionsFailure("parse_failed"); }
      return { body, headers: response.headers, bytes: consumed };
    } catch (error) {
      if (error instanceof ConditionsFailure) throw error;
      throw new ConditionsFailure(failureCode(error));
    } finally { remainingBytes += Math.max(0, maxBytes - consumed); }
  };
  const updateHealth = (sourceId: ConditionSourceId, matched: number, failed: boolean) => {
    const previous = health[sourceId];
    const total = (previous?.matched || 0) + matched;
    const anyFailed = failed || previous?.code === "source_unavailable";
    health[sourceId] = { checkedAt: now.toISOString(), status: anyFailed ? total ? "partial" : "failed" : "ok", matched: total, code: anyFailed ? "source_unavailable" : null };
  };
  let infrastructureRequestsRemaining = 64;
  let infrastructureBytesRemaining = 8 * 1024 * 1024;
  const infrastructureItem = (sourceId: ConditionSourceId) => {
    const item = infrastructureDiagnostics.get(sourceId) || { attempted: 0, succeeded: 0, failed: 0, skipped: 0, healthyEmpty: false,
      failureCodes: {}, targetExamples: [] };
    infrastructureDiagnostics.set(sourceId, item);
    return item;
  };
  const recordInfrastructureFailure = (sourceId: ConditionSourceId, target: string, error: unknown, replaceSuccess = false) => {
    const item = infrastructureItem(sourceId); const parsedResponseFailed = replaceSuccess && item.succeeded > 0;
    const code: FailureCode = parsedResponseFailed ? "contract_mismatch" : failureCode(error);
    if (parsedResponseFailed) item.succeeded -= 1;
    item.failed += 1;
    item.failureCodes[code] = (item.failureCodes[code] || 0) + 1;
    // The infrastructure run is capped at 64 requests, so retain safe IDs until
    // final sorting to keep the public eight-example set deterministic.
    item.targetExamples.push({ target, code });
  };
  const infrastructureRequest = async (sourceId: ConditionSourceId, targetId: string, url: string, maxBytes: number, format: "json" | "xml" | "bytes", taskDeadline: number, init: RequestInit = {}) => {
    const item = infrastructureItem(sourceId); item.attempted += 1;
    try {
      if (infrastructureRequestsRemaining < 1 || infrastructureBytesRemaining < maxBytes) {
        diagnostics.infrastructureSkipped += 1; item.skipped += 1;
        throw new ConditionsFailure("quota_exhausted", false);
      }
      infrastructureRequestsRemaining -= 1; infrastructureBytesRemaining -= maxBytes; diagnostics.infrastructureRequests += 1;
      const result = await request(url, maxBytes, format, taskDeadline, init);
      infrastructureBytesRemaining += maxBytes - result.bytes; diagnostics.infrastructureBytes += result.bytes; item.succeeded += 1;
      return result;
    } catch (error) {
      recordInfrastructureFailure(sourceId, targetId, error);
      throw error;
    }
  };
  let retryReservationQueue = Promise.resolve();
  const reserveRetryWeight = async (weight: number) => {
    let reserved = false;
    const work = retryReservationQueue.then(async () => {
      if (forecastFailure) throw forecastFailure;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latest = await options.stateStore.read();
        if (forecastFailure) throw forecastFailure;
        try { assertCollection(latest.data, collection); }
        catch (error) {
          forecastFailure = error instanceof Error ? error : new Error(String(error));
          throw forecastFailure;
        }
        if (latest.data.conditions.lease?.id !== leaseId || availableForecastWeight(latest.data, now) < weight) return;
        latest.data.conditions.reservations.push({ at: new Date(now.getTime() + 45_000).toISOString(), weight });
        try { await options.stateStore.write(fitConditionsState(latest.data, now), latest); reserved = true; diagnostics.weightedCalls += weight; return; }
        catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 2) return; }
      }
    });
    retryReservationQueue = work.then(() => undefined, () => undefined);
    await work;
    return reserved;
  };
  const fetchForecast = async (kind: ForecastKind, ids: string[]) => {
    let batchFailure: ConditionsFailure | undefined;
    const matched: string[] = []; const failed: string[] = [];
    try {
      if (cooldown) throw new ConditionsFailure("quota_exhausted", false);
      const coordinates = ids.map((id) => kind === "marine" ? (state!.collection.catalogVersion === 3 ? catalog3MarineMappingByLocation : marineMappingByLocation).get(id)!.queryCoordinates : byId.get(id)!.centroid);
      const { body } = await request(forecastUrl(kind, coordinates), 512 * 1024);
      const rows = Array.isArray(body) ? body : [body];
      if (rows.length !== ids.length) throw new ConditionsFailure("contract_mismatch");
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]; const row = rows[index] as { latitude?: unknown; longitude?: unknown };
        try {
          const expected = kind === "marine" ? (state!.collection.catalogVersion === 3 ? catalog3MarineMappingByLocation : marineMappingByLocation).get(id)!.queryCoordinates : byId.get(id)!.centroid;
          if (typeof row?.latitude !== "number" || typeof row.longitude !== "number"
            || distanceKm(expected, [row.longitude, row.latitude]) > (kind === "marine" ? 5 : kind === "airQuality" ? 50 : 25)) throw new Error();
          changes.set(id, { ...changes.get(id), [kind]: parseOpenMeteo(row, kind, now) }); matched.push(id);
        } catch { failed.push(id); }
      }
    } catch (error) {
      batchFailure = error instanceof ConditionsFailure ? error : new ConditionsFailure(failureCode(error));
      failed.push(...ids);
    }
    return { matched, failed, batchFailure };
  };
  await mapConcurrent(batches, 8, async (batch) => {
    if (forecastFailure) return;
    try {
    const product = forecastProducts[batch.kind]; const item = forecastDiagnostics[batch.kind]; item.attempted += batch.ids.length;
    let outcome = await fetchForecast(batch.kind, batch.ids);
    if (outcome.batchFailure) {
      const code = outcome.batchFailure.code; item.failureCodes[code] = (item.failureCodes[code] || 0) + 1;
      const canSplit = forecastSplitHasLocalHeadroom({ splitRetry: outcome.batchFailure.splitRetry, batchSize: batch.ids.length,
        requests: diagnostics.requests, remainingBytes, remainingMs: deadline - Date.now() }) && await reserveRetryWeight(batch.ids.length);
      if (canSplit) {
        const middle = Math.ceil(batch.ids.length / 2); item.splitRetried += batch.ids.length;
        const first = await fetchForecast(batch.kind, batch.ids.slice(0, middle));
        const second = await fetchForecast(batch.kind, batch.ids.slice(middle));
        for (const part of [first, second]) if (part.batchFailure) {
          const partCode = part.batchFailure.code; item.failureCodes[partCode] = (item.failureCodes[partCode] || 0) + 1;
        }
        outcome = { matched: [...first.matched, ...second.matched], failed: [...first.failed, ...second.failed], batchFailure: undefined };
        item.recovered += outcome.matched.length;
      } else item.skipped += batch.ids.length;
    } else if (outcome.failed.length) item.failureCodes.contract_mismatch = (item.failureCodes.contract_mismatch || 0) + outcome.failed.length;
    item.matched += outcome.matched.length; item.failed += outcome.failed.length; diagnostics.failed += outcome.failed.length;
    for (const id of outcome.failed) {
      failedForecastAttempts.add(`${batch.kind}:${id}`); item.affectedCountries.add(byId.get(id)!.countryCode);
      if (batch.kind === "weather") failedWeather.add(id);
    }
    updateHealth(product.sourceId, outcome.matched.length, outcome.failed.length > 0);
    } catch (error) {
      // Drain active callbacks before lease/cooldown cleanup. Promise.all's
      // early rejection otherwise leaves sibling requests running after cleanup.
      forecastFailure ||= error instanceof Error ? error : new Error(String(error));
    }
  });
  if (forecastFailure) throw forecastFailure;
  const fallbackDeadline = Math.min(deadline, Date.now() + 8000);
  if (conditionSourceEnabled("met-norway", env)) await mapConcurrent([...failedWeather].filter((id) => locations.some((location) => location.id === id)).slice(0, 20), 4, async (id) => {
    try {
      const cached = state!.conditions.locations[id]?.weather;
      if (cached && Date.parse(cached.expiresAt) > now.getTime()) return;
      if (Date.parse(state!.conditions.cacheUntil[`met-norway:${id}`] || "") > now.getTime()) return;
      const [longitude, latitude] = byId.get(id)!.centroid;
      const { body, headers } = await request(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`, 128 * 1024, "json", fallbackDeadline);
      const expiry = Date.parse(headers.get("expires") || "");
      const maxAge = Number(headers.get("cache-control")?.match(/(?:^|,)\s*max-age=(\d+)/)?.[1]);
      const until = Number.isFinite(expiry) ? expiry : Number.isFinite(maxAge) ? now.getTime() + maxAge * 1000 : now.getTime() + 3600000;
      cacheUpdates[`met-norway:${id}`] = new Date(Math.max(now.getTime(), until)).toISOString();
      changes.set(id, { ...changes.get(id), weather: parseMetNorway(body, now) }); updateHealth("met-norway", 1, false);
    } catch { updateHealth("met-norway", 0, true); }
  });
  const metarDue = sourceIsDue(state.conditions.health["awc-metar"]?.checkedAt, 1, now);
  if (metarDue && conditionSourceEnabled("awc-metar", env)) {
    const metarDeadline = Math.min(deadline, Date.now() + 8000);
    const stations = [...new Set(airportMappings.map(({ stationId }) => stationId))];
    for (let offset = 0; offset < stations.length; offset += 200) {
      try {
        const ids = stations.slice(offset, offset + 200);
        const { body } = await request(`https://aviationweather.gov/api/data/metar?ids=${ids.join(",")}&format=json`, 1024 * 1024, "json", metarDeadline);
        const parsed = parseMetars(body, now);
        let matched = 0;
        for (const mapping of airportMappings.filter((item) => ids.includes(item.stationId))) {
          const observation = parsed.get(mapping.stationId);
          // Missing station is healthy no-data for this transport; do not renew an old observation.
          const others = (changes.get(mapping.locationId)?.observations || state!.conditions.locations[mapping.locationId]?.observations || []).filter((item) => item.sourceId !== "awc-metar");
          changes.set(mapping.locationId, { ...changes.get(mapping.locationId), observations: [...others, ...(observation ? [{ ...observation, distanceKm: mapping.distanceKm }] : [])].slice(0, 3) });
          if (observation) matched += 1;
        }
        updateHealth("awc-metar", matched, false);
      } catch { updateHealth("awc-metar", 0, true); }
    }
  }
  const rwsDue = sourceIsDue(state.conditions.health["rws-water"]?.checkedAt, 1, now);
  if (rwsDue && conditionSourceEnabled("rws-water", env)) {
    try {
      const taskDeadline = Math.min(deadline, Date.now() + 8000);
      const { body } = await request(rwsWaterEndpoint, 512 * 1024, "json", taskDeadline, {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": "TravelCanary" }, body: JSON.stringify(rwsWaterRequest()),
      });
      const parsed = parseRwsWater(body, now); let matched = 0;
      for (const mapping of rwsWaterMappings) {
        const observation = parsed.get(mapping.stationId);
        const previous = changes.get(mapping.locationId)?.rivers || state.conditions.locations[mapping.locationId]?.rivers || [];
        const others = previous.filter((item) => item.sourceId !== "rws-water");
        changes.set(mapping.locationId, { ...changes.get(mapping.locationId), rivers: [...others, ...(observation ? [observation] : [])].slice(0, 3) });
        if (observation) matched += 1;
      }
      updateHealth("rws-water", matched, false);
    } catch { updateHealth("rws-water", 0, true); }
  }
  const opwDue = sourceIsDue(state.conditions.health["opw-hydro"]?.checkedAt, 1, now);
  if (opwDue && conditionSourceEnabled("opw-hydro", env)) {
    try {
      const { body } = await request(opwHydroEndpoint, 1024 * 1024, "json", Math.min(deadline, Date.now() + 8000));
      const parsed = parseOpwHydrology(body, now); let matched = 0;
      for (const mapping of opwHydroMappings) {
        const previous = changes.get(mapping.locationId)?.rivers || state.conditions.locations[mapping.locationId]?.rivers || [];
        const others = previous.filter((item) => item.sourceId !== "opw-hydro");
        const observation = parsed.get(mapping.stationId);
        changes.set(mapping.locationId, { ...changes.get(mapping.locationId), rivers: [...others, ...(observation ? [observation] : [])].slice(0, 3) });
        if (observation) matched += 1;
      }
      updateHealth("opw-hydro", matched, false);
    } catch { updateHealth("opw-hydro", 0, true); }
  }
  const arsoDue = sourceIsDue(state.conditions.health["arso-hydro"]?.checkedAt, 1, now);
  if (arsoDue && conditionSourceEnabled("arso-hydro", env)) {
    try {
      const { body } = await request(arsoHydroEndpoint, 256 * 1024, "xml", Math.min(deadline, Date.now() + 8000));
      const parsed = parseArsoHydrology(String(body), now); let matched = 0;
      for (const locationId of new Set(arsoHydroMappings.map((item) => item.locationId))) {
        const previous = changes.get(locationId)?.rivers || state.conditions.locations[locationId]?.rivers || [];
        const others = previous.filter((item) => item.sourceId !== "arso-hydro");
        const observations = arsoHydroMappings.filter((item) => item.locationId === locationId)
          .flatMap((item) => parsed.get(item.stationId) || []);
        changes.set(locationId, { ...changes.get(locationId), rivers: [...others, ...observations].slice(0, 3) });
        matched += observations.length;
      }
      updateHealth("arso-hydro", matched, false);
    } catch { updateHealth("arso-hydro", 0, true); }
  }
  const ipmaObservationDue = sourceIsDue(state.conditions.health["ipma-observations"]?.checkedAt, 1, now);
  if (ipmaObservationDue && conditionSourceEnabled("ipma-observations", env)) {
    try {
      const { body } = await request(ipmaObservationEndpoint, 512 * 1024, "json", Math.min(deadline, Date.now() + 8000));
      const parsed = parseIpmaObservations(body, now); let matched = 0;
      for (const mapping of ipmaStationMappings) {
        const previous = changes.get(mapping.locationId)?.observations || state.conditions.locations[mapping.locationId]?.observations || [];
        const others = previous.filter((item) => item.sourceId !== "ipma-observations");
        const observation = parsed.get(mapping.locationId);
        changes.set(mapping.locationId, { ...changes.get(mapping.locationId), observations: [...others, ...(observation ? [observation] : [])].slice(0, 3) });
        if (observation) matched += 1;
      }
      updateHealth("ipma-observations", matched, false);
    } catch { updateHealth("ipma-observations", 0, true); }
  }
  const ipmaSeismicDue = sourceIsDue(state.conditions.health["ipma-seismic"]?.checkedAt, 1, now);
  if (ipmaSeismicDue && conditionSourceEnabled("ipma-seismic", env)) {
    try {
      const taskDeadline = Math.min(deadline, Date.now() + 8000);
      const feeds = await Promise.all([3, 7].map((area) => request(`https://api.ipma.pt/open-data/observation/seismic/${area}.json`, 512 * 1024, "json", taskDeadline)));
      const parsed = parseIpmaEarthquakes(feeds.map(({ body }) => body), now); let matched = 0;
      for (const location of locations.filter(({ countryCode }) => countryCode === "PT")) {
        const previous = changes.get(location.id)?.earthquakes || state.conditions.locations[location.id]?.earthquakes || [];
        const others = previous.filter((item) => item.sourceId !== "ipma-seismic"); const earthquakes = parsed[location.id] || [];
        changes.set(location.id, { ...changes.get(location.id), earthquakes: [...others, ...earthquakes].slice(0, 3) });
        if (earthquakes.length) matched += 1;
      }
      updateHealth("ipma-seismic", matched, false);
    } catch { updateHealth("ipma-seismic", 0, true); }
  }
  const trafficDue = sourceIsDue(state.conditions.health.digitraffic?.checkedAt, 1, now);
  if (trafficDue && conditionSourceEnabled("digitraffic", env)) {
    try {
      const taskDeadline = Math.min(deadline, Date.now() + 8000);
      const [geo, xml] = await Promise.all([infrastructureRequest("digitraffic", "geometry", "https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements", 1024 * 1024, "json", taskDeadline),
        infrastructureRequest("digitraffic", "datex", "https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements/datex2-3.7.xml", 1024 * 1024, "xml", taskDeadline)]);
      const parsed = parseDigitraffic(String(xml.body), geo.body, now);
      for (const [id, infrastructureIncidents] of Object.entries(parsed.locations)) {
        const previous = changes.get(id)?.infrastructureIncidents || state.conditions.locations[id]?.infrastructureIncidents || [];
        changes.set(id, { ...changes.get(id), infrastructureIncidents: mergeInfrastructure(previous, infrastructureIncidents, "digitraffic", true) });
      }
      diagnostics.overflow += parsed.overflow;
      updateHealth("digitraffic", Object.values(parsed.locations).filter((items) => items.length).length, false);
      infrastructureItem("digitraffic").healthyEmpty = !Object.values(parsed.locations).some((items) => items.length);
    } catch (error) {
      if (!infrastructureItem("digitraffic").failed) recordInfrastructureFailure("digitraffic", "source", error, true);
      updateHealth("digitraffic", 0, true);
    }
  }
  const applyInfrastructure = (sourceId: ConditionSourceId, parsed: Record<string, NonNullable<LocationConditions["infrastructureIncidents"]>>, complete: boolean) => {
    for (const [id, records] of Object.entries(parsed)) {
      const previous = changes.get(id)?.infrastructureIncidents || state!.conditions.locations[id]?.infrastructureIncidents || [];
      const ranked = { [id]: mergeInfrastructure(previous, records, sourceId, complete) };
      diagnostics.overflow += rankInfrastructure(ranked);
      changes.set(id, { ...changes.get(id), infrastructureIncidents: ranked[id] });
    }
  };
  const infrastructureTasks: Array<{ id: ConditionSourceId; run: () => Promise<{ matched: number; complete: boolean }> }> = [];
  if (sourceIsDue(state.conditions.health["krisinformation-infrastructure"]?.checkedAt, 1, now) && conditionSourceEnabled("krisinformation-infrastructure", env)) infrastructureTasks.push({ id: "krisinformation-infrastructure", run: async () => {
    const { body } = await infrastructureRequest("krisinformation-infrastructure", "news", "https://api.krisinformation.se/v3/news?language=sv&allCounties=true&days=1&includeTest=false", 512 * 1024, "json", Math.min(deadline, Date.now() + 8000));
    const parsed = parseKrisinformationInfrastructure(body, now); applyInfrastructure("krisinformation-infrastructure", parsed.locations, true); diagnostics.overflow += parsed.overflow;
    return { matched: Object.values(parsed.locations).filter((items) => items.length).length, complete: true };
  } });
  if (sourceIsDue(state.conditions.health["ndw-traffic"]?.checkedAt, 1, now) && conditionSourceEnabled("ndw-traffic", env)) infrastructureTasks.push({ id: "ndw-traffic", run: async () => {
    const taskDeadline = Math.min(deadline, Date.now() + 8000); const merged: Record<string, NonNullable<LocationConditions["infrastructureIncidents"]>> = {};
    for (const path of ["veiligheidsgerelateerde_berichten_srti.xml.gz", "tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz"]) {
      const { body } = await infrastructureRequest("ndw-traffic", path.startsWith("veiligheids") ? "safety" : "closures", `https://opendata.ndw.nu/${path}`, 512 * 1024, "bytes", taskDeadline); const expanded = gunzipSync(body as Uint8Array, { maxOutputLength: 3 * 1024 * 1024 });
      const parsed = parseNdwInfrastructure(expanded.toString("utf8"), now); for (const [id, records] of Object.entries(parsed.locations)) merged[id] = [...(merged[id] || []), ...records];
    }
    diagnostics.overflow += rankInfrastructure(merged); applyInfrastructure("ndw-traffic", merged, true); return { matched: Object.values(merged).filter((items) => items.length).length, complete: true };
  } });
  if (sourceIsDue(state.conditions.health["autobahn-traffic"]?.checkedAt, 1, now) && conditionSourceEnabled("autobahn-traffic", env)) infrastructureTasks.push({ id: "autobahn-traffic", run: async () => {
    const taskDeadline = Math.min(deadline, Date.now() + 8000); const merged: Record<string, NonNullable<LocationConditions["infrastructureIncidents"]>> = {}; let failures = 0;
    const targets = autobahnRoadIds.flatMap((road) => (["closure", "warning"] as const).map((kind) => ({ road, kind,
      key: `infrastructure:autobahn-traffic:${road}:${kind}` }))).sort((a, b) => Date.parse(state!.conditions.attempts[a.key] || "1970-01-01T00:00:00Z")
        - Date.parse(state!.conditions.attempts[b.key] || "1970-01-01T00:00:00Z") || a.road.localeCompare(b.road) || a.kind.localeCompare(b.kind));
    await mapConcurrent(targets, 4, async ({ road, kind, key }) => {
      const failuresBefore = infrastructureItem("autobahn-traffic").failed;
      try { const { body } = await infrastructureRequest("autobahn-traffic", `${road}:${kind}`, `https://verkehr.autobahn.de/o/autobahn/${road}/services/${kind}`, 64 * 1024, "json", taskDeadline); const parsed = parseAutobahnInfrastructure(body, road, kind, now); for (const [id, records] of Object.entries(parsed.locations)) merged[id] = [...(merged[id] || []), ...records]; successfulAutobahnAttempts.add(key); }
      catch (error) { if (infrastructureItem("autobahn-traffic").failed === failuresBefore) recordInfrastructureFailure("autobahn-traffic", `${road}:${kind}`, error, true); failures += 1; failedAutobahnAttempts.add(key); }
    });
    if (failures === autobahnRoadIds.length * 2) throw new Error("Autobahn transports unavailable"); diagnostics.overflow += rankInfrastructure(merged); applyInfrastructure("autobahn-traffic", merged, failures === 0);
    return { matched: Object.values(merged).filter((items) => items.length).length, complete: failures === 0 };
  } });
  if (sourceIsDue(state.conditions.health["eac-power"]?.checkedAt, 1, now) && conditionSourceEnabled("eac-power", env)) infrastructureTasks.push({ id: "eac-power", run: async () => {
    const taskDeadline = Math.min(deadline, Date.now() + 8000); const merged: Record<string, NonNullable<LocationConditions["infrastructureIncidents"]>> = {}; let failures = 0;
    await mapConcurrent(["0", "1", "2", "3", "4"], 4, async (district) => { const failuresBefore = infrastructureItem("eac-power").failed; try { const { body } = await infrastructureRequest("eac-power", `district:${district}`, `https://www.eac.com.cy/EN/RegulatedActivities/Distribution/PowerInterruptions/Pages/Faultsandscheduledinterruptions.aspx?District=${district}`, 256 * 1024, "xml", taskDeadline); const parsed = parseEacInfrastructure(String(body), district, now); for (const [id, records] of Object.entries(parsed.locations)) merged[id] = [...(merged[id] || []), ...records]; } catch (error) { if (infrastructureItem("eac-power").failed === failuresBefore) recordInfrastructureFailure("eac-power", `district:${district}`, error, true); failures += 1; } });
    if (failures === 5) throw new Error("EAC transports unavailable"); diagnostics.overflow += rankInfrastructure(merged); applyInfrastructure("eac-power", merged, failures === 0); return { matched: Object.values(merged).filter((items) => items.length).length, complete: failures === 0 };
  } });
  if (sourceIsDue(state.conditions.health["enemalta-power"]?.checkedAt, 1, now) && conditionSourceEnabled("enemalta-power", env)) infrastructureTasks.push({ id: "enemalta-power", run: async () => {
    const taskDeadline = Math.min(deadline, Date.now() + 8000); const [current, planned] = await Promise.all([
      infrastructureRequest("enemalta-power", "current", "https://mobilegis.enemalta.com.mt/mobilegis_rest/api/currentoutages/GetOutages", 512 * 1024, "json", taskDeadline),
      infrastructureRequest("enemalta-power", "planned", "https://mobilegis.enemalta.com.mt/mobilegis_Rest/api/currentoutages/GetPlannedOutages", 512 * 1024, "json", taskDeadline),
    ]); const parsed = parseEnemaltaInfrastructure(current.body, planned.body, now); applyInfrastructure("enemalta-power", parsed.locations, true); diagnostics.overflow += parsed.overflow; return { matched: Object.values(parsed.locations).filter((items) => items.length).length, complete: true };
  } });
  if (sourceIsDue(state.conditions.health["pse-energy-compass"]?.checkedAt, 1, now) && conditionSourceEnabled("pse-energy-compass", env)) infrastructureTasks.push({ id: "pse-energy-compass", run: async () => {
    const { body } = await infrastructureRequest("pse-energy-compass", "national", "https://api.raporty.pse.pl/api/pdgsz?$filter=is_active%20eq%20true&$orderby=dtime_utc%20desc&$first=48", 256 * 1024, "json", Math.min(deadline, Date.now() + 8000)); const parsed = parsePseEnergyCompass(body, now);
    for (const [id, systemConditions] of Object.entries(parsed)) changes.set(id, { ...changes.get(id), systemConditions });
    return { matched: Object.values(parsed).filter((items) => items.length).length, complete: true };
  } });
  await mapConcurrent(infrastructureTasks, 8, async (task) => {
    if (Date.now() + 8000 > deadline) {
      const item = infrastructureItem(task.id); item.skipped += 1;
      item.failureCodes.deadline_exhausted = (item.failureCodes.deadline_exhausted || 0) + 1;
      diagnostics.infrastructureSkipped += 1;
      return;
    }
    const failuresBefore = infrastructureItem(task.id).failed;
    try {
      const result = await task.run(); infrastructureItem(task.id).healthyEmpty = result.complete && result.matched === 0;
      health[task.id] = { checkedAt: now.toISOString(), status: result.complete ? "ok" : "partial", matched: result.matched, code: result.complete ? null : "partial_transport_failure" };
    } catch (error) {
      if (infrastructureItem(task.id).failed === failuresBefore) recordInfrastructureFailure(task.id, "source", error, true);
      updateHealth(task.id, 0, true);
    }
  });
  const sourceDurationMs = Math.round(performance.now() - started);
  let committed: IngestionState | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await options.stateStore.read();
    assertCollection(latest.data, collection);
    if (latest.data.conditions.lease?.id !== leaseId) throw new Error("Conditions lease superseded");
    // Failed forecast attempts remain quota-accounted, but become due on the
    // next worker pass. Do not delete a newer concurrent reservation.
    for (const key of failedForecastAttempts) if (latest.data.conditions.attempts[key] === attemptAt) delete latest.data.conditions.attempts[key];
    for (const key of successfulAutobahnAttempts) latest.data.conditions.attempts[key] = attemptAt;
    for (const key of failedAutobahnAttempts) delete latest.data.conditions.attempts[key];
    for (const [id, update] of changes) latest.data.conditions.locations[id] = { ...(latest.data.conditions.locations[id] || emptyConditions()), ...update };
    Object.assign(latest.data.conditions.health, health);
    Object.assign(latest.data.conditions.cacheUntil, cacheUpdates);
    if (cooldown && Date.parse(cooldown) > Date.parse(latest.data.conditions.cooldownUntil || "1970-01-01T00:00:00Z")) latest.data.conditions.cooldownUntil = cooldown;
    try { await options.stateStore.write(fitConditionsState(latest.data, now), latest); committed = latest.data; break; }
    catch (error) { if (!(error instanceof ConcurrencyError) || attempt === 2) throw error; }
  }
  if (!committed) throw new Error("Conditions merge failed");
  diagnostics.matched = changes.size;
  const publicationState = await options.stateStore.read();
  assertCollection(publicationState.data, collection);
  const expandedPublication = collection!.catalogVersion === 3
    ? await publishCommittedCatalog({ stateStore: options.stateStore, stores: options.catalogPublication!, collection: collection!, now, clock: options.now ? () => options.now! : undefined, family: "conditions", env })
    : undefined;
  const files = expandedPublication ? [] : buildConditionsFiles(publicationState.data, now, env);
  const publication = expandedPublication?.publication || await options.publish(files);
  const combinedFailures = [...publication.failed, ...(expandedPublication?.legacyPublication.failed || [])];
  const failures = combinedFailures.slice(0, MAX_PUBLICATION_FAILURES);
  const boundedDiagnostics = { ...diagnostics,
    forecasts: Object.fromEntries(Object.entries(forecastDiagnostics).map(([kind, item]) => {
      const countries = [...item.affectedCountries].sort();
      return [kind, { ...item, failureCodes: Object.fromEntries(Object.entries(item.failureCodes).sort(([a], [b]) => a.localeCompare(b))),
        affectedCountries: countries.slice(0, MAX_PUBLICATION_FAILURES), omittedCountries: Math.max(0, countries.length - MAX_PUBLICATION_FAILURES) }];
    })),
    infrastructure: Object.fromEntries([...infrastructureDiagnostics].sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => [id, {
      ...item, failureCodes: Object.fromEntries(Object.entries(item.failureCodes).sort(([a], [b]) => a.localeCompare(b))),
      targetExamples: [...item.targetExamples].sort((a, b) => a.target.localeCompare(b.target) || a.code.localeCompare(b.code)).slice(0, MAX_PUBLICATION_FAILURES),
      omittedTargets: Math.max(0, item.failed - MAX_PUBLICATION_FAILURES),
    }])) };
  return { status: combinedFailures.length ? "partial" : env.LOCAL_CONDITIONS_ENABLED === "true" ? "ok" : "disabled",
    countries: expandedPublication?.countries ?? files.length, locations: collection!.catalogVersion === 3 ? catalogLocationsV3.length : locations.length,
    bytes: expandedPublication?.conditionsBytes ?? files.reduce((total, file) => total + Buffer.byteLength(JSON.stringify(file)), 0), privateStateBytes: Buffer.byteLength(JSON.stringify(committed)),
    cacheBytes: Buffer.byteLength(JSON.stringify(committed.conditions.locations)), sources: health, sourceDurationMs, diagnostics: boundedDiagnostics,
    publication: { ...(expandedPublication ? { dual: expandedPublication.dual, legacy: expandedPublication.legacyPublication } : {}), published: publication.published.length, unchanged: publication.unchanged.length, failed: combinedFailures.length,
      failures, omittedFailures: Math.max(0, combinedFailures.length - failures.length) }, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof CollectionChangedError) {
      // Results from this run were discarded. Matching reservation markers may
      // become due again, but issued-request charges remain in private state.
      for (const batch of batches) for (const id of batch.ids) failedForecastAttempts.add(`${batch.kind}:${id}`);
    }
    throw error;
  } finally {
    // Keep the lease through publication, but never force the next pass to wait after an error.
    await releaseLease(options.stateStore, leaseId, failedForecastAttempts, attemptAt, cooldown);
  }
}
