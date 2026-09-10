import type { MapFilter } from "./map-presentation";

export type AppView = "map" | "alerts";

export interface AppNavigationState {
  destinationId: string | null;
  view: AppView;
  filter: MapFilter;
}

const views = new Set<AppView>(["map", "alerts"]);
const filters = new Set<MapFilter>(["all", "high", "unavailable"]);

export function parseAppNavigation(search: string, validDestinationIds?: ReadonlySet<string>): AppNavigationState {
  const params = new URLSearchParams(search);
  const rawDestination = params.get("destination");
  return {
    destinationId: rawDestination && (!validDestinationIds || validDestinationIds.has(rawDestination)) ? rawDestination : null,
    view: views.has(params.get("view") as AppView) ? params.get("view") as AppView : "map",
    filter: filters.has(params.get("filter") as MapFilter) ? params.get("filter") as MapFilter : "all",
  };
}

export function navigationUrl(pathname: string, currentSearch: string, state: AppNavigationState): string {
  const params = new URLSearchParams(currentSearch);
  if (state.destinationId) params.set("destination", state.destinationId);
  else params.delete("destination");
  if (state.view === "map") params.delete("view");
  else params.set("view", state.view);
  if (state.filter === "all") params.delete("filter");
  else params.set("filter", state.filter);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}
