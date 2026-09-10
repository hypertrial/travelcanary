import { writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { mapConcurrent } from "../src/lib/ingestion/fetch";

const datasetUrl = "https://data.public.lu/api/1/datasets/alertes-du-systeme-lu-alert/";
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const generatedAt = new Date();

type Resource = { url?: string; last_modified?: string; format?: string };
type Metadata = { resources?: Resource[] };
type CapRecord = { identifier: string; sent: number; msgType: string; references: string[]; active: boolean; xml: string };

function values<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

async function fetchXml(resource: Resource): Promise<CapRecord | null> {
  if (!resource.url || new URL(resource.url).hostname !== "download.data.public.lu") return null;
  const response = await fetch(resource.url);
  if (!response.ok) throw new Error(`CAP-LU resource returned ${response.status}`);
  const xml = await response.text();
  if (new TextEncoder().encode(xml).byteLength > 2 * 1024 * 1024) throw new Error("CAP-LU history resource exceeds 2 MB");
  const alert = (parser.parse(xml) as { alert?: Record<string, unknown> }).alert;
  if (!alert) return null;
  const identifier = String(alert.identifier || "").trim();
  const sent = Date.parse(String(alert.sent || ""));
  const msgType = String(alert.msgType || "").trim().toLowerCase();
  const references = String(alert.references || "").trim().split(/\s+/).map((item) => item.split(",")[1]).filter(Boolean);
  const active = String(alert.status).toLowerCase() === "actual" && String(alert.scope).toLowerCase() === "public"
    && values(alert.info as Record<string, unknown> | Record<string, unknown>[]).some((info) => Date.parse(String(info.expires || "")) > generatedAt.getTime());
  return identifier && Number.isFinite(sent)
    ? { identifier, sent, msgType, references, active, xml: xml.replace(/>\s+</g, "><").trim() }
    : null;
}

const metadataResponse = await fetch(datasetUrl, { headers: { "X-Fields": "{resources{url,last_modified,format}}" } });
if (!metadataResponse.ok) throw new Error(`CAP-LU metadata returned ${metadataResponse.status}`);
const metadata = await metadataResponse.json() as Metadata;
const resources = (metadata.resources || []).filter((resource) => resource.format?.toLowerCase() === "xml")
  .sort((a, b) => Date.parse(a.last_modified || "") - Date.parse(b.last_modified || "") || String(a.url).localeCompare(String(b.url)));
const records = (await mapConcurrent(resources, 6, fetchXml)).filter((record): record is CapRecord => Boolean(record))
  .sort((a, b) => a.sent - b.sent || a.identifier.localeCompare(b.identifier));
const active = new Map<string, CapRecord>();
for (const record of records) {
  for (const identifier of record.references) active.delete(identifier);
  if (["cancel", "pause"].includes(record.msgType) || !record.active) continue;
  active.set(record.identifier, record);
}
const watermark = resources.map((resource) => resource.last_modified).filter(Boolean).sort().at(-1) || generatedAt.toISOString();
await writeFile("data/lu-alert-bootstrap.json", `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: generatedAt.toISOString(),
  processedResourceWatermark: new Date(watermark).toISOString(),
  alerts: [...active.values()].sort((a, b) => a.identifier.localeCompare(b.identifier)).map(({ xml }) => xml),
}, null, 2)}\n`);
console.log(`Generated CAP-LU bootstrap with ${active.size} active alerts from ${records.length} records.`);
