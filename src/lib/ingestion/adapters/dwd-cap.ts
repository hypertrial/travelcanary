import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { HazardLevel, HazardType, NormalizedEvent } from "../../domain/schemas";
import { fetchAllowlisted } from "../fetch";
import { readCapZipArchive } from "../cap-archive";
import { eventCopy } from "../templates";
import type { IngestionContext } from "../types";
import { capPolygon, matchingLocations, overlapsNextDay } from "./national-civil-alerts-shared";

type Row = Record<string, unknown>;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value).trim()
  : value && typeof value === "object" && "#text" in value ? text((value as Row)["#text"]) : "";
const array = (value: unknown) => value === undefined ? [] : (Array.isArray(value) ? value : [value]) as Row[];
const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const levels: Record<string, HazardLevel> = { moderate: "ELEVATED", minor: "ELEVATED", severe: "HIGH", extreme: "SEVERE" };
const hazards: Array<[RegExp, HazardType]> = [
  [/heat|hot/, "extreme-heat"], [/frost|cold/, "extreme-cold"], [/snow|ice|freez/, "snow-ice"],
  [/coast|storm surge|sea/, "coastal"], [/flood/, "flood"], [/forest fire|wildfire/, "fire-danger"],
  [/wind|storm|rain|thunder|fog|hail|weather/, "severe-weather"],
];
const timestamp = (value: unknown) => {
  const raw = text(value); if (!/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) throw new Error("DWD CAP timestamp has no offset");
  const parsed = Date.parse(raw); if (!Number.isFinite(parsed)) throw new Error("DWD CAP timestamp is invalid"); return parsed;
};

export function parseDwdCap(xml: string, context: IngestionContext) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid DWD CAP XML");
  const alert = (parser.parse(xml) as { alert?: Row }).alert;
  if (!alert || Array.isArray(alert)) throw new Error("DWD CAP document has no alert");
  if (text(alert.status) !== "Actual" || text(alert.scope) !== "Public") return [];
  const identifier = text(alert.identifier); const sent = timestamp(alert.sent);
  if (!identifier || sent > context.now.getTime() + 300_000) throw new Error("DWD CAP identity is invalid");
  if (text(alert.msgType) === "Cancel") return [];
  if (!["Alert", "Update"].includes(text(alert.msgType))) throw new Error("DWD CAP lifecycle is unsupported");
  const events: NormalizedEvent[] = [];
  for (const info of array(alert.info)) {
    if (text(info.category) !== "Met") continue;
    const severity = levels[normalize(text(info.severity))];
    if (!severity) throw new Error("DWD CAP severity is unsupported");
    const starts = timestamp(info.onset || info.effective); const ends = timestamp(info.expires);
    if (!overlapsNextDay(starts, ends, context.now)) continue;
    const officialEvent = normalize(text(info.event));
    const hazard = hazards.find(([pattern]) => pattern.test(officialEvent))?.[1];
    if (!hazard) throw new Error(`Unreviewed DWD CAP event: ${officialEvent}`);
    for (const area of array(info.area)) {
      const polygons = (Array.isArray(area.polygon) ? area.polygon : [area.polygon]).filter(Boolean).map(capPolygon);
      if (!polygons.length) throw new Error("DWD CAP warning has no polygon");
      const ids = matchingLocations(polygons, context.locations.filter(({ countryCode }) => countryCode === "DE")).map(({ id }) => id);
      if (!ids.length) continue;
      const areaName = text(area.areaDesc) || "German warning area";
      const copy = eventCopy(hazard, severity, areaName, starts > context.now.getTime());
      const areaHash = createHash("sha256").update(`${identifier}|${officialEvent}|${ids.sort().join(",")}`).digest("hex").slice(0, 20);
      events.push({ id: `meteoalarm:dwd:${identifier}:${areaHash}`, sourceId: "meteoalarm", providerId: "meteoalarm", transportId: "dwd-cap",
        type: hazard, level: severity, timing: starts > context.now.getTime() ? "UPCOMING" : "ACTIVE", ...copy, affectedArea: areaName.slice(0, 200),
        geometry: { kind: "locations", ids }, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(),
        sourceUpdatedAt: new Date(sent).toISOString(), checkedAt: context.now.toISOString(), expiresAt: new Date(ends).toISOString(),
        sourceName: "DWD", sourceUrl: "https://www.dwd.de/EN/weather/warnings/warnings_node.html", confidence: "HIGH" });
    }
  }
  return events;
}

export async function fetchDwdCaps(context: IngestionContext) {
  const response = await fetchAllowlisted(context.fetch,
    "https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_EVENT_STAT/Z_CAP_C_EDZW_LATEST_PVW_STATUS_PREMIUMEVENT_COMMUNEUNION_EN.zip",
    ["opendata.dwd.de"], 2, { maxBytes: 1024 * 1024, timeoutMs: 5_000, diagnosticsCategory: "dwd_cap" });
  const lastModified = response.headers.get("last-modified");
  if (!lastModified) throw new Error("DWD CAP archive has no Last-Modified timestamp");
  const updated = Date.parse(lastModified);
  if (!Number.isFinite(updated) || updated > context.now.getTime() + 300_000 || context.now.getTime() - updated > 30 * 60_000) throw new Error("DWD CAP archive timestamp is stale or future");
  const files = readCapZipArchive(new Uint8Array(await response.arrayBuffer()));
  const events = files.flatMap(({ xml }) => parseDwdCap(xml, context));
  if (events.length > 500) throw new Error("DWD CAP event limit exceeded");
  return { events, removedEventPrefixes: ["meteoalarm:dwd:"], sourceUpdatedAt: new Date(updated).toISOString(), transportId: "dwd-cap" };
}
