import { expandedDelayedHazards } from "./expanded-source-health";
import { expandedHazardCoverage, isExpandedDestination } from "./expanded-coverage";
import type { HazardType } from "./domain/schemas";
import { parseCatalogSnapshot } from "./domain/catalog-public";
import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "./domain/catalog-public";
import { currentPublicHazards } from "./hazard-lifecycle";
import { enabledHazards, hazardAppliesToLocation } from "./risk-policy";

function withoutExpiredHazards(snapshot: Snapshot, now: Date): Snapshot {
  return parseCatalogSnapshot({
    ...snapshot,
    locations: Object.fromEntries(Object.entries(snapshot.locations).map(([id, state]) => {
      const identity = { id, countryCode: id.slice(0, 2).toUpperCase() };
      if (snapshot.catalogVersion === 3 && isExpandedDestination(identity) && !("updatePending" in state && state.updatePending)) {
        const hazards = currentPublicHazards(state.hazards, now);
        const delayedHazards = expandedDelayedHazards(identity, snapshot.providers, now);
        const coverage = delayedHazards.length ? "delayed" : "partial";
        return [id, hazards.length ? { ...state, hazards, delayedHazards, coverage, level: hazards[0].level, timing: hazards[0].timing }
          : { coverage, coverageGaps: state.coverageGaps, delayedHazards, level: delayedHazards.length ? "UNKNOWN" : "NORMAL", hazards: [] }];
      }
      if (state.level === "NORMAL" || state.level === "UNKNOWN") return [id, state];
      const hazards = currentPublicHazards(state.hazards, now);
      if (hazards.length === 0) return [id, {
        level: state.coverage === "delayed" ? "UNKNOWN" as const : "NORMAL" as const,
        coverage: state.coverage,
        coverageGaps: state.coverageGaps,
        delayedHazards: state.delayedHazards,
        hazards: [] as [],
      }];
      return [id, { ...state, level: hazards[0].level, timing: hazards[0].timing, hazards }];
    })),
  });
}

export function applySnapshotStaleness(
  snapshot: Snapshot,
  now = new Date(),
  catalog: ReadonlyArray<Pick<PublicLocation, "id" | "type" | "isCoastal">> = [],
): Snapshot {
  const current = withoutExpiredHazards(snapshot, now);
  const age = now.getTime() - Date.parse(current.generatedAt);
  if (age >= -5 * 60_000 && age <= 30 * 60_000) return current;
  if (age >= 0 && age <= 2 * 60 * 60_000) return parseCatalogSnapshot({ ...current, dataHealth: "delayed" });
  const catalogById = new Map(catalog.map((location) => [location.id, location]));

  return parseCatalogSnapshot({
    ...current,
    dataHealth: "stale",
    locations: Object.fromEntries(Object.entries(current.locations).map(([id, state]) => {
      if ("updatePending" in state && state.updatePending) return [id, state];
      const location = catalogById.get(id);
      const identity = { id, countryCode: id.slice(0, 2).toUpperCase() };
      const staleHazards = current.catalogVersion === 3 && isExpandedDestination(identity)
        ? (Object.entries(expandedHazardCoverage(identity)) as [HazardType, { status: string }][]).filter(([, entry]) => entry.status !== "not_monitored").map(([hazard]) => hazard)
        : location
        ? enabledHazards.filter((hazard) => hazardAppliesToLocation(hazard, location)
          || (hazard === "volcano" && state.hazards.some((incident) => incident.type === "volcano")))
        : enabledHazards;
      const delayed = { ...state, coverage: "delayed" as const, delayedHazards: [...new Set([...state.delayedHazards, ...staleHazards])] };
      return [id, state.level === "NORMAL" ? { ...delayed, level: "UNKNOWN", hazards: [] as [] } : delayed];
    })),
  });
}
