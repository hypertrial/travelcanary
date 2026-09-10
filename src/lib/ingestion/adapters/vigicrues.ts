import { XMLParser } from "fast-xml-parser";
import mapping from "../../../../data/vigicrues-section-mapping.json";
import { AggregateSourceResultSchema, type AggregateSourceResult, type HazardLevel, type NormalizedEvent } from "../../domain/schemas";
import { fetchWithRetry } from "../fetch";
import { recordSourceDiagnostics, type IngestionContext, type SourceAdapter } from "../types";

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
const severity = { jaune: 1, orange: 2, rouge: 3 } as const;
const levelBySeverity: Record<number, HazardLevel> = { 1: "ELEVATED", 2: "HIGH", 3: "SEVERE" };
type FeedItem = { title?: string; link?: string; description?: string; pubDate?: string };

function items(value: unknown): FeedItem[] {
  const channel = (value as { rss?: { channel?: { item?: FeedItem | FeedItem[] } } })?.rss?.channel;
  if (!channel || typeof channel !== "object") throw new Error("Vigicrues response has no RSS channel");
  const item = channel.item;
  return item ? (Array.isArray(item) ? item : [item]) : [];
}

export function vigicruesEvents(value: unknown, context: IngestionContext) {
  const feedItems = items(value);
  const byCode = new Map<string, { score: number; label: string; updatedAt: string }>();
  const unavailable = new Set<string>();
  let parseable = 0;
  let invalid = 0;
  for (const item of feedItems.slice().sort((a, b) => String(a.link).localeCompare(String(b.link)))) {
    const title = String(item.title || "").trim();
    const timestamp = Date.parse(String(item.pubDate || ""));
    if (/^pas de vigilance particulière requise$/i.test(title) && Number.isFinite(timestamp)) {
      parseable += 1;
      continue;
    }
    const code = String(item.link || item.description || "").match(/#([A-Z]{2}\d+)/)?.[1]
      || String(item.description || "").match(/\(([A-Z]{2}\d+)\)/)?.[1];
    const match = title.match(/^(.+?)\s*:\s*(jaune|orange|rouge)$/i);
    if (!code || !match || !Number.isFinite(timestamp)) {
      invalid += 1;
      const affected = code ? mapping.mappings.filter(({ sectionCodes }) => sectionCodes.includes(code)) : mapping.mappings;
      affected.forEach(({ locationId }) => unavailable.add(locationId));
      continue;
    }
    parseable += 1;
    const score = severity[match[2].toLowerCase() as keyof typeof severity];
    const candidate = { score, label: match[1].trim(), updatedAt: new Date(timestamp).toISOString() };
    const previous = byCode.get(code);
    if (!previous || candidate.score > previous.score || (candidate.score === previous.score && candidate.updatedAt > previous.updatedAt)) byCode.set(code, candidate);
  }
  const expiresAt = new Date(context.now.getTime() + 30 * 60_000).toISOString();
  const events: NormalizedEvent[] = [];
  for (const destination of [...mapping.mappings].sort((a, b) => a.locationId.localeCompare(b.locationId))) {
    const warnings = destination.sectionCodes.flatMap((code) => byCode.has(code) ? [{ code, ...byCode.get(code)! }] : []);
    const warning = warnings.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.code.localeCompare(b.code))[0];
    if (!warning) continue;
    const location = context.locations.find((candidate) => candidate.id === destination.locationId);
    if (!location) continue;
    events.push({
      id: `vigicrues:${warning.code}:${location.id}`, sourceId: "vigicrues", providerId: "vigicrues", type: "flood",
      level: levelBySeverity[warning.score], timing: "ACTIVE",
      headline: `${warning.label} has a ${warning.score === 1 ? "yellow" : warning.score === 2 ? "orange" : "red"} flood warning.`,
      explanation: `Vigicrues reports an official flood vigilance level for a river section intersecting ${location.name}.`,
      action: warning.score >= 2 ? "Avoid affected riverbanks and follow local authority instructions." : "Monitor official updates and use caution near rivers.",
      affectedArea: `${location.name} and the ${warning.label} river section`, geometry: { kind: "locations", ids: [location.id] },
      startsAt: warning.updatedAt, endsAt: expiresAt, sourceUpdatedAt: warning.updatedAt, checkedAt: context.now.toISOString(), expiresAt,
      sourceName: "Vigicrues", sourceUrl: "https://www.vigicrues.gouv.fr/territoire/rss", confidence: "HIGH",
    });
  }
  return { feedItems, parseable, invalid, events, unavailableLocationIds: [...unavailable].sort() };
}

export class VigicruesAdapter implements SourceAdapter {
  readonly id = "vigicrues" as const;
  readonly cadence = "fast" as const;

  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const checkedLocationIds = mapping.mappings.map(({ locationId }) => locationId).sort();
    try {
      const response = await fetchWithRetry(context.fetch, "https://www.vigicrues.gouv.fr/territoire/rss", {}, 3, 128 * 1024);
      const parsed = vigicruesEvents(parser.parse(await response.text()), context);
      if (parsed.feedItems.length > 0 && parsed.parseable === 0) throw new Error("Vigicrues feed contains no parseable warning records");
      const unavailable = new Set(parsed.unavailableLocationIds);
      const events = parsed.events.filter((event) => event.geometry.kind !== "locations"
        || event.geometry.ids.every((id) => !unavailable.has(id)));
      recordSourceDiagnostics(context, {
        recordsExamined: parsed.feedItems.length, targetsScheduled: checkedLocationIds.length,
        targetsCompleted: checkedLocationIds.length - unavailable.size,
        matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size,
      });
      return AggregateSourceResultSchema.parse({
        sourceId: this.id, checkedAt,
        sourceUpdatedAt: parsed.events.map((event) => event.sourceUpdatedAt).sort().at(-1) || checkedAt,
        events, status: parsed.invalid ? "partial" : "ok",
        error: parsed.invalid ? `${parsed.invalid} Vigicrues records were invalid` : null,
        checkedLocationIds: checkedLocationIds.filter((id) => !unavailable.has(id)), unavailableLocationIds: parsed.unavailableLocationIds,
      });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) });
    }
  }
}
