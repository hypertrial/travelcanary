import { AggregateSourceResultSchema, NormalizedEventSchema, type AggregateSourceResult, type HazardType, type NormalizedEvent } from "../../domain/schemas";
import { eventAffectsLocation } from "../../geospatial";
import { fetchWithRetry, mapConcurrent } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

type Activation = { code: string; countries: string[]; eventTime: string; activationTime: string; category: string; lastUpdate: string; closed: boolean; centroid: string };
type ActivationDetail = {
  sensitive?: boolean; closed?: boolean; extent?: string; aois?: { name?: string; extent?: string }[]; category?: string; lastUpdate?: string;
  eventTime?: string; countries?: { name?: string }[]; reportLink?: string;
};

const supportedCountries = new Set(["Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland"]);

function iso(value: string) { return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`).toISOString(); }
function activationRecord(value: unknown, now: Date): Activation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Activation>;
  if (typeof item.code !== "string" || !item.code || !Array.isArray(item.countries) || !item.countries.every((country) => typeof country === "string")
    || typeof item.category !== "string" || typeof item.lastUpdate !== "string" || typeof item.eventTime !== "string" || typeof item.closed !== "boolean") return null;
  let updated: number;
  try { updated = Date.parse(iso(item.lastUpdate)); } catch { return null; }
  if (!Number.isFinite(updated) || updated > now.getTime() + 5 * 60_000) return null;
  try { iso(item.eventTime); } catch { return null; }
  return item as Activation;
}
function wktPolygon(value?: string): [number, number][][] | null {
  const match = value?.match(/^POLYGON\s*\(\((.+)\)\)$/i);
  if (!match) return null;
  const ring = match[1].split(",").map((pair) => pair.trim().split(/\s+/).map(Number) as [number, number]);
  return ring.length >= 4 && ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)) ? [ring] : null;
}
function categoryType(value: string): HazardType | null {
  const category = value.toLowerCase();
  if (category.includes("flood")) return "flood";
  if (category.includes("wildfire") || category.includes("fire")) return "wildfire";
  if (category.includes("industrial")) return "industrial";
  if (category.includes("civil")) return "civil-emergency";
  return null;
}

export class CemsAdapter implements SourceAdapter {
  readonly id = "cems" as const;
  readonly cadence = "fast" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const schedulingDeadline = Math.min(Date.now() + 45_000, context.deadlineAt ?? Number.POSITIVE_INFINITY);
    try {
      const list = await (await fetchWithRetry(context.fetch, "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=100&offset=0")).json() as { results?: unknown[]; count?: unknown; next?: unknown };
      if (!Array.isArray(list.results)) throw new Error("CEMS response has no results array");
      const incompleteList = list.results.length >= 100 || list.next != null
        || (list.count !== undefined && list.count !== list.results.length);
      const parsed = list.results.slice(0, 100).map((item) => activationRecord(item, context.now));
      const invalid = parsed.filter((item) => item === null).length;
      const valid = parsed.filter((item): item is Activation => item !== null);
      if (list.results.length > 0 && valid.length === 0) throw new Error("CEMS response contains no parseable activation records");
      const removedEventPrefixes = valid.filter((item) => item.closed).map((item) => `cems:${item.code}`);
      const recent = valid.filter((item) => !item.closed && item.countries.some((country) => supportedCountries.has(country)) && categoryType(item.category) && context.now.getTime() - Date.parse(iso(item.lastUpdate)) < 24 * 60 * 60 * 1000);
      const eventGroups = await mapConcurrent(recent, 5, async (activation): Promise<{ events: NormalizedEvent[]; failed: boolean; partial?: boolean; removedEventPrefixes?: string[] }> => {
        if (Date.now() >= schedulingDeadline) return { events: [], failed: true };
        try {
          const detailPayload = await (await fetchWithRetry(context.fetch, `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=${encodeURIComponent(activation.code)}`, {}, 2)).json() as { results?: ActivationDetail[] };
          if (!Array.isArray(detailPayload.results) || detailPayload.results.length === 0) return { events: [], failed: true };
          const detail = detailPayload.results?.[0];
          if (detail?.sensitive === true) return { events: [], failed: false, removedEventPrefixes: [`cems:${activation.code}`] };
          if (detail?.closed === true) {
            const updatedAt = iso(detail.lastUpdate || activation.lastUpdate);
            if (Date.parse(updatedAt) > context.now.getTime() + 5 * 60_000) return { events: [], failed: true };
            return { events: [], failed: false, removedEventPrefixes: [`cems:${activation.code}`] };
          }
          if (!detail || detail.sensitive || detail.closed) return { events: [], failed: false };
          const type = categoryType(detail.category || activation.category);
          if (!type) return { events: [], failed: false };
          const geometryCandidates = detail.aois?.length
            ? detail.aois.map((aoi, index) => ({ geometry: wktPolygon(aoi.extent), name: aoi.name, index })).filter((candidate): candidate is { geometry: [number, number][][]; name: string | undefined; index: number } => Boolean(candidate.geometry))
            : [{ geometry: wktPolygon(detail.extent), name: undefined, index: -1 }].filter((candidate): candidate is { geometry: [number, number][][]; name: undefined; index: number } => Boolean(candidate.geometry));
          if (geometryCandidates.length === 0) return { events: [], failed: true };
          const updatedAt = iso(detail.lastUpdate || activation.lastUpdate);
          if (Date.parse(updatedAt) > context.now.getTime() + 5 * 60_000) return { events: [], failed: true };
          const endsAt = new Date(Date.parse(updatedAt) + 24 * 60 * 60 * 1000).toISOString();
          const area = (detail.countries || []).map((country) => country.name).filter(Boolean).join(", ") || activation.countries.join(", ");
          const events = geometryCandidates.flatMap((candidate) => {
            const affectedArea = candidate.name ? `${candidate.name}, ${area}`.slice(0, 200) : area;
            const event: NormalizedEvent = {
              id: candidate.index >= 0 ? `cems:${activation.code}:aoi-${candidate.index + 1}` : `cems:${activation.code}`,
              sourceId: "cems", providerId: "cems-rapid-mapping", type, level: "ELEVATED", timing: "ACTIVE",
              headline: `A major emergency is being mapped in ${area}.`,
              explanation: `Copernicus Emergency Management Service has an open ${String(detail.category || activation.category).toLowerCase()} mapping activation for this area.`,
              action: "Check local authority information and avoid the affected area.", affectedArea,
              geometry: { kind: "polygon", coordinates: candidate.geometry }, startsAt: iso(detail.eventTime || activation.eventTime), endsAt,
              sourceUpdatedAt: updatedAt, checkedAt, expiresAt: endsAt, sourceName: "Copernicus EMS",
              sourceUrl: detail.reportLink || `https://rapidmapping.emergency.copernicus.eu/EMSR/${activation.code}`, confidence: "MEDIUM",
            };
            return context.locations.some((location) => eventAffectsLocation(event, location)) ? [NormalizedEventSchema.parse(event)] : [];
          });
          const partial = geometryCandidates.length < (detail.aois?.length || 1);
          return { events, failed: false, partial, removedEventPrefixes: partial
            ? geometryCandidates.map(({ index }) => `cems:${activation.code}:aoi-${index + 1}`)
            : [`cems:${activation.code}`] };
        } catch {
          return { events: [], failed: true };
        }
      });
      const failures = eventGroups.filter((group) => group.failed).length;
      const incomplete = eventGroups.filter((group) => group.partial).length;
      const status = invalid === 0 && failures === 0 && incomplete === 0 && !incompleteList ? "ok" : recent.length > 0 && failures === recent.length ? "failed" : "partial";
      const events = eventGroups.flatMap((group) => group.events);
      recordSourceDiagnostics(context, {
        recordsExamined: list.results.length, targetsScheduled: recent.length, targetsCompleted: eventGroups.length,
        matchedLocations: context.locations.filter((location) => events.some((event) => eventAffectsLocation(event, location))).length,
      });
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt, sourceUpdatedAt: recent.map((item) => iso(item.lastUpdate)).sort().at(-1) || checkedAt,
        events, status,
        removedEventPrefixes: [...removedEventPrefixes, ...eventGroups.flatMap((group) => group.removedEventPrefixes || [])],
        error: [incompleteList ? "CEMS activation list is incomplete" : null, invalid ? `${invalid} activation list records invalid` : null, failures ? `${failures} of ${recent.length} activation details unavailable` : null, incomplete ? `${incomplete} activation geometries incomplete` : null].filter(Boolean).join("; ") || null,
      });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: (error instanceof Error ? error.message : "CEMS failed").slice(0, 300) });
    }
  }
}
