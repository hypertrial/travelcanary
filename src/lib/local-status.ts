import { z } from "zod";
import catalog from "../../public/catalogs/3/locations.json";
import packageJson from "../../package.json";
import { SnapshotV11Schema } from "./domain/catalog-public";
import { COLLECTOR_STATUS_KEY, LocalDatabase } from "./local-storage";
import { restrictedSourceCount } from "./local-policy";
import { readCurrentPublication, readPublishedObject, type PublicationStore } from "./publication-store";

export const CollectorStatusSchema = z.object({
  schemaVersion: z.literal(1), state: z.enum(["starting", "running", "idle", "failed", "stopping"]),
  lastHeartbeat: z.string().datetime({ offset: true }), lastSuccess: z.string().datetime({ offset: true }).nullable(),
  lastOperation: z.enum(["fast", "slow", "conditions", "satellite", "daily", "maintenance"]).nullable(),
  lastError: z.string().max(300).nullable(),
  completedAt: z.object({
    fast: z.string().datetime({ offset: true }).optional(), slow: z.string().datetime({ offset: true }).optional(),
    conditions: z.string().datetime({ offset: true }).optional(), satellite: z.string().datetime({ offset: true }).optional(),
    daily: z.string().datetime({ offset: true }).optional(), maintenance: z.string().datetime({ offset: true }).optional(),
  }).strict().default({}),
}).strict();
export type CollectorStatus = z.infer<typeof CollectorStatusSchema>;

export function writeCollectorStatus(database: LocalDatabase, next: CollectorStatus) {
  const value = JSON.stringify(CollectorStatusSchema.parse(next));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = database.read("private", COLLECTOR_STATUS_KEY);
    try { database.compareAndSwap("private", COLLECTOR_STATUS_KEY, value, current?.revision ?? null, 4096); return; }
    catch (error) { if (attempt === 2) throw error; }
  }
}

export function readCollectorStatus(database: LocalDatabase) {
  const row = database.read("private", COLLECTOR_STATUS_KEY);
  return row ? CollectorStatusSchema.parse(JSON.parse(row.value)) : null;
}

const levelRank = { SEVERE: 5, HIGH: 4, ELEVATED: 3, UNKNOWN: 2, NORMAL: 1 } as const;
const names = new Map(catalog.map((location) => [location.id, location]));

export async function publishedPluginSummary(store: PublicationStore, now = new Date()) {
  const current = await readCurrentPublication(store);
  if (!current) throw new Error("Public snapshot is unavailable");
  const snapshot = SnapshotV11Schema.parse(JSON.parse(await readPublishedObject(store, current.manifest.snapshot)));
  const counts = { NORMAL: 0, ELEVATED: 0, HIGH: 0, SEVERE: 0, UNKNOWN: 0 };
  for (const value of Object.values(snapshot.locations)) counts[value.level] += 1;
  const destinations = Object.entries(snapshot.locations).map(([id, state]) => ({
    id, name: names.get(id)?.name || id, countryCode: names.get(id)?.countryCode || id.slice(0, 2).toUpperCase(),
    level: state.level, updatePending: "updatePending" in state && state.updatePending === true,
  })).filter(({ level, updatePending }) => level !== "NORMAL" || updatePending)
    .sort((a, b) => levelRank[b.level] - levelRank[a.level] || Number(b.updatePending) - Number(a.updatePending) || a.name.localeCompare(b.name))
    .slice(0, 10);
  const delayed = now.getTime() - Date.parse(snapshot.generatedAt) > 30 * 60_000 || current.manifest.status.state === "degraded";
  return {
    schemaVersion: 1 as const, appVersion: packageJson.version, catalogVersion: 3 as const,
    health: delayed ? "degraded" as const : "ok" as const, freshness: delayed ? "delayed" as const : "fresh" as const,
    generatedAt: snapshot.generatedAt,
    restrictedSources: { active: false, count: restrictedSourceCount, disclosure: null },
    counts: { ...counts, attention: counts.ELEVATED + counts.HIGH + counts.SEVERE + counts.UNKNOWN }, destinations,
  };
}
