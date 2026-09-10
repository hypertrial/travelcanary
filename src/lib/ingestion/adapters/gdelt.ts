import { createHash } from "node:crypto";
import publishersJson from "../../../../data/gdelt-publishers.json";
import { AggregateSourceResultSchema, type AggregateSourceResult, type DiscoveryCandidate, type HazardType, type NormalizedEvent } from "../../domain/schemas";
import { distanceKm } from "../../geospatial";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const buckets = [
  { type: "civil-unrest", query: "(protest OR riot OR unrest)" },
  { type: "security", query: "(security incident OR shooting OR explosion)" },
  { type: "terrorism", query: "(terror attack OR terrorism)" },
  { type: "armed-conflict", query: "(armed conflict OR airstrike OR shelling)" },
] as const satisfies ReadonlyArray<{ type: HazardType; query: string }>;
const queryShards = [buckets.slice(0, 2), buckets.slice(2)] as const;
const combinedQuery = `(${buckets.map(({ query }) => query).join(" OR ")})`;
const BYTE_BUDGET = 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
const publishers = new Map(publishersJson.publishers.map((publisher) => [publisher.domain, publisher]));
const excluded = /\b(historical|anniversary|hypothetical|could happen|may happen|planned|scheduled|drill|exercise|routine|resolved|ended|cancelled|canceled|denied|false report|hoax)\b/i;
const normalize = (value: unknown) => String(value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function canonicalArticleUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    url.hash = "";
    [...url.searchParams.keys()].filter((key) => /^(?:utm_.+|fbclid|gclid)$/i.test(key)).forEach((key) => url.searchParams.delete(key));
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

function reviewedPublisher(url: string) {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  return publishersJson.publishers.find(({ domain }) => host === domain || host.endsWith(`.${domain}`));
}

function articles(properties: Record<string, unknown>) {
  const directUrl = canonicalArticleUrl(properties.url || properties.articleUrl);
  if (directUrl && properties.title) return [{
    url: directUrl, title: String(properties.title), description: String(properties.description || properties.snippet || ""),
    published: Date.parse(String(properties.publishedAt || properties.seendate || properties.date || "")),
  }];
  // PointData HTML links have no article publication time; retrieval time cannot establish freshness.
  return [];
}

function classifyHazard(value: string): HazardType | null {
  const normalized = normalize(value);
  if (/\b(?:protest|riot|unrest)\b/.test(normalized)) return "civil-unrest";
  if (/\b(?:terror attack|terrorism|terrorist)\b/.test(normalized)) return "terrorism";
  if (/\b(?:armed conflict|airstrike|shelling)\b/.test(normalized)) return "armed-conflict";
  if (/\b(?:security incident|shooting|explosion)\b/.test(normalized)) return "security";
  return null;
}

export function parseGdeltGeo(value: unknown, type: HazardType, now: Date): DiscoveryCandidate[];
export function parseGdeltGeo(value: unknown, now: Date): DiscoveryCandidate[];
export function parseGdeltGeo(value: unknown, typeOrNow: HazardType | Date, maybeNow?: Date): DiscoveryCandidate[] {
  const explicitType = typeOrNow instanceof Date ? null : typeOrNow;
  const now = typeOrNow instanceof Date ? typeOrNow : maybeNow!;
  const features = value && typeof value === "object" ? (value as { features?: unknown }).features : null;
  if (!Array.isArray(features)) throw new Error("GDELT response is not GeoJSON");
  return features.flatMap((feature) => {
    if (!feature || typeof feature !== "object") return [];
    const raw = feature as { geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> };
    if (raw.geometry?.type !== "Point" || !Array.isArray(raw.geometry.coordinates)) return [];
    const coordinates = raw.geometry.coordinates.slice(0, 2).map(Number) as [number, number];
    if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return [];
    const properties = raw.properties || {};
    return articles(properties).flatMap(({ url, title, description, published }) => {
      const type = explicitType || classifyHazard(`${title} ${description}`);
      const publisher = reviewedPublisher(url);
      if (!type || !publisher || excluded.test(`${title} ${description}`) || !Number.isFinite(published)
        || published > now.getTime() + 5 * 60_000 || now.getTime() - published > 6 * 60 * 60_000) return [];
      const titleFingerprint = createHash("sha256").update(normalize(title)).digest("hex");
      const descriptionFingerprint = description ? createHash("sha256").update(normalize(description)).digest("hex") : undefined;
      const fingerprint = createHash("sha256").update(`${titleFingerprint}:${descriptionFingerprint || ""}`).digest("hex");
      const expires = published + 6 * 60 * 60_000;
      return [{ providerId: "gdelt" as const, externalId: createHash("sha256").update(`${type}:${url}`).digest("hex").slice(0, 32), hazardType: type,
        geometry: { type: "Point" as const, coordinates }, startsAt: new Date(published).toISOString(), endsAt: new Date(expires).toISOString(),
        sourceUpdatedAt: new Date(published).toISOString(), officialUrl: url, expiresAt: new Date(expires).toISOString(),
        publisherDomain: publisher.domain, ownershipGroup: publisher.parentGroup, contentFingerprint: fingerprint, titleFingerprint, descriptionFingerprint,
        publishedAt: new Date(published).toISOString(), canonicalUrl: url }];
    });
  });
}

export function corroboratedGdeltEvents(candidates: DiscoveryCandidate[], context: IngestionContext): NormalizedEvent[] {
  const current = candidates.filter((candidate) => candidate.providerId === "gdelt" && candidate.publisherDomain && candidate.ownershipGroup && candidate.contentFingerprint && candidate.publishedAt
    && publishers.has(candidate.publisherDomain) && Date.parse(candidate.expiresAt) > context.now.getTime());
  const events: NormalizedEvent[] = [];
  for (const location of context.locations) for (const type of buckets.map(({ type }) => type)) {
    const nearby = current.filter((candidate) => candidate.hazardType === type && candidate.geometry.type === "Point" && distanceKm(candidate.geometry.coordinates, location.centroid) <= 25)
      .sort((a, b) => a.externalId.localeCompare(b.externalId));
    for (const anchor of nearby) {
      const anchorTime = Date.parse(anchor.publishedAt!);
      const window = nearby.filter((candidate) => Math.abs(Date.parse(candidate.publishedAt!) - anchorTime) <= 2 * 60 * 60_000);
      const byFingerprint = new Map<string, DiscoveryCandidate>();
      const seenUrls = new Set<string>(); const seenTitles = new Set<string>(); const seenDescriptions = new Set<string>();
      for (const candidate of window) {
        const url = candidate.canonicalUrl || candidate.officialUrl;
        if (seenUrls.has(url) || (candidate.titleFingerprint && seenTitles.has(candidate.titleFingerprint))
          || (candidate.descriptionFingerprint && seenDescriptions.has(candidate.descriptionFingerprint))) continue;
        seenUrls.add(url); if (candidate.titleFingerprint) seenTitles.add(candidate.titleFingerprint);
        if (candidate.descriptionFingerprint) seenDescriptions.add(candidate.descriptionFingerprint);
        byFingerprint.set(candidate.contentFingerprint!, candidate);
      }
      const unique = [...byFingerprint.values()].sort((a, b) => a.externalId.localeCompare(b.externalId));
      let group: DiscoveryCandidate[] = [];
      for (const seed of unique) {
        const selected = [seed]; const ownershipGroups = new Set([seed.ownershipGroup]);
        for (const candidate of unique) {
          if (ownershipGroups.has(candidate.ownershipGroup) || selected.some((current) => current.geometry.type !== "Point" || candidate.geometry.type !== "Point"
            || distanceKm(current.geometry.coordinates, candidate.geometry.coordinates) > 25
            || Math.abs(Date.parse(current.publishedAt!) - Date.parse(candidate.publishedAt!)) > 2 * 60 * 60_000)) continue;
          selected.push(candidate); ownershipGroups.add(candidate.ownershipGroup);
        }
        if (selected.length > group.length || (selected.length === group.length && selected.map(({ externalId }) => externalId).join("|") < group.map(({ externalId }) => externalId).join("|"))) group = selected;
      }
      if (group.length < 3) continue;
      const publisherDomains = new Set(group.map(({ publisherDomain }) => publisherDomain));
      for (const candidate of unique) {
        if (publisherDomains.has(candidate.publisherDomain) || group.includes(candidate)
          || group.some((current) => current.geometry.type !== "Point" || candidate.geometry.type !== "Point"
            || distanceKm(current.geometry.coordinates, candidate.geometry.coordinates) > 25
            || Math.abs(Date.parse(current.publishedAt!) - Date.parse(candidate.publishedAt!)) > 2 * 60 * 60_000)) continue;
        group.push(candidate); publisherDomains.add(candidate.publisherDomain);
      }
      group.sort((a, b) => a.ownershipGroup!.localeCompare(b.ownershipGroup!) || a.externalId.localeCompare(b.externalId));
      const start = Math.min(...group.map((candidate) => Date.parse(candidate.publishedAt!)));
      const end = new Date(start + 6 * 60 * 60_000).toISOString();
      const label = type === "civil-unrest" ? "civil unrest" : type === "armed-conflict" ? "armed conflict" : "a security incident";
      if (events.length + group.length > 200) return events;
      for (const candidate of group) {
        const publisher = publishers.get(candidate.publisherDomain!)!;
        events.push({ id: `gdelt:${type}:${location.id}:${candidate.externalId}`, sourceId: "gdelt", providerId: "gdelt", type, level: "ELEVATED", timing: "ACTIVE",
          headline: `Multiple independent reports indicate ${label} near ${location.name}.`, explanation: `At least three reviewed, independently owned publishers report ${label} within 25 km and two hours of one another.`,
          action: "Check official local information, avoid the affected area, and allow extra time for travel.", affectedArea: location.name, geometry: { kind: "locations", ids: [location.id] },
          startsAt: new Date(start).toISOString(), endsAt: end, sourceUpdatedAt: candidate.sourceUpdatedAt, checkedAt: context.now.toISOString(), expiresAt: end,
          sourceName: publisher.sourceName, sourceUrl: candidate.canonicalUrl!, confidence: "MEDIUM" });
      }
      break;
    }
  }
  return events;
}

export class GdeltAdapter implements SourceAdapter {
  readonly id = "gdelt" as const; readonly cadence = "slow" as const;
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    if (process.env.GDELT_ENABLED !== "true") return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], candidates: [], status: "disabled", error: null, limitationCode: "environment_disabled" });
    const byteBudget = { remaining: BYTE_BUDGET };
    const request = async (query: string, maxBytes: number, label: string) => {
      const params = new URLSearchParams({ query, mode: "PointData", format: "GeoJSON", maxpoints: "200", timespan: "2h", geores: "2", sortby: "date" });
      const response = await fetchWithRetry(context.fetch, `https://api.gdeltproject.org/api/v2/geo/geo?${params}`, {}, 1, maxBytes, byteBudget, 4_000, label);
      const text = await response.text();
      return parseGdeltGeo(JSON.parse(text), context.now);
    };
    let candidatesFromFetch: DiscoveryCandidate[] = [];
    let status: "ok" | "partial" | "failed" = "ok";
    let error: string | null = null;
    try {
      candidatesFromFetch = await request(combinedQuery, RESPONSE_LIMIT, "gdelt_combined");
    } catch (combinedError) {
      // An oversized body can arrive in one already-buffered chunk. Fail closed
      // without further transfer rather than spending the budget again on shards.
      if (combinedError instanceof Error && /response exceeds/.test(combinedError.message)) byteBudget.remaining = 0;
      const remaining = Math.max(0, byteBudget.remaining);
      const shardLimit = Math.min(RESPONSE_LIMIT, Math.floor(remaining / queryShards.length));
      const settled = await Promise.allSettled(queryShards.map((shard, index) => request(
        `(${shard.map(({ query }) => query).join(" OR ")})`, shardLimit, `gdelt_shard_${index + 1}`,
      )));
      const successful = settled.filter((item): item is PromiseFulfilledResult<DiscoveryCandidate[]> => item.status === "fulfilled");
      candidatesFromFetch = successful.flatMap(({ value }) => value);
      status = successful.length === 0 ? "failed" : successful.length === queryShards.length ? "ok" : "partial";
      error = status === "failed"
        ? remaining < 1 ? "GDELT response-byte limit reached; fallback shards not requested" : "Combined GDELT request and both fallback shards failed"
        : status === "partial" ? "Combined GDELT request failed and one fallback shard succeeded" : null;
    }
    const byArticle = new Map<string, DiscoveryCandidate>();
    for (const candidate of candidatesFromFetch) {
      const key = candidate.canonicalUrl || candidate.officialUrl;
      if (!byArticle.has(key)) byArticle.set(key, candidate);
    }
    const candidates = [...byArticle.values()].slice(0, 200);
    const retained = (context.state?.candidates || []).filter((candidate) => candidate.providerId === "gdelt" && Date.parse(candidate.expiresAt) > context.now.getTime());
    const events = corroboratedGdeltEvents([...retained, ...candidates], context);
    recordSourceDiagnostics(context, { recordsExamined: candidates.length, matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size, ...(candidates.length === 200 ? { overflowCode: "gdelt_candidate_limit" } : {}) });
    return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: candidates.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || checkedAt,
      events, candidates, status, error });
  }
}
