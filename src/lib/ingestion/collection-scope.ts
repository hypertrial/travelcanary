import { catalogLocationsV3 } from "../catalog-data";
import { locations } from "../data";
import { ExpandedAggregateSourceResultSchema, expandedReceiptLocationIds } from "../domain/catalog-state";
import type { SourceResult } from "../domain/schemas";
import { isExpandedSourceAdapter, type ExpandedSourceAdapter, type SourceAdapter } from "./types";

export function expandedAdapterLocations(adapter: ExpandedSourceAdapter, catalogVersion: 2 | 3) {
  const catalog = catalogVersion === 3 ? catalogLocationsV3 : locations;
  if (adapter.id === "slf-avalanche") return catalog.filter((location) =>
    (location.countryCode === "CH" && ["mountain", "resort", "park"].includes(location.type)) || location.id === "li-malbun");
  if (adapter.id === "fcdo-travel-advice") return catalog.filter(({ countryCode }) => countryCode !== "GB" && countryCode !== "VA");
  return catalog;
}

// Scope replacement and failure receipts to the locations actually collected.
// A rollback's successful old-catalog refresh must not erase newer destinations'
// retained evidence or make their independent receipts appear freshly checked.
export function scopeAdapterResult(adapter: SourceAdapter, catalogVersion: 2 | 3, result: SourceResult): SourceResult {
  if (result.sourceId !== adapter.id) throw new Error("Adapter result source identity mismatch");
  if (!isExpandedSourceAdapter(adapter)) return result;
  if ("partitions" in result) throw new Error("Expanded adapter requires a scoped aggregate result");
  const targets = new Set(expandedAdapterLocations(adapter, catalogVersion).map(({ id }) => id));
  if ((result.candidates?.length || 0) > 0) throw new Error("Approved expanded adapters do not emit discovery candidates");
  for (const event of result.events) {
    if (event.geometry.kind !== "locations" || event.geometry.ids.some((id) => !targets.has(id))) throw new Error("Expanded event lies outside its collected scope");
    if (adapter.id !== "fcdo-travel-advice" && event.geometry.ids.length !== 1) throw new Error("Expanded warning events must be destination-specific");
    if (adapter.id === "fcdo-travel-advice" && new Set(event.geometry.ids.map((id) => id.slice(0, 2))).size !== 1) throw new Error("Travel advice must remain within one country");
  }
  const supplied = [...(result.checkedLocationIds || []), ...(result.unavailableLocationIds || [])];
  if (supplied.some((id) => !targets.has(id)) || new Set(supplied).size !== supplied.length) throw new Error("Adapter checked scope is invalid");
  if (result.status === "ok" && ((result.unavailableLocationIds?.length || 0) > 0
    || (result.checkedLocationIds && result.checkedLocationIds.length !== targets.size))) throw new Error("Successful adapter result must check its complete scope");
  if ((result.status === "failed" || result.status === "disabled") && result.checkedLocationIds?.length) throw new Error("Failed adapter result cannot claim checked destinations");
  const checked = result.status === "failed" || result.status === "disabled" ? []
    : result.checkedLocationIds ?? (result.status === "ok" ? [...targets] : []);
  const checkedIds = new Set(checked);
  const unavailable = [...targets].filter((id) => !checkedIds.has(id));
  const scoped = ExpandedAggregateSourceResultSchema.parse({ ...result, checkedLocationIds: checked.slice().sort(), unavailableLocationIds: unavailable.sort() });
  if (catalogVersion === 3) {
    const expected = expandedReceiptLocationIds[adapter.id];
    if (expected.some((id) => !targets.has(id))) throw new Error("Expanded adapter did not schedule its complete reviewed cohort");
  }
  return scoped;
}
