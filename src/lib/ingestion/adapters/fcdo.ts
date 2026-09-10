import { z } from "zod";
import type { CatalogLocation } from "../../catalog-data";
import { ExpandedAggregateSourceResultSchema as AggregateSourceResultSchema } from "../../domain/catalog-state";
import { type AggregateSourceResult, type NormalizedEvent } from "../../domain/schemas";
import { contextFeedsEnabled } from "../context-feeds";
import { fetchAllowlisted } from "../fetch";
import { recordSourceDiagnostics, type ExpandedIngestionContext as IngestionContext, type ExpandedSourceAdapter } from "../types";

const host = "www.gov.uk";
export const fcdoSlugs = {
  AT: "austria", BE: "belgium", BG: "bulgaria", HR: "croatia", CY: "cyprus", CZ: "czechia", DK: "denmark", EE: "estonia", FI: "finland", FR: "france", DE: "germany", GR: "greece", HU: "hungary", IE: "ireland", IT: "italy", LV: "latvia", LT: "lithuania", LU: "luxembourg", MT: "malta", NL: "netherlands", PL: "poland", PT: "portugal", RO: "romania", SK: "slovakia", SI: "slovenia", ES: "spain", SE: "sweden", CH: "switzerland",
  AL: "albania", AD: "andorra", BY: "belarus", BA: "bosnia-and-herzegovina", IS: "iceland", XK: "kosovo", LI: "liechtenstein", MD: "moldova", MC: "monaco", ME: "montenegro", MK: "north-macedonia", NO: "norway", SM: "san-marino", RS: "serbia", TR: "turkey",
} as const;
type CountryCode = keyof typeof fcdoSlugs;
function supportedCountry(value: string): value is CountryCode { return Object.hasOwn(fcdoSlugs, value); }

const wholeCountryStatuses = new Set(["avoid_all_travel_to_whole_country", "avoid_all_but_essential_travel_to_whole_country"]);

const FcdoPageSchema = z.object({ title: z.string().min(1).max(200), updated_at: z.string().datetime({ offset: true }),
  base_path: z.string().optional(), details: z.object({ alert_status: z.array(z.string().min(1).max(100)).max(20) }) });

export function fcdoEvent(value: unknown, countryCode: CatalogLocation["countryCode"], context: IngestionContext): NormalizedEvent | null {
  if (!supportedCountry(countryCode)) return null;
  const page = FcdoPageSchema.parse(value);
  if (page.base_path !== undefined && page.base_path !== `/foreign-travel-advice/${fcdoSlugs[countryCode]}`) throw new Error("FCDO page country mismatch");
  const statuses = page.details.alert_status;
  const updated = Date.parse(page.updated_at);
  if (updated > context.now.getTime() + 5 * 60_000) throw new Error(`FCDO ${countryCode} has an invalid update time`);
  if (!statuses.some((status) => wholeCountryStatuses.has(status))) return null;
  const locationIds = context.locations.filter((location) => location.countryCode === countryCode).map(({ id }) => id).sort();
  if (!locationIds.length) return null;
  const checkedAt = context.now.toISOString();
  const expiresAt = new Date(context.now.getTime() + 2 * 60 * 60_000).toISOString();
  const avoidAll = statuses.includes("avoid_all_travel_to_whole_country");
  return {
    id: `fcdo:${countryCode}`, sourceId: "fcdo-travel-advice", providerId: "fcdo-travel-advice", type: "security", level: "ELEVATED", timing: "ACTIVE",
    headline: `FCDO advises against ${avoidAll ? "all" : "all but essential"} travel to ${String(page.title || countryCode).replace(/ travel advice$/i, "")}.`,
    explanation: "This whole-country travel advice is context only and does not replace local emergency warnings.",
    action: "Read the current travel advice and follow instructions from local authorities.", affectedArea: `All catalog destinations in ${countryCode}`,
    geometry: { kind: "locations", ids: locationIds }, startsAt: checkedAt, endsAt: expiresAt,
    sourceUpdatedAt: new Date(updated).toISOString(), checkedAt, expiresAt, sourceName: "GOV.UK foreign travel advice",
    sourceUrl: `https://www.gov.uk/foreign-travel-advice/${fcdoSlugs[countryCode]}`, confidence: "MEDIUM",
  };
}

export class FcdoTravelAdviceAdapter implements ExpandedSourceAdapter {
  readonly catalogVersion = 3 as const;
  readonly id = "fcdo-travel-advice" as const;
  readonly cadence = "slow" as const;
  constructor(private readonly enabled = contextFeedsEnabled()) {}
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    if (!this.enabled) return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "disabled", limitationCode: "context_feeds_disabled", error: null });
    const results: Array<{ countryCode: CountryCode; value: unknown; error: string | null }> = [];
    const countries = [...new Set(context.locations.map(({ countryCode }) => countryCode))].filter(supportedCountry);
    const targets = countries.map((countryCode) => ({ countryCode, slug: fcdoSlugs[countryCode] }));
    if (!targets.length) return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "disabled", limitationCode: "no_supported_country", error: null });
    for (let offset = 0; offset < targets.length; offset += 3) {
      results.push(...await Promise.all(targets.slice(offset, offset + 3).map(async ({ countryCode, slug }) => {
        try {
          const response = await fetchAllowlisted(context.fetch, `https://${host}/api/content/foreign-travel-advice/${slug}`, [host], 2, { maxBytes: 350_000, diagnosticsCategory: `fcdo_${countryCode}` });
          return { countryCode, value: await response.json(), error: null };
        } catch (error) { return { countryCode, value: null, error: String(error) }; }
      })));
      if (offset + 3 < targets.length) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    const events: NormalizedEvent[] = [];
    const failed: CountryCode[] = [];
    let malformed = 0;
    for (const result of results) {
      if (result.error) { failed.push(result.countryCode); continue; }
      try { const event = fcdoEvent(result.value, result.countryCode, context); if (event) events.push(event); } catch { malformed += 1; failed.push(result.countryCode); }
    }
    recordSourceDiagnostics(context, { targetsScheduled: targets.length, targetsCompleted: targets.length - failed.length, recordsExamined: results.length, matchedLocations: events.reduce((count, event) => count + (event.geometry.kind === "locations" ? event.geometry.ids.length : 0), 0) });
    const checkedLocationIds = context.locations.filter((location) => supportedCountry(location.countryCode) && !failed.includes(location.countryCode)).map(({ id }) => id);
    const unavailableLocationIds = context.locations.filter((location) => supportedCountry(location.countryCode) && failed.includes(location.countryCode)).map(({ id }) => id);
    const status = failed.length === targets.length ? "failed" : failed.length ? "partial" : "ok";
    return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: events.map(({ sourceUpdatedAt }) => sourceUpdatedAt).sort().at(-1) || checkedAt, events: events.sort((a, b) => a.id.localeCompare(b.id)), status, error: failed.length ? `${failed.length} FCDO country pages failed${malformed ? ` (${malformed} malformed)` : ""}` : null, checkedLocationIds, unavailableLocationIds, removedEventPrefixes: ["fcdo:"] });
  }
}
