import { PartitionedSourceResultSchema, countryCodes, type CountryCode, type HazardLevel, type NormalizedEvent, type PartitionedSourceResult } from "../../domain/schemas";
import { coverageByCountry, coverageByLocation } from "../../data";
import { fetchAllowlisted, readBytesWithLimit } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const serviceUrl = "https://air.discomap.eea.europa.eu/arcgis/rest/services/AQMobile_2025/MOSAIC_GLOBAL_AQI/ImageServer";
const hosts = ["air.discomap.eea.europa.eu"] as const;
const maxBytes = 512 * 1024;
const maxPointsPerRequest = 250;
const canaryHost = "idecan2.grafcan.es";
const canaryLocationIds = new Set(["es-las-palmas-de-gran-canaria", "es-santa-cruz-de-tenerife"]);

type Sample = { locationId?: unknown; value?: unknown; rasterId?: unknown };

function hasEeaCoverage(location: IngestionContext["locations"][number]) {
  const coverage = coverageByLocation[location.id]?.["air-quality"] || coverageByCountry[location.countryCode].hazards["air-quality"];
  return coverage.status !== "not_monitored" && coverage.providerIds.includes("eea-aqi");
}

export function eeaTargetTime(now: Date): Date {
  const target = new Date(now.getTime() - 3 * 60 * 60_000);
  target.setUTCMinutes(0, 0, 0);
  return target;
}

export function eeaLevel(value: number): HazardLevel | null {
  return value >= 6 ? "SEVERE" : value >= 5 ? "HIGH" : value >= 4 ? "ELEVATED" : null;
}

export function parseEeaSamples(value: unknown, pointCount: number): Array<{ pointIndex: number; category: number; rasterId: number }> {
  const samples = Array.isArray((value as { samples?: unknown[] })?.samples) ? (value as { samples: Sample[] }).samples : [];
  return samples.flatMap((sample) => {
    const pointIndex = Number(sample.locationId);
    const category = Number(sample.value);
    const rasterId = Number(sample.rasterId);
    if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= pointCount) return [];
    if (!Number.isInteger(category) || category < 1 || category > 6 || !Number.isInteger(rasterId) || rasterId < 1) return [];
    return [{ pointIndex, category, rasterId }];
  });
}

function action(level: HazardLevel): string {
  if (level === "SEVERE") return "Limit outdoor activity and follow local health advice.";
  if (level === "HIGH") return "Avoid strenuous outdoor activity and check local health advice.";
  return "Sensitive travellers should reduce prolonged outdoor activity.";
}

function eventFor(location: IngestionContext["locations"][number], category: number, sourceTime: Date, checkedAt: string, canary = false): NormalizedEvent | null {
  const level = eeaLevel(category);
  if (!level) return null;
  const expiresAt = new Date(sourceTime.getTime() + 6 * 60 * 60_000).toISOString();
  const categoryName = ["", "Good", "Fair", "Moderate", "Poor", "Very poor", "Extremely poor"][category];
  return {
    id: `eea-aqi:${Math.floor(sourceTime.getTime() / 3_600_000).toString(36)}:${location.id}`,
    sourceId: "eea",
    providerId: "eea-aqi",
    type: "air-quality",
    level,
    timing: "ACTIVE",
    headline: `${categoryName} air quality is affecting ${location.name}.`,
    explanation: canary ? `Canary Islands hourly AQI is ${categoryName.toLowerCase()} near ${location.name}.` : `EEA's 1 km European AQI is ${categoryName.toLowerCase()} near ${location.name}.`,
    action: action(level),
    affectedArea: `Near ${location.name}`,
    geometry: { kind: "locations", ids: [location.id] },
    startsAt: sourceTime.toISOString(),
    endsAt: expiresAt,
    sourceUpdatedAt: sourceTime.toISOString(),
    checkedAt,
    expiresAt,
    sourceName: canary ? "Gobierno de Canarias air quality" : "European Environment Agency",
    sourceUrl: canary ? "https://www.idecanarias.es/listado_servicios/calidad-del-aire" : "https://airindex.eea.europa.eu/AQI/index.html",
    confidence: "MEDIUM",
  };
}

