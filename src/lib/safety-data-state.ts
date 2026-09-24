import type { PublicCatalogLocation as PublicLocation } from "./domain/catalog-public";
import type { VerifiedPublicationSnapshot } from "./publication-client";


export type SafetyDataState = {
  epoch: number;
  resourceKey: string | null;
  locations: PublicLocation[];
  locationsLoaded: boolean;
  catalogError: string | null;
  catalogRequest: number;
  publication: VerifiedPublicationSnapshot | null;
  snapshotError: string | null;
  request: number;
  acceptedRequest: number;
  started: boolean;
};

type DataAction =
  | { type: "start" }
  | { type: "catalog-loading"; request: number }
  | { type: "catalog-ready"; request: number; locations: PublicLocation[] }
  | { type: "catalog-failed"; request: number }
  | { type: "snapshot-loading"; request: number }
  | { type: "snapshot-unconfigured"; request: number }
  | { type: "publication-ready"; request: number; publication: VerifiedPublicationSnapshot; receivedAt: number }
  | { type: "snapshot-failed"; request: number };

export type SafetyDataAction = (DataAction & { epoch?: number })
  | { type: "reset"; epoch: number; resourceKey: string };

export const initialSafetyDataState: SafetyDataState = {
  epoch: 0, resourceKey: null,
  locations: [], locationsLoaded: false, catalogError: null, catalogRequest: 0, publication: null,
  snapshotError: null, request: 0, acceptedRequest: 0, started: false,
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
      snapshotError: state.publication
        ? "Previously loaded alerts remain visible while the latest update is retried."
        : "The latest alerts could not be confirmed. Check official local sources before relying on this map.",
    };
    case "publication-ready": {
      const current = state.publication;
      const currentTime = current ? Date.parse(current.snapshot.generatedAt) : NaN;
      const nextTime = Date.parse(action.publication.snapshot.generatedAt);
      if (current && (nextTime === currentTime && action.request < state.acceptedRequest
        || currentTime <= action.receivedAt + 5 * 60_000 && nextTime < currentTime)) return state;
      return { ...state, publication: action.publication, acceptedRequest: action.request, snapshotError: null };
    }
  }
}
