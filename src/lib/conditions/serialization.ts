import { ConditionsV3Schema } from "../domain/catalog-public";

const emptyDefaultArrays = new Set(["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions", "limitations"]);

// These fields already decode to [] in the frozen reader. Omit only empty
// defaults in V3 wire output; retain every record, forecast value and timestamp.
export function serializeCatalog3Conditions(input: unknown): string {
  const file = ConditionsV3Schema.parse(input);
  return JSON.stringify({ ...file, locations: Object.fromEntries(Object.entries(file.locations).map(([id, value]) => [id,
    Object.fromEntries(Object.entries(value).filter(([key, item]) => !emptyDefaultArrays.has(key) || !Array.isArray(item) || item.length > 0)),
  ])) });
}