export function parseCanaryFeatureInfo(text: string, now: Date): { category: number; sourceTime: Date } | null {
  const features = text.split(/(?:^|\n)\s*Feature \d+:/i).slice(1);
  let best: { category: number; sourceTime: Date } | null = null;
  let parseable = 0;
  for (const block of features) {
    const level = Number(block.match(/\blevel\s*=\s*'([^']+)'/i)?.[1]);
    // Request/cache time is not an observation update. Never renew evidence from it.
    const updatedValue = block.match(/\bupdate_at\s*=\s*'([^']+)'/i)?.[1]?.replace(" ", "T");
    const sourceTime = new Date(`${updatedValue}${updatedValue && /(?:Z|[+-]\d\d:\d\d)$/.test(updatedValue) ? "" : "Z"}`);
    if (!Number.isInteger(level) || level < 1 || level > 6 || !Number.isFinite(sourceTime.getTime())) continue;
    parseable += 1;
    if (now.getTime() - sourceTime.getTime() > 6 * 60 * 60_000 || sourceTime.getTime() > now.getTime() + 5 * 60_000) continue;
    if (!best || level > best.category || (level === best.category && sourceTime > best.sourceTime)) best = { category: level, sourceTime };
  }
  if (features.length && parseable === 0) throw new Error("Canary WMS feature response was malformed");
  return best;
}

async function canarySamples(context: IngestionContext) {
  const results = new Map<string, { category: number; sourceTime: Date }>();
  const unavailable: string[] = [];
  const limitations = new Set<string>();
  const targets = context.locations.filter(({ id }) => canaryLocationIds.has(id));
  await Promise.all(targets.map(async (location) => {
    const [longitude, latitude] = location.centroid;
    const common = { SERVICE: "WMS", VERSION: "1.3.0", LAYERS: "ESTACIONES", STYLES: "", CRS: "EPSG:4326", BBOX: `${latitude - 0.1},${longitude - 0.15},${latitude + 0.1},${longitude + 0.15}`, WIDTH: "301", HEIGHT: "201" };
    let received = false;
    try {
      const mapUrl = `https://${canaryHost}/ServicioWMS/CalidadAire?${new URLSearchParams({ ...common, REQUEST: "GetMap", FORMAT: "image/png", TRANSPARENT: "true" })}`;
      await fetchAllowlisted(context.fetch, mapUrl, [canaryHost], 2, { maxBytes: 256 * 1024, diagnosticsCategory: "canary_map" });
      const infoUrl = `https://${canaryHost}/ServicioWMS/CalidadAire?${new URLSearchParams({ ...common, REQUEST: "GetFeatureInfo", QUERY_LAYERS: "ESTACIONES", INFO_FORMAT: "text/plain", FEATURE_COUNT: "50", FI_POINT_TOLERANCE: "100", I: "150", J: "100" })}`;
      const response = await fetchAllowlisted(context.fetch, infoUrl, [canaryHost], 2, { maxBytes: 128 * 1024, diagnosticsCategory: "canary_info" });
      const text = await response.text(); received = true;
      const parsed = parseCanaryFeatureInfo(text, context.now);
      if (!parsed) {
        unavailable.push(location.id);
        limitations.add(/Feature \d+:/i.test(text) ? "canary_sample_time_unavailable" : "canary_no_representative_station");
      } else results.set(location.id, parsed);
    } catch { unavailable.push(location.id); limitations.add(received ? "canary_contract_unavailable" : "canary_request_failed"); }
  }));
  for (const outcomeCode of limitations) recordSourceDiagnostics(context, { outcomeCode });
  return { results, unavailable, limitation: [...limitations].sort().join(", ") || null };
}

function failedResult(checkedAt: string, error: unknown, applicableLocations: IngestionContext["locations"]): PartitionedSourceResult {
  return PartitionedSourceResultSchema.parse({
    sourceId: "eea",
    checkedAt,
    partitions: Object.fromEntries(countryCodes.map((countryCode) => {
      const unavailableLocationIds = applicableLocations.filter((location) => location.countryCode === countryCode).map(({ id }) => id);
      return [countryCode, {
        status: unavailableLocationIds.length ? "failed" : "ok", sourceUpdatedAt: null, events: [], error: unavailableLocationIds.length ? String(error).slice(0, 300) : null, limitationCode: null,
        checkedLocationIds: [], unavailableLocationIds,
      }];
    })),
  });
}

