import mappingJson from "../../../../data/eea-station-mapping.json";
import { CatalogPartitionedSourceResultSchema, type CatalogPartitionedSourceResult, type NormalizedEventV13 } from "../../domain/catalog-state";
import { catalogV3CountryCodes } from "../../domain/contract-identities";
import { PartitionedSourceResultSchema, countryCodes, type HazardLevel, type PartitionedSourceResult } from "../../domain/schemas";
import { fetchAllowlisted, mapConcurrent, readJsonWithLimit } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const baseUrl = "https://dis2datalake.blob.core.windows.net/airquality-derivated/AQI-noRunningMeans";
const host = "dis2datalake.blob.core.windows.net";
const maxDetailStations = 32;
type Sample = { locationId?: unknown; value?: unknown; rasterId?: unknown };
type Station = { code?: unknown; operational?: unknown; lon?: unknown; lat?: unknown };
type DetailRow = Record<string, unknown> & { culprit?: unknown; aqi?: unknown };
type MappingStation = { code: string; name: string; coordinates: [number, number]; distanceKm: number };
const mapping = mappingJson as unknown as { stationMetadataRevision: string; locations: Record<string, MappingStation[]> };

export function selectEeaDetailStations(codes: string[]) {
  const ordered = [...new Set(codes)].sort();
  return { selected: ordered.slice(0, maxDetailStations), unavailable: ordered.slice(maxDetailStations) };
}

export function eeaTargetTime(now: Date): Date {
  const target = new Date(now.getTime() - 3 * 60 * 60_000);
  target.setUTCMinutes(0, 0, 0);
  return target;
}

export function eeaLevel(value: number): HazardLevel | null {
  return value >= 6 ? "SEVERE" : value >= 5 ? "HIGH" : value >= 4 ? "ELEVATED" : null;
}

/** Retained for historical fixture compatibility; the runtime no longer consumes raster samples. */
export function parseEeaSamples(value: unknown, pointCount: number): Array<{ pointIndex: number; category: number; rasterId: number }> {
  const samples = Array.isArray((value as { samples?: unknown[] })?.samples) ? (value as { samples: Sample[] }).samples : [];
  return samples.flatMap((sample) => {
    const pointIndex = Number(sample.locationId); const category = Number(sample.value); const rasterId = Number(sample.rasterId);
    return Number.isInteger(pointIndex) && pointIndex >= 0 && pointIndex < pointCount && Number.isInteger(category) && category >= 1 && category <= 6
      && Number.isInteger(rasterId) && rasterId >= 1 ? [{ pointIndex, category, rasterId }] : [];
  });
}

/** Retained for deterministic migration tests; Canary WMS is no longer a monitoring transport. */
export function parseCanaryFeatureInfo(value: string, now: Date): { category: number; sourceTime: Date } | null {
  const features = value.split(/(?:^|\n)\s*Feature \d+:/i).slice(1); let parseable = 0;
  let best: { category: number; sourceTime: Date } | null = null;
  for (const block of features) {
    const category = Number(block.match(/\blevel\s*=\s*'([^']+)'/i)?.[1]);
    const rawTime = block.match(/\bupdate_at\s*=\s*'([^']+)'/i)?.[1]?.replace(" ", "T");
    const sourceTime = new Date(`${rawTime}${rawTime && /(?:Z|[+-]\d\d:\d\d)$/.test(rawTime) ? "" : "Z"}`);
    if (!Number.isInteger(category) || category < 1 || category > 6 || !Number.isFinite(sourceTime.getTime())) continue;
    parseable += 1;
    if (now.getTime() - sourceTime.getTime() > 6 * 60 * 60_000 || sourceTime.getTime() > now.getTime() + 5 * 60_000) continue;
    if (!best || category > best.category || category === best.category && sourceTime > best.sourceTime) best = { category, sourceTime };
  }
  if (features.length && parseable === 0) throw new Error("Canary WMS feature response was malformed");
  return best;
}

