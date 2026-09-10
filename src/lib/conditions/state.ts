import { assertCatalog2Collection, type IngestionStateV14 as IngestionState } from "../domain/catalog-state";
import { countryCodes, } from "../domain/schemas";
import { locations } from "../data";
import { CONDITIONS_CACHE_LIMIT, CONDITIONS_COUNTRY_LIMIT, CONDITIONS_TOTAL_LIMIT, ConditionsSchema, conditionRecords, conditionSourceAppliesToCountry, emptyConditions, type Conditions, type LocationConditions } from "../domain/conditions";
import { PRIVATE_STATE_HARD_LIMIT_BYTES } from "../ingestion/limits";
import { conditionAttribution, conditionSourceEnabled } from "./sources";
import { marineConditionEligible } from "./marine";

import { currentConditions } from "./presentation";
export { currentConditions } from "./presentation";

const forecastHealthSources = new Set(["open-meteo-weather", "open-meteo-air", "open-meteo-marine", "met-norway"]);

export function fitConditionsState(state: IngestionState, now: Date) {
  state.conditions.reservations = state.conditions.reservations.filter((item) => Date.parse(item.at) > now.getTime() - 24 * 3_600_000);
  for (const [id, value] of Object.entries(state.conditions.locations)) {
    const current = currentConditions(value, now);
    if (!conditionRecords(current).length) delete state.conditions.locations[id];
    else state.conditions.locations[id] = current;
  }
  const ordered = Object.entries(state.conditions.locations).sort(([a, x], [b, y]) => {
    const time = (value: LocationConditions) => Math.max(...conditionRecords(value).map((item) => Date.parse(item.checkedAt)));
    return time(x) - time(y) || a.localeCompare(b);
  });
  // Optional conditions yield space to alert evidence; controls/quota reservations never do.
  let cacheBytes = Buffer.byteLength(JSON.stringify(state.conditions.locations));
  let stateBytes = Buffer.byteLength(JSON.stringify(state));
  let remaining = ordered.length;
  for (const [id, value] of ordered) {
    if (cacheBytes <= CONDITIONS_CACHE_LIMIT && stateBytes <= PRIVATE_STATE_HARD_LIMIT_BYTES) break;
    // Account for one JSON property and its comma, avoiding a full-state stringify per eviction.
    const removedBytes = Buffer.byteLength(JSON.stringify(id)) + 1 + Buffer.byteLength(JSON.stringify(value)) + (remaining > 1 ? 1 : 0);
    delete state.conditions.locations[id]; remaining -= 1;
    cacheBytes -= removedBytes; stateBytes -= removedBytes;
  }
  if (stateBytes > PRIVATE_STATE_HARD_LIMIT_BYTES) throw new Error("Private ingestion state exceeds 5 MB hard limit");
  return state;
}

export function buildConditionsFiles(state: IngestionState, now: Date, env: Record<string, string | undefined> = process.env): Conditions[] {
  assertCatalog2Collection(state);
  return projectCatalog2Conditions(state, now, env);
}

export function projectCatalog2Conditions(state: IngestionState, now: Date, env: Record<string, string | undefined> = process.env): Conditions[] {
  const files = countryCodes.map((countryCode) => {
    const entries = Object.fromEntries(locations.filter((location) => location.countryCode === countryCode).map((location) => {
      const data = currentConditions(state.conditions.locations[location.id] || emptyConditions(), now, (id) => conditionSourceEnabled(id, env));
      data.limitations = conditionRecords(data).length ? [] : [env.LOCAL_CONDITIONS_ENABLED === "true" ? "update-pending" : "disabled"];
      if (location.isCoastal && conditionSourceEnabled("open-meteo-marine", env) && !marineConditionEligible(location.id)) data.limitations.push("outside-product");
      if (conditionRecords(data).length && ((conditionSourceEnabled("open-meteo-weather", env) && !data.weather)
        || (conditionSourceEnabled("open-meteo-air", env) && !data.airQuality)
        || (marineConditionEligible(location.id) && conditionSourceEnabled("open-meteo-marine", env) && !data.marine))) data.limitations.push("partial-data");
      return [location.id, data];
    }));
    const applicable = Object.entries(state.conditions.health).filter(([id]) => !forecastHealthSources.has(id) && conditionSourceEnabled(id as Parameters<typeof conditionSourceEnabled>[0], env)
      && conditionSourceAppliesToCountry(id as Parameters<typeof conditionSourceEnabled>[0], countryCode));
    const sources = [...new Set([...Object.values(entries).flatMap((entry) => conditionRecords(entry).map((item) => item.sourceId)), ...applicable.map(([id]) => id as Parameters<typeof conditionAttribution>[0])])];
    const sha = env.VERCEL_GIT_COMMIT_SHA;
    const file = ConditionsSchema.parse({ schemaVersion: 2, catalogVersion: 2, countryCode, generatedAt: now.toISOString(),
      producerCommitSha: sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null,
      sources: Object.fromEntries(sources.map((id) => [id, conditionAttribution(id)])),
      sourceHealth: Object.fromEntries(applicable.map(([id, item]) => [id, { status: item!.status, checkedAt: item!.checkedAt, limitationCode: item!.code }])), locations: entries });
    if (Buffer.byteLength(JSON.stringify(file)) > CONDITIONS_COUNTRY_LIMIT) throw new Error(`Conditions exceed country limit: ${countryCode}`);
    return file;
  });
  if (files.reduce((total, file) => total + Buffer.byteLength(JSON.stringify(file)), 0) > CONDITIONS_TOTAL_LIMIT) throw new Error("Conditions exceed total publication limit");
  return files;
}

export function availableForecastWeight(state: IngestionState, now: Date) {
  if (state.conditions.cooldownUntil && Date.parse(state.conditions.cooldownUntil) > now.getTime()) return 0;
  return Math.max(0, Math.min(...[[60_000, 400], [3_600_000, 2000], [24 * 3_600_000, 8000]].map(([window, limit]) =>
    limit - state.conditions.reservations.filter((item) => Date.parse(item.at) > now.getTime() - window).reduce((sum, item) => sum + item.weight, 0))));
}