export class EeaAdapter implements SourceAdapter {
  readonly id = "eea" as const;
  readonly cadence = "slow" as const;

  async fetch(context: IngestionContext): Promise<PartitionedSourceResult> {
    const checkedAt = context.now.toISOString();
    const targetTime = eeaTargetTime(context.now);
    const applicableLocations = context.locations.filter(hasEeaCoverage);
    const scopedContext = { ...context, locations: applicableLocations };
    const points = applicableLocations.filter(({ id }) => !canaryLocationIds.has(id))
      .flatMap((location) => location.airQualitySamplePoints.map((coordinates) => ({ location, coordinates })));
    recordSourceDiagnostics(context, { targetsScheduled: points.length });
    // Canary observations must still finish if the continental raster fails.
    const canaryWork = canarySamples(scopedContext);

    try {
      const byteBudget = { remaining: maxBytes };
      const samples: Array<{ pointIndex: number; category: number; rasterId: number }> = [];
      for (let offset = 0; offset < points.length; offset += maxPointsPerRequest) {
        const batch = points.slice(offset, offset + maxPointsPerRequest);
        const body = new URLSearchParams({
          f: "json",
          geometryType: "esriGeometryMultipoint",
          geometry: JSON.stringify({ points: batch.map(({ coordinates }) => coordinates), spatialReference: { wkid: 4326 } }),
          time: String(targetTime.getTime()),
          returnFirstValueOnly: "true",
        });
        const response = await fetchAllowlisted(context.fetch, `${serviceUrl}/getSamples`, hosts, 3, {
          method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
          maxBytes: 128 * 1024, byteBudget,
          diagnosticsCategory: "samples",
        });
        const bytes = await readBytesWithLimit(response, maxBytes);
        const parsed = parseEeaSamples(JSON.parse(new TextDecoder().decode(bytes)), batch.length);
        samples.push(...parsed.map((sample) => ({ ...sample, pointIndex: sample.pointIndex + offset })));
      }
      if (samples.length === 0) throw new Error("EEA returned no usable AQI samples");
      const rasterIds = [...new Set(samples.map(({ rasterId }) => rasterId))];
      if (rasterIds.length !== 1) throw new Error("EEA returned samples from multiple time slices");
      const detailResponse = await fetchAllowlisted(context.fetch, `${serviceUrl}/${rasterIds[0]}?f=json`, hosts, 3, {
        maxBytes: 128 * 1024, byteBudget,
        diagnosticsCategory: "raster_metadata",
      });
      const detailBytes = await readBytesWithLimit(detailResponse, maxBytes);
      const detail = JSON.parse(new TextDecoder().decode(detailBytes)) as { attributes?: { StdTime?: unknown } };
      const sourceTime = new Date(Number(detail.attributes?.StdTime));
      if (!Number.isFinite(sourceTime.getTime()) || Math.abs(sourceTime.getTime() - targetTime.getTime()) > 60 * 60_000) throw new Error("EEA AQI source time does not match the requested hour");

      const maximumByLocation = new Map<string, number>();
      const sourceTimeByLocation = new Map<string, Date>();
      const sampledPoints = new Set(samples.map(({ pointIndex }) => pointIndex));
      const incompleteLocations = new Set(points.filter((_, index) => !sampledPoints.has(index)).map(({ location }) => location.id));
      for (const sample of samples) {
        const locationId = points[sample.pointIndex].location.id;
        maximumByLocation.set(locationId, Math.max(maximumByLocation.get(locationId) || 0, sample.category));
        sourceTimeByLocation.set(locationId, sourceTime);
      }
      const canary = await canaryWork;
      for (const [locationId, sample] of canary.results) {
        maximumByLocation.set(locationId, Math.max(maximumByLocation.get(locationId) || 0, sample.category));
        sourceTimeByLocation.set(locationId, sample.sourceTime);
      }
      recordSourceDiagnostics(context, {
        recordsExamined: samples.length,
        targetsCompleted: samples.length,
        matchedLocations: maximumByLocation.size,
      });

      const partitions = Object.fromEntries(countryCodes.map((countryCode) => {
        const countryLocations = applicableLocations.filter((location) => location.countryCode === countryCode);
        const checkedLocationIds = countryLocations.filter((location) => maximumByLocation.has(location.id) && !incompleteLocations.has(location.id)).map((location) => location.id);
        const unavailableLocationIds = countryLocations.filter((location) => !checkedLocationIds.includes(location.id)).map((location) => location.id);
        const events = countryLocations.flatMap((location) => {
          const category = maximumByLocation.get(location.id);
          const event = category ? eventFor(location, category, sourceTimeByLocation.get(location.id) || sourceTime, checkedAt, canaryLocationIds.has(location.id)) : null;
          return event ? [{ ...event, transportId: canaryLocationIds.has(location.id) ? "canary-air" : "eea-raster" }] : [];
        });
        return [countryCode, {
          status: unavailableLocationIds.length ? "partial" : "ok",
          sourceUpdatedAt: [...countryLocations].flatMap((location) => sourceTimeByLocation.get(location.id)?.toISOString() || []).sort().at(-1) || sourceTime.toISOString(), events,
          error: unavailableLocationIds.length ? `${unavailableLocationIds.length} destination samples unavailable` : null,
          limitationCode: null, checkedLocationIds, unavailableLocationIds,
          transports: Object.fromEntries(["eea-raster", ...(countryCode === "ES" ? ["canary-air"] : [])].map((transportId) => {
            const targets = countryLocations.filter(({ id }) => canaryLocationIds.has(id) === (transportId === "canary-air"));
            const checked = targets.filter(({ id }) => checkedLocationIds.includes(id)).map(({ id }) => id);
            const unavailable = targets.filter(({ id }) => !checkedLocationIds.includes(id)).map(({ id }) => id);
            return [transportId, { status: unavailable.length ? targets.some(({ id }) => maximumByLocation.has(id)) ? "partial" : "failed" : "ok", events: events.filter((event) => event.transportId === transportId),
              sourceUpdatedAt: targets.flatMap(({ id }) => sourceTimeByLocation.get(id)?.toISOString() || []).sort().at(-1) || null,
              checkedLocationIds: checked, unavailableLocationIds: unavailable, error: unavailable.length ? transportId === "canary-air" ? canary.limitation : "Samples unavailable" : null }];
          })),
        }];
      })) as Record<CountryCode, unknown>;
      return PartitionedSourceResultSchema.parse({ sourceId: "eea", checkedAt, partitions });
    } catch (error) {
      const failed = failedResult(checkedAt, error instanceof Error ? error.message : "EEA AQI failed", applicableLocations);
      const canary = await canaryWork;
      for (const countryCode of countryCodes) {
        const partition = failed.partitions[countryCode];
        const unavailableLocationIds = applicableLocations.filter((location) => location.countryCode === countryCode && !canaryLocationIds.has(location.id)).map(({ id }) => id);
        partition.transports = { "eea-raster": { status: unavailableLocationIds.length ? "failed" : "ok", events: [], sourceUpdatedAt: null,
          error: unavailableLocationIds.length ? partition.error : null, checkedLocationIds: [], unavailableLocationIds } };
      }
      const events = context.locations.flatMap((location) => {
        const sample = canary.results.get(location.id);
        const event = sample && eventFor(location, sample.category, sample.sourceTime, checkedAt, true);
        return event ? [{ ...event, transportId: "canary-air" }] : [];
      });
      failed.partitions.ES.transports!["canary-air"] = { status: canary.unavailable.length ? canary.results.size ? "partial" : "failed" : "ok", events,
        sourceUpdatedAt: [...canary.results.values()].map(({ sourceTime }) => sourceTime.toISOString()).sort().at(-1) || null,
        checkedLocationIds: [...canary.results.keys()], unavailableLocationIds: canary.unavailable, error: canary.limitation };
      if (canary.results.size) Object.assign(failed.partitions.ES, { status: "partial", events, checkedLocationIds: [...canary.results.keys()],
        unavailableLocationIds: applicableLocations.filter((location) => location.countryCode === "ES" && !canary.results.has(location.id)).map(({ id }) => id) });
      return PartitionedSourceResultSchema.parse(failed);
    }
  }
}
