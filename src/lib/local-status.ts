import { z } from "zod";
import catalog from "../../public/catalogs/3/locations.json";
import packageJson from "../../package.json";
import { ConditionsV3Schema, SnapshotV11Schema } from "./domain/catalog-public";
import { catalogV3Paths } from "./catalog-paths";
import { COLLECTOR_STATUS_KEY, LocalDatabase } from "./local-storage";
import { readLocalPolicy } from "./local-storage";
import { restrictedConditionSourceIds, restrictedSourceCount, restrictedSourcesActive } from "./local-policy";
import { catalogV3CountryCodes } from "./domain/contract-identities";

export const CollectorStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(["starting", "running", "idle", "failed", "stopping"]),
  lastHeartbeat: z.string().datetime({ offset: true }),
  lastSuccess: z.string().datetime({ offset: true }).nullable(),
  lastOperation: z.enum(["fast", "slow", "conditions", "satellite", "daily", "maintenance"]).nullable(),
  lastError: z.string().max(300).nullable(),
  completedAt: z.object({
    fast: z.string().datetime({ offset: true }).optional(),
    slow: z.string().datetime({ offset: true }).optional(),
    conditions: z.string().datetime({ offset: true }).optional(),
    satellite: z.string().datetime({ offset: true }).optional(),
    daily: z.string().datetime({ offset: true }).optional(),
    maintenance: z.string().datetime({ offset: true }).optional(),
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

function publishedRestrictedSources(database: LocalDatabase) {
  for (const countryCode of catalogV3CountryCodes) {
    const row = database.readPublic(`${catalogV3Paths.conditions}${countryCode}.json`);
    if (!row) continue;
    const conditions = ConditionsV3Schema.parse(JSON.parse(row.value));
    if (Object.keys(conditions.sources).some((id) => restrictedConditionSourceIds.has(id))) return true;
  }
  return false;
}

export function localHealth(database: LocalDatabase, now = new Date()) {
  const collector = readCollectorStatus(database);
  const snapshotRow = database.readPublic(catalogV3Paths.snapshot);
  const snapshot = snapshotRow ? SnapshotV11Schema.parse(JSON.parse(snapshotRow.value)) : null;
  const heartbeatAge = collector ? now.getTime() - Date.parse(collector.lastHeartbeat) : Number.POSITIVE_INFINITY;
  const warming = !collector?.lastSuccess || (snapshot && Object.values(snapshot.locations).every(({ level }) => level === "UNKNOWN"));
  const degraded = collector?.state === "failed" || heartbeatAge > 3 * 60_000 || !snapshot;
  return {
    schemaVersion: 1 as const,
    status: degraded ? "degraded" as const : warming ? "warming" as const : "ok" as const,
    runtime: "sqlite" as const,
    catalogVersion: 3 as const,
    database: { available: Boolean(snapshot), writable: true },
    collector: collector ? {
      state: collector.state,
      lastHeartbeat: collector.lastHeartbeat,
      lastSuccess: collector.lastSuccess,
      lastOperation: collector.lastOperation,
    } : { state: "unavailable" as const, lastHeartbeat: null, lastSuccess: null, lastOperation: null },
  };
}

export function localPluginSummary(database: LocalDatabase, now = new Date()) {
  const health = localHealth(database, now);
  const row = database.readPublic(catalogV3Paths.snapshot);
  if (!row) throw new Error("Public snapshot is unavailable");
  const snapshot = SnapshotV11Schema.parse(JSON.parse(row.value));
  const policy = readLocalPolicy(database).policy;
  const restrictedAccepted = restrictedSourcesActive(policy);
  const restrictedPublished = publishedRestrictedSources(database);
  const restrictedActive = restrictedAccepted || restrictedPublished;
  const counts = { NORMAL: 0, ELEVATED: 0, HIGH: 0, SEVERE: 0, UNKNOWN: 0 };
  for (const value of Object.values(snapshot.locations)) counts[value.level] += 1;
  const destinations = Object.entries(snapshot.locations).map(([id, state]) => ({
    id,
    name: names.get(id)?.name || id,
    countryCode: names.get(id)?.countryCode || id.slice(0, 2).toUpperCase(),
    level: state.level,
    updatePending: "updatePending" in state && state.updatePending === true,
  })).filter(({ level, updatePending }) => level !== "NORMAL" || updatePending)
    .sort((a, b) => levelRank[b.level] - levelRank[a.level] || Number(b.updatePending) - Number(a.updatePending) || a.name.localeCompare(b.name))
    .slice(0, 10);
  const age = now.getTime() - Date.parse(snapshot.generatedAt);
  const allPending = Object.values(snapshot.locations).every(({ level }) => level === "UNKNOWN");
  const freshness = allPending || health.status === "warming" ? "warming" : health.status === "degraded" || age > 30 * 60_000 || snapshot.dataHealth !== "complete" ? "delayed" : "fresh";
  return {
    schemaVersion: 1 as const,
    appVersion: packageJson.version,
    catalogVersion: 3 as const,
    health: health.status,
    freshness,
    generatedAt: snapshot.generatedAt,
    restrictedSources: {
      active: restrictedActive,
      count: restrictedSourceCount,
      disclosure: restrictedAccepted
        ? "This instance uses operator-accepted restricted, noncommercial data sources."
        : restrictedPublished
          ? "Published data still includes restricted, noncommercial sources while collection is disabled."
          : null,
    },
    counts: { ...counts, attention: counts.ELEVATED + counts.HIGH + counts.SEVERE + counts.UNKNOWN },
    destinations,
  };
}
