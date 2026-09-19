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
const listPath = "/backend/dashboard-api/public-activations-info/";
const listOrigin = "https://rapidmapping.emergency.copernicus.eu";
const pageSize = 100;
const maxPages = 5;
const maxDetails = 100;

function reviewedNext(value: unknown, offset: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("CEMS next-page URL is invalid");
  const url = new URL(value, listOrigin);
  const keys = [...url.searchParams.keys()];
  if (url.origin !== listOrigin || url.username || url.password || url.hash || url.pathname !== listPath
    || keys.length !== 2 || new Set(keys).size !== 2
    || url.searchParams.get("limit") !== String(pageSize) || url.searchParams.get("offset") !== String(offset)) {
    throw new Error("CEMS next-page URL is invalid");
  }
  return url.href;
}

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
      const byteBudget = { remaining: 16 * 1024 * 1024 };
      const rows: unknown[] = [];
      let nextUrl: string | null = `${listOrigin}${listPath}?limit=${pageSize}&offset=0`;
      let advertisedCount: number | null = null;
      let incompleteList = false;
      for (let page = 0; page < maxPages && nextUrl; page += 1) {
        const listResponse = await fetchWithRetry(context.fetch, nextUrl, { redirect: "manual" }, 3, 512 * 1024, byteBudget);
        if (listResponse.status >= 300 && listResponse.status < 400) throw new Error("CEMS list redirect is not permitted");
        const list = await listResponse.json() as { results?: unknown[]; count?: unknown; next?: unknown };
        if (!Array.isArray(list.results)) throw new Error("CEMS response has no results array");
        if (list.results.length > pageSize) incompleteList = true;
        rows.push(...list.results.slice(0, pageSize));
        if (list.count !== undefined) {
          if (typeof list.count !== "number" || !Number.isInteger(list.count) || list.count < 0
            || advertisedCount !== null && advertisedCount !== list.count) incompleteList = true;
          else advertisedCount = list.count;
        }
        try { nextUrl = reviewedNext(list.next, (page + 1) * pageSize); }
        catch { incompleteList = true; nextUrl = null; }
        if (list.results.length < pageSize && nextUrl) incompleteList = true;
        if (!list.results.length && nextUrl) { incompleteList = true; nextUrl = null; }
        if (!nextUrl && advertisedCount !== null && rows.length !== advertisedCount) incompleteList = true;
        if (page === maxPages - 1 && nextUrl) { incompleteList = true; nextUrl = null; }
      }
      if (advertisedCount === null && rows.length >= pageSize) incompleteList = true;
      if (advertisedCount !== null && advertisedCount > maxPages * pageSize) incompleteList = true;
      const parsed = rows.map((item) => activationRecord(item, context.now));
      const invalid = parsed.filter((item) => item === null).length;
      const latest = new Map<string, Activation>();
      for (const item of parsed) if (item) {
        const prior = latest.get(item.code);
        if (!prior || Date.parse(iso(item.lastUpdate)) >= Date.parse(iso(prior.lastUpdate))) latest.set(item.code, item);
      }
      const valid = [...latest.values()].sort((left, right) => left.code.localeCompare(right.code));
      if (rows.length > 0 && valid.length === 0) throw new Error("CEMS response contains no parseable activation records");
      const removedEventPrefixes = valid.filter((item) => item.closed).map((item) => `cems:${item.code}`);
      const recentCandidates = valid.filter((item) => !item.closed && item.countries.some((country) => supportedCountries.has(country))
        && categoryType(item.category) && context.now.getTime() - Date.parse(iso(item.lastUpdate)) < 24 * 60 * 60 * 1000)
        .sort((left, right) => Date.parse(iso(right.lastUpdate)) - Date.parse(iso(left.lastUpdate)) || left.code.localeCompare(right.code));
      const detailsCapped = recentCandidates.length > maxDetails;
      const recent = recentCandidates.slice(0, maxDetails);
      const eventGroups = await mapConcurrent(recent, 5, async (activation): Promise<{ events: NormalizedEvent[]; failed: boolean; partial?: boolean; removedEventPrefixes?: string[] }> => {
        if (Date.now() >= schedulingDeadline) return { events: [], failed: true };
        try {
          const detailResponse = await fetchWithRetry(context.fetch, `${listOrigin}/backend/dashboard-api/public-activations/?code=${encodeURIComponent(activation.code)}`,
            { redirect: "manual" }, 2, 1024 * 1024, byteBudget);
          if (detailResponse.status >= 300 && detailResponse.status < 400) throw new Error("CEMS detail redirect is not permitted");
          const detailPayload = await detailResponse.json() as { results?: ActivationDetail[] };
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
      const status = invalid === 0 && failures === 0 && incomplete === 0 && !incompleteList && !detailsCapped
        ? "ok" : recent.length > 0 && failures === recent.length && !incompleteList && !detailsCapped ? "failed" : "partial";
      const events = eventGroups.flatMap((group) => group.events);
      recordSourceDiagnostics(context, {
        recordsExamined: rows.length, targetsScheduled: recent.length, targetsCompleted: eventGroups.length,
        matchedLocations: context.locations.filter((location) => events.some((event) => eventAffectsLocation(event, location))).length,
      });
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt, sourceUpdatedAt: valid.map((item) => iso(item.lastUpdate)).sort().at(-1) || checkedAt,
        events, status,
        removedEventPrefixes: [...removedEventPrefixes, ...eventGroups.flatMap((group) => group.removedEventPrefixes || [])],
        error: [incompleteList ? "CEMS activation list is incomplete" : null, detailsCapped ? "CEMS activation detail limit reached" : null,
          invalid ? `${invalid} activation list records invalid` : null, failures ? `${failures} of ${recent.length} activation details unavailable` : null,
          incomplete ? `${incomplete} activation geometries incomplete` : null].filter(Boolean).join("; ") || null,
      });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: (error instanceof Error ? error.message : "CEMS failed").slice(0, 300) });
    }
  }
}
