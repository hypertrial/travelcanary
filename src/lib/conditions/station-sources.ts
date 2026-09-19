import type { ConditionSourceId, LocationConditions, Observation } from "../domain/conditions";
import type { IngestionState } from "../domain/catalog-state";

export type StationConditionField = "rivers" | "observations";

export type StationSourceSpec<TParsed = unknown> = {
  sourceId: ConditionSourceId;
  field: StationConditionField;
  isDue: () => boolean;
  request: () => Promise<{ body: unknown }>;
  parse: (body: unknown) => TParsed;
  mappings: (parsed: TParsed) => Iterable<{ locationId: string; fresh: readonly Observation[] }>;
  retention: (others: Observation[], fresh: readonly Observation[]) => Observation[];
};

export function retainStationItems<T>(others: T[], fresh: readonly T[]) {
  return [...others, ...fresh].slice(0, 3);
}

export async function ingestStationSource<TParsed>(
  spec: StationSourceSpec<TParsed>,
  context: {
    state: IngestionState;
    changes: Map<string, Partial<LocationConditions>>;
    updateHealth: (sourceId: ConditionSourceId, matched: number, failed: boolean) => void;
  },
) {
  if (!spec.isDue()) return;
  try {
    const { body } = await spec.request();
    const parsed = spec.parse(body);
    let matched = 0;
    for (const { locationId, fresh } of spec.mappings(parsed)) {
      const previous = context.changes.get(locationId)?.[spec.field]
        || context.state.conditions.locations[locationId]?.[spec.field] || [];
      const others = previous.filter((item) => item.sourceId !== spec.sourceId);
      context.changes.set(locationId, { ...context.changes.get(locationId), [spec.field]: spec.retention(others, fresh) });
      matched += fresh.length;
    }
    context.updateHealth(spec.sourceId, matched, false);
  } catch { context.updateHealth(spec.sourceId, 0, true); }
}
