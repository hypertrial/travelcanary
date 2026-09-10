import { fromArrayBuffer } from "geotiff";
import { AggregateSourceResultSchema, type AggregateSourceResult, type NormalizedEvent } from "../../domain/schemas";
import { contextFeedsEnabled } from "../context-feeds";
import { fetchAllowlisted } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const host = "drought.emergency.copernicus.eu";
const configUrl = `https://${host}/services/config?appCode=edo_map`;
const maxProductAgeMs = 25 * 24 * 60 * 60_000;
const expectedWidth = 1_824;
const expectedHeight = 1_200;
const expectedBounds = [-25, 22, 51, 72] as const;

function dateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\b(20\d{2})[-/]?(\d{2})[-/]?(\d{2})\b/);
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isFinite(Date.parse(`${candidate}T00:00:00.000Z`)) ? candidate : null;
}

export function edoProductDate(value: unknown): string {
  const candidates: string[] = [];
  function visit(node: unknown, inCdi = false) {
    if (Array.isArray(node)) { node.forEach((item) => visit(item, inCdi)); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const currentIsCdi = inCdi || Object.values(record).some((item) => typeof item === "string" && item.toLowerCase() === "cdiad");
    if (currentIsCdi) for (const [key, item] of Object.entries(record)) {
      if (/date|day|time/i.test(key)) { const parsed = dateString(item); if (parsed) candidates.push(parsed); }
    }
    for (const item of Object.values(record)) visit(item, currentIsCdi);
  }
  visit(value);
  const latest = candidates.sort().at(-1);
  if (!latest) throw new Error("EDO configuration has no cdiad product date");
  return latest;
}

function closeEnough(actual: number[], expected: readonly number[]) {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) < 0.01);
}

export async function edoEvents(bytes: Uint8Array, productDate: string, context: IngestionContext) {
  const sourceTime = Date.parse(`${productDate}T00:00:00.000Z`);
  if (!Number.isFinite(sourceTime) || sourceTime > context.now.getTime() + 24 * 60 * 60_000 || context.now.getTime() - sourceTime > maxProductAgeMs) throw new Error("EDO cdiad product is stale or future-dated");
  const tiff = await fromArrayBuffer(bytes.slice().buffer as ArrayBuffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== expectedWidth || image.getHeight() !== expectedHeight || !closeEnough(image.getBoundingBox(), expectedBounds)) throw new Error("EDO cdiad raster grid does not match the reviewed contract");
  const rasters = await image.readRasters();
  if (rasters.length !== 1) throw new Error("EDO cdiad raster must contain one band");
  const band = rasters[0];
  let invalid = 0;
  for (let index = 0; index < band.length; index += 1) if (!([0, 1, 2, 3, 4, 5, 6, 255] as number[]).includes(Number(band[index]))) invalid += 1;
  if (invalid) throw new Error(`EDO cdiad raster contains ${invalid} undocumented class values`);
  const locationIds = context.locations.filter((location) => {
    const [longitude, latitude] = location.centroid;
    if (longitude < expectedBounds[0] || longitude > expectedBounds[2] || latitude < expectedBounds[1] || latitude > expectedBounds[3]) return false;
    const x = Math.min(expectedWidth - 1, Math.max(0, Math.floor(((longitude - expectedBounds[0]) / (expectedBounds[2] - expectedBounds[0])) * expectedWidth)));
    const y = Math.min(expectedHeight - 1, Math.max(0, Math.floor(((expectedBounds[3] - latitude) / (expectedBounds[3] - expectedBounds[1])) * expectedHeight)));
    return Number(band[y * expectedWidth + x]) === 3;
  }).map(({ id }) => id).sort();
  const sourceUpdatedAt = new Date(sourceTime).toISOString();
  const expiresAt = new Date(sourceTime + maxProductAgeMs).toISOString();
  const events: NormalizedEvent[] = locationIds.length ? [{
    id: `edo-drought:${productDate}`, sourceId: "edo-drought", providerId: "edo-drought", type: "drought", level: "ELEVATED", timing: "ACTIVE",
    headline: `Agricultural drought alert context applies near ${locationIds.length} destination${locationIds.length === 1 ? "" : "s"}.`,
    explanation: "Copernicus EDO CDI class 3 indicates dekadal agricultural and ecosystem drought context. It is not an immediate emergency warning.",
    action: "Check current local water restrictions, fire precautions, and official advice.", affectedArea: "Destinations in EDO CDI Alert cells",
    geometry: { kind: "locations", ids: locationIds }, startsAt: sourceUpdatedAt, endsAt: expiresAt, sourceUpdatedAt,
    checkedAt: context.now.toISOString(), expiresAt, sourceName: "Copernicus European Drought Observatory", sourceUrl: "https://drought.emergency.copernicus.eu/",
    confidence: "MEDIUM",
  }] : [];
  recordSourceDiagnostics(context, { recordsExamined: band.length, targetsScheduled: context.locations.length, targetsCompleted: context.locations.length, matchedLocations: locationIds.length });
  return events;
}

export class EdoDroughtAdapter implements SourceAdapter {
  readonly id = "edo-drought" as const;
  readonly cadence = "daily" as const;
  constructor(private readonly enabled = contextFeedsEnabled()) {}
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    if (!this.enabled) return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "disabled", limitationCode: "context_feeds_disabled", error: null });
    try {
      // The reviewed WCS regularly takes about ten seconds to stream its 2.1 MB
      // raster. One longer attempt is both faster and gentler than three doomed
      // five-second attempts.
      const config = await fetchAllowlisted(context.fetch, configUrl, [host], 1, { maxBytes: 2 * 1024 * 1024, timeoutMs: 8_000, diagnosticsCategory: "edo_config" }).then((response) => response.json());
      const productDate = edoProductDate(config);
      const wcs = `https://${host}/api/wcs?map=DO_WCS&SERVICE=WCS&VERSION=2.0.0&REQUEST=GetCoverage&coverageID=cdiad&CRS=EPSG:4326&format=GEOTIFF&TIME=${productDate}`;
      const bytes = new Uint8Array(await (await fetchAllowlisted(context.fetch, wcs, [host], 1, { maxBytes: 3 * 1024 * 1024, timeoutMs: 15_000, diagnosticsCategory: "edo_cdiad" })).arrayBuffer());
      const events = await edoEvents(bytes, productDate, context);
      const sourceUpdatedAt = new Date(`${productDate}T00:00:00.000Z`).toISOString();
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt, events, status: "ok", error: null, checkedLocationIds: context.locations.map(({ id }) => id), unavailableLocationIds: [], removedEventPrefixes: ["edo-drought:"] });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) });
    }
  }
}