export function parseEeaStationIndex(value: unknown) {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error("EEA station metadata is malformed or unbounded");
  const stations = new Map<string, { coordinates: [number, number] }>();
  for (const raw of value as Station[]) {
    const code = typeof raw.code === "string" ? raw.code : ""; const longitude = Number(raw.lon); const latitude = Number(raw.lat);
    if (raw.operational !== 1 || !/^[A-Z]{2}[A-Z0-9]{3,10}$/.test(code) || !Number.isFinite(longitude) || !Number.isFinite(latitude)
      || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) continue;
    stations.set(code, { coordinates: [longitude, latitude] });
  }
  return stations;
}

export function parseEeaHourlyMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 40_000) throw new Error("EEA hourly station map is malformed or unbounded");
  const categories = new Map<string, number>();
  for (const [code, raw] of Object.entries(value as Record<string, unknown>)) {
    if (code.endsWith("_cp") || !/^[A-Z]{2}[A-Z0-9]{3,10}$/.test(code)) continue;
    const category = Number(raw); const culprit = Number((value as Record<string, unknown>)[`${code}_cp`]);
    if (Number.isFinite(category) && category >= 0 && category <= 6 && Number.isInteger(culprit) && culprit >= 0 && culprit <= 8) categories.set(code, category);
  }
  return categories;
}

export function observationBackedEeaDetail(value: unknown, sourceTime: Date): { category: number; pollutant: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 1_000) throw new Error("EEA station detail is malformed or unbounded");
  const numberField = (raw: unknown) => typeof raw === "number" || typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  const candidates = Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
    const time = Date.parse(key); const row = raw as DetailRow;
    if (!Number.isFinite(time) || Math.abs(time - sourceTime.getTime()) > 90 * 60_000 || !row || typeof row !== "object") return [];
    const pollutant = typeof row.culprit === "string" ? row.culprit.replace(/[^A-Za-z0-9.]/g, "") : "";
    const category = numberField(row.aqi); const observed = numberField(row[`val_${pollutant}`]); const modelled = numberField(row[`modelled_${pollutant}`]);
    if (!pollutant || !Number.isFinite(category) || category < 0 || category > 6 || !Number.isFinite(observed) || modelled !== 0) return [];
    return [{ time, category, pollutant }];
  }).sort((left, right) => Math.abs(left.time - sourceTime.getTime()) - Math.abs(right.time - sourceTime.getTime()));
  return candidates[0] ? { category: candidates[0].category, pollutant: candidates[0].pollutant } : null;
}

function eventFor(location: IngestionContext["locations"][number], station: MappingStation, category: number, pollutant: string, sourceTime: Date, checkedAt: string): NormalizedEventV13 | null {
  const level = eeaLevel(category); if (!level) return null;
  const categoryName = category >= 6 ? "Extremely poor" : category >= 5 ? "Very poor" : "Poor";
  return {
    id: `eea-aqi:${Math.floor(sourceTime.getTime() / 3_600_000).toString(36)}:${station.code}:${location.id}`, sourceId: "eea", providerId: "eea-aqi",
    type: "air-quality", level, timing: "ACTIVE", headline: `${categoryName} observed air quality near ${location.name}.`,
    explanation: `EEA station ${station.name} reported observation-backed ${pollutant} as the culprit pollutant. Station coverage is partial and is not an all-clear.`,
    action: level === "SEVERE" ? "Limit outdoor activity and follow local health advice." : level === "HIGH"
      ? "Avoid strenuous outdoor activity and check local health advice." : "Sensitive travellers should reduce prolonged outdoor activity.",
    affectedArea: `Near ${location.name}`, geometry: { kind: "locations", ids: [location.id] }, startsAt: sourceTime.toISOString(),
    endsAt: new Date(sourceTime.getTime() + 6 * 60 * 60_000).toISOString(), sourceUpdatedAt: sourceTime.toISOString(), checkedAt,
    expiresAt: new Date(sourceTime.getTime() + 6 * 60 * 60_000).toISOString(), sourceName: "European Environment Agency",
    sourceUrl: "https://airindex.eea.europa.eu/AQI/", confidence: "HIGH", transportId: "eea-stations",
  };
}

