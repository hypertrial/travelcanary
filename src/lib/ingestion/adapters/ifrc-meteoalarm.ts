import type { CountryCode, NormalizedEvent } from "../../domain/schemas";
import { fetchWithRetry } from "../fetch";
import type { IngestionContext } from "../types";
import { parseMeteoAlarmFeed } from "./meteoalarm";

const IFRC_URL = "https://alerthub-api.ifrc.org/graphql/";
const alpha3: Record<CountryCode, string> = { AT: "AUT", BE: "BEL", BG: "BGR", HR: "HRV", CY: "CYP", CZ: "CZE", DK: "DNK", EE: "EST", FI: "FIN", FR: "FRA", DE: "DEU", GR: "GRC", HU: "HUN", IE: "IRL", IT: "ITA", LV: "LVA", LT: "LTU", LU: "LUX", MT: "MLT", NL: "NLD", PL: "POL", PT: "PRT", RO: "ROU", SK: "SVK", SI: "SVN", ES: "ESP", SE: "SWE", CH: "CHE" };
const countryIds: Record<CountryCode, string> = {
  AT: "11", BE: "18", BG: "30", HR: "50", CY: "52", CZ: "53", DK: "56", EE: "65", FI: "71", FR: "72", DE: "76", GR: "78", HU: "90", IE: "96",
  IT: "99", LV: "110", LT: "116", LU: "117", MT: "123", NL: "139", PL: "156", PT: "157", RO: "160", SK: "175", SI: "176", ES: "182", SE: "186", CH: "187",
};
const escapeXml = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type IfrcAlert = {
  sent?: string; url?: string; identifier?: string; scope?: string; status?: string; msgType?: string;
  references?: string;
  country?: { iso3?: string }; feed?: { url?: string; official?: boolean };
  infos?: Array<{ effective?: string; onset?: string; expires?: string; event?: string; severity?: string; headline?: string; areas?: Array<{ areaDesc?: string; geocodes?: Array<{ value?: string }> }> }>;
};

function originatingMeteoAlarm(alert: IfrcAlert) {
  try { const host = new URL(String(alert.feed?.url || "")).hostname; return alert.feed?.official === true && (host === "feeds.meteoalarm.org" || host === "meteoalarm.org" || host === "www.meteoalarm.org"); }
  catch { return false; }
}

export function parseIfrcMeteoAlarm(value: unknown, requested: CountryCode[], now: Date) {
  const publicResult = value && typeof value === "object" ? (value as { data?: { public?: Record<string, unknown> } }).data?.public : null;
  const collections = publicResult && typeof publicResult === "object" ? requested.map((code) => publicResult[code]) : [];
  const items = collections.flatMap((collection) => collection && typeof collection === "object" && Array.isArray((collection as { items?: unknown }).items)
    ? (collection as { items: IfrcAlert[] }).items : []);
  if (!publicResult || !collections.length || collections.some((collection) => !collection || typeof collection !== "object" || !Array.isArray((collection as { items?: unknown }).items))) {
    throw new Error("IFRC Alert Hub response has no alert items");
  }
  if (collections.some((collection) => (collection as { items: unknown[] }).items.length >= 25)) throw new Error("IFRC country result reached its record limit; completeness is unknown");
  const requestedSet = new Set(requested); const byCountry = new Map(requested.map((code) => [code, [] as IfrcAlert[]]));
  const codeByAlpha3 = new Map(requested.map((code) => [alpha3[code], code]));
  for (const raw of items) {
    const alert = raw as IfrcAlert; const code = codeByAlpha3.get(String(alert.country?.iso3 || ""));
    if (!code || !requestedSet.has(code) || !originatingMeteoAlarm(alert) || alert.status !== "ACTUAL" || String(alert.scope).toLowerCase() !== "public") continue;
    byCountry.get(code)!.push(alert);
  }
  const results = new Map<CountryCode, { events: NormalizedEvent[]; supersededIdentifiers: string[] }>();
  for (const [countryCode, alerts] of byCountry) {
    const entries = alerts.flatMap((alert) => (alert.infos?.length ? alert.infos : [{}]).flatMap((info) => (info.areas?.length ? info.areas : [undefined]).map((area) => {
      const geocodes = (area?.geocodes || []).map(({ value }) => `<geocode><value>${escapeXml(value)}</value></geocode>`).join("");
      return `<entry><identifier>${escapeXml(alert.identifier)}</identifier><status>Actual</status><scope>Public</scope><message_type>${escapeXml(alert.msgType || "Alert")}</message_type><references>${escapeXml(alert.references)}</references><sent>${escapeXml(alert.sent)}</sent><updated>${escapeXml(alert.sent)}</updated><effective>${escapeXml(info.effective || alert.sent)}</effective><onset>${escapeXml(info.onset || info.effective || alert.sent)}</onset><expires>${escapeXml(info.expires)}</expires><event>${escapeXml(info.event)}</event><title>${escapeXml(info.headline || info.event)}</title><severity>${escapeXml(String(info.severity || "").toLowerCase())}</severity><areaDesc>${escapeXml(area?.areaDesc || countryCode)}</areaDesc>${geocodes}<link type="application/cap+xml" href="${escapeXml(alert.url || alert.feed?.url)}" /></entry>`;
    })));
    const xml = `<feed><updated>${now.toISOString()}</updated>${entries.join("")}</feed>`;
    const parsed = parseMeteoAlarmFeed(xml, countryCode, now);
    results.set(countryCode, { events: parsed.events, supersededIdentifiers: parsed.supersededIdentifiers });
  }
  return results;
}

export function ifrcFallbackQuery(countries: CountryCode[]) {
  const fields = "sent url identifier scope status msgType references country { iso3 } feed { url official } infos { effective onset expires event severity headline areas { areaDesc geocodes { value } } }";
  const selections = countries.map((countryCode) => `${countryCode}: alerts(filters: { sent: { gte: $since }, country: { pk: \"${countryIds[countryCode]}\" } }, order: { sent: DESC }, pagination: { limit: 25, offset: 0 }) { items { ${fields} } }`);
  return `query TravelCanaryFallback($since: DateTime!) { public { ${selections.join(" ")} } }`;
}

export async function fetchIfrcMeteoAlarmFallback(countries: CountryCode[], context: IngestionContext) {
  if (process.env.IFRC_FALLBACK_ENABLED !== "true" || !countries.length) return null;
  const query = ifrcFallbackQuery(countries);
  const since = new Date(context.now.getTime() - 24 * 60 * 60_000).toISOString();
  const response = await fetchWithRetry(context.fetch, IFRC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { since } }) }, 1, 512 * 1024, undefined, 5_000, "ifrc_fallback");
  return parseIfrcMeteoAlarm(await response.json(), countries, context.now);
}
