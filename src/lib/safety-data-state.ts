import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "./domain/catalog-public";


export type SafetyDataState = {
  epoch: number;
  resourceKey: string | null;
  locations: PublicLocation[];
  locationsLoaded: boolean;
  catalogError: string | null;
  catalogRequest: number;
  snapshot: Snapshot | null;
  snapshotError: string | null;
  request: number;
  started: boolean;
};

type DataAction =
  | { type: "start" }
  | { type: "catalog-loading"; request: number }
  | { type: "catalog-ready"; request: number; locations: PublicLocation[] }
  | { type: "catalog-failed"; request: number }
  | { type: "snapshot-loading"; request: number }
  | { type: "snapshot-unconfigured"; request: number }
  | { type: "snapshot-ready"; request: number; snapshot: Snapshot; receivedAt: number }
  | { type: "snapshot-failed"; request: number };

export type SafetyDataAction = (DataAction & { epoch?: number })
  | { type: "reset"; epoch: number; resourceKey: string };

export const initialSafetyDataState: SafetyDataState = {
  epoch: 0, resourceKey: null,
  locations: [], locationsLoaded: false, catalogError: null, catalogRequest: 0, snapshot: null,
  snapshotError: null, request: 0, started: false,
};

export function safetyDataReducer(state: SafetyDataState, action: SafetyDataAction): SafetyDataState {
  if (action.type === "reset") return action.epoch > state.epoch
    ? { ...initialSafetyDataState, epoch: action.epoch, resourceKey: action.resourceKey } : state;
  if ((action.epoch ?? 0) !== state.epoch) return state;
  switch (action.type) {
    case "start": return { ...state, started: true };
    case "catalog-loading": return { ...state, catalogRequest: Math.max(state.catalogRequest, action.request), catalogError: null };
    case "catalog-ready": return action.request !== state.catalogRequest ? state : { ...state, locations: action.locations, locationsLoaded: true, catalogError: null };
    case "catalog-failed": return action.request !== state.catalogRequest ? state : { ...state, locationsLoaded: false, catalogError: "The curated destination list could not be loaded." };
    case "snapshot-loading": return { ...state, request: Math.max(state.request, action.request) };
    case "snapshot-unconfigured": return {
      ...state, request: Math.max(state.request, action.request),
      snapshotError: "Live updates are not configured. Check official local sources before relying on this map.",
    };
    case "snapshot-failed": return action.request !== state.request ? state : {
      ...state,
      snapshotError: state.snapshot
        ? "Previously loaded alerts remain visible while the latest update is retried."
        : "The latest alerts could not be confirmed. Check official local sources before relying on this map.",
    };
    case "snapshot-ready": return state.snapshot
      && Date.parse(state.snapshot.generatedAt) <= action.receivedAt + 5 * 60_000
      && Date.parse(action.snapshot.generatedAt) < Date.parse(state.snapshot.generatedAt)
      ? state : { ...state, snapshot: action.snapshot, snapshotError: null };
  }
}