function activeCountryCodes(context: IngestionContext) {
  const catalog3 = context.state?.collection.catalogVersion === 3 || context.locations.some(({ countryCode }) => !(countryCodes as readonly string[]).includes(countryCode));
  return catalog3 ? catalogV3CountryCodes : countryCodes;
}

function parseResult(context: IngestionContext, result: unknown): CatalogPartitionedSourceResult | PartitionedSourceResult {
  return (activeCountryCodes(context).length === catalogV3CountryCodes.length ? CatalogPartitionedSourceResultSchema : PartitionedSourceResultSchema).parse(result);
}

export class EeaAdapter implements SourceAdapter {
  readonly id = "eea" as const;
  readonly cadence = "slow" as const;

  async fetch(context: IngestionContext): Promise<CatalogPartitionedSourceResult | PartitionedSourceResult> {
    const checkedAt = context.now.toISOString(); const codes = activeCountryCodes(context); const locations = context.locations.filter(({ id }) => mapping.locations[id]?.length);
    const byteBudget = { remaining: 24 * 1024 * 1024 }; const sourceTime = eeaTargetTime(context.now);
    recordSourceDiagnostics(context, { targetsScheduled: locations.length });
    try {
      const indexResponse = await fetchAllowlisted(context.fetch, `${baseUrl}/content/index.json`, [host], 2,
        { maxBytes: 64 * 1024, byteBudget, diagnosticsCategory: "station_index" });
      const index = await readJsonWithLimit(indexResponse, 64 * 1024) as { contents?: unknown };
      if (!Array.isArray(index.contents) || !index.contents.includes(mapping.stationMetadataRevision)) throw new Error("Reviewed EEA station metadata revision is unavailable");
      const stationResponse = await fetchAllowlisted(context.fetch, `${baseUrl}/content/${mapping.stationMetadataRevision}`, [host], 2,
        { maxBytes: 3 * 1024 * 1024, byteBudget, diagnosticsCategory: "station_metadata" });
      const stationIndex = parseEeaStationIndex(await readJsonWithLimit(stationResponse, 3 * 1024 * 1024));
      const reviewedStations = new Map<string, MappingStation>();
      for (const station of Object.values(mapping.locations).flat()) {
        const current = stationIndex.get(station.code);
        if (current && Math.abs(current.coordinates[0] - station.coordinates[0]) <= 0.02 && Math.abs(current.coordinates[1] - station.coordinates[1]) <= 0.02) reviewedStations.set(station.code, station);
      }
      const hour = sourceTime.toISOString().slice(0, 13);
      const mapResponse = await fetchAllowlisted(context.fetch, `${baseUrl}/map/${hour}.json`, [host], 2,
        { maxBytes: 512 * 1024, byteBudget, diagnosticsCategory: "hourly_station_map" });
      const categories = parseEeaHourlyMap(await readJsonWithLimit(mapResponse, 512 * 1024));
      const poorCodes = [...new Set(locations.flatMap(({ id }) => mapping.locations[id])
        .filter(({ code }) => reviewedStations.has(code) && eeaLevel(categories.get(code) || 0)).map(({ code }) => code))].sort();
      const detailSelection = selectEeaDetailStations(poorCodes);
      const selectedPoorCodes = detailSelection.selected;
      const unavailableDetailCodes = new Set(detailSelection.unavailable);
      const observations = new Map<string, { category: number; pollutant: string }>();
      await mapConcurrent(selectedPoorCodes, 8, async (code) => {
        try {
          const response = await fetchAllowlisted(context.fetch, `${baseUrl}/current/${code}.json`, [host], 2,
            { maxBytes: 2_500_000, byteBudget, diagnosticsCategory: "station_detail" });
          const observation = observationBackedEeaDetail(await readJsonWithLimit(response, 2_500_000), sourceTime);
          if (observation) observations.set(code, observation);
          else {
            unavailableDetailCodes.add(code);
            recordSourceDiagnostics(context, { outcomeCode: "eea_modeled_context_only" });
          }
        } catch {
          unavailableDetailCodes.add(code);
          recordSourceDiagnostics(context, { outcomeCode: "eea_station_detail_failed" });
        }
      });
      const events = locations.flatMap((location) => mapping.locations[location.id].flatMap((station) => {
        const observation = observations.get(station.code); const alert = observation && eventFor(location, station, observation.category, observation.pollutant, sourceTime, checkedAt);
        return alert ? [alert] : [];
      }));
      const eventLocationIds = new Set(events.flatMap(({ geometry }) => geometry.kind === "locations" ? geometry.ids : []));
      const checked = new Set(locations.filter(({ id }) => eventLocationIds.has(id)
        && !mapping.locations[id].some(({ code }) => unavailableDetailCodes.has(code))).map(({ id }) => id));
      recordSourceDiagnostics(context, { recordsExamined: categories.size, targetsCompleted: checked.size, matchedLocations: new Set(events.flatMap(({ geometry }) => geometry.kind === "locations" ? geometry.ids : [])).size });
      const partitions = Object.fromEntries(codes.map((countryCode) => {
        const countryLocations = context.locations.filter((location) => location.countryCode === countryCode);
        const checkedLocationIds = countryLocations.filter(({ id }) => checked.has(id)).map(({ id }) => id);
        const unavailableLocationIds = countryLocations.filter(({ id }) => !checked.has(id)).map(({ id }) => id);
        const countryIds = new Set(countryLocations.map(({ id }) => id));
        const countryEvents = events.filter(({ geometry }) => geometry.kind === "locations" && geometry.ids.some((id) => countryIds.has(id)));
        const targeted = countryLocations.some(({ id }) => mapping.locations[id]?.length);
        return [countryCode, { status: targeted ? "partial" : "disabled", sourceUpdatedAt: targeted ? sourceTime.toISOString() : null, events: countryEvents,
          error: targeted ? "Station observations are partial coverage and never establish an all-clear" : null,
          limitationCode: targeted ? "observation_only_partial_coverage" : "no_reviewed_station_mapping", checkedLocationIds, unavailableLocationIds,
          transports: { "eea-stations": { status: targeted ? checkedLocationIds.length ? "partial" : "failed" : "disabled", events: countryEvents,
            sourceUpdatedAt: targeted ? sourceTime.toISOString() : null, checkedLocationIds, unavailableLocationIds,
            error: targeted ? "Modeled and gap-filled values remain context only" : null } } }];
      }));
      return parseResult(context, { sourceId: "eea", checkedAt, partitions });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "EEA station collection failed";
      const partitions = Object.fromEntries(codes.map((countryCode) => {
        const ids = context.locations.filter((location) => location.countryCode === countryCode && mapping.locations[location.id]?.length).map(({ id }) => id);
        return [countryCode, { status: ids.length ? "failed" : "disabled", sourceUpdatedAt: null, events: [], error: ids.length ? message : null,
          limitationCode: ids.length ? "station_collection_failed" : "no_reviewed_station_mapping", checkedLocationIds: [], unavailableLocationIds: ids,
          transports: { "eea-stations": { status: ids.length ? "failed" : "disabled", events: [], sourceUpdatedAt: null, checkedLocationIds: [], unavailableLocationIds: ids, error: ids.length ? message : null } } }];
      }));
      recordSourceDiagnostics(context, { targetsCompleted: 0, outcomeCode: "eea_station_collection_failed" });
      return parseResult(context, { sourceId: "eea", checkedAt, partitions });
    }
  }
}
