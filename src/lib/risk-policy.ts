import type { HazardType, PublicLocation, SourceId } from "./domain/schemas";
import { providerRegistry } from "./provider-registry";
import { volcanoAppliesToLocation } from "./hazard-applicability";

const definitionsBySource = Object.values(providerRegistry).reduce((definitions, definition) => {
  definitions.set(definition.sourceId, definition);
  return definitions;
}, new Map<SourceId, (typeof providerRegistry)[keyof typeof providerRegistry]>());

export const sourceCadenceMinutes = Object.fromEntries(
  [...definitionsBySource].map(([sourceId, definition]) => [sourceId, definition.cadenceMinutes]),
) as Record<SourceId, number | null>;

export const enabledSources = new Set<SourceId>([...definitionsBySource]
  .filter(([, definition]) => definition.mode !== "disabled" && definition.cadenceMinutes !== null)
  .map(([sourceId]) => sourceId));

export const sourceHazards = Object.fromEntries(
  [...definitionsBySource].map(([sourceId, definition]) => [sourceId, definition.hazards]),
) as Partial<Record<SourceId, HazardType[]>>;

export const enabledHazards = [...new Set(Object.values(sourceHazards).flat())];
export const weatherFamily: HazardType[] = ["severe-weather", "flood", "extreme-heat", "extreme-cold", "snow-ice", "avalanche", "coastal"];
export const outdoorLocationTypes = new Set(["resort", "island", "park", "mountain", "coastal"]);

export function hazardAppliesToLocation(type: HazardType, location: Pick<PublicLocation, "id" | "type" | "isCoastal">) {
  if (type === "coastal") return location.isCoastal;
  if (type === "volcano") return volcanoAppliesToLocation(location.id);
  return type !== "fire-danger" || outdoorLocationTypes.has(location.type);
}
