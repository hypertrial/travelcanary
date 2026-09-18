"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DataMode } from "./config";
import { PublicCatalogV3Schema } from "./domain/catalog-public";
import { initialSafetyDataState, safetyDataReducer } from "./safety-data-state";
import { catalogV3Paths } from "./catalog-paths";
import { loadPublicationSnapshot } from "./publication-client";

export function useSafetyData({ mode, snapshotUrl, catalogVersion = 3 }: { mode: DataMode; snapshotUrl: string | null; catalogVersion?: 3 }) {
  const [state, dispatch] = useReducer(safetyDataReducer, initialSafetyDataState);
  const resourceKey = JSON.stringify([catalogVersion, mode, snapshotUrl]);
  const epochRef = useRef(0);
  const activeRef = useRef<{ key: string; epoch: number } | null>(null);
  const requestRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const fetchCatalog = useCallback(async (epoch: number) => {
    const request = ++catalogRequestRef.current;
    dispatch({ epoch, type: "catalog-loading", request });
    try {
      const response = await fetch(catalogV3Paths.catalog);
      if (!response.ok) throw new Error();
      dispatch({ epoch, type: "catalog-ready", request, locations: PublicCatalogV3Schema.parse(await response.json()) });
    } catch { dispatch({ epoch, type: "catalog-failed", request }); }
  }, []);
  const fetchSnapshot = useCallback(async (epoch: number) => {
    const request = ++requestRef.current;
    dispatch({ epoch, type: "snapshot-loading", request });
    if (!snapshotUrl) return dispatch({ epoch, type: "snapshot-unconfigured", request });
    try {
      const separator = snapshotUrl.includes("?") ? "&" : "?";
      const pointerUrl = mode === "live" ? `${snapshotUrl}${separator}v=${Math.floor(Date.now() / 600_000)}` : snapshotUrl;
      const snapshot = await loadPublicationSnapshot(pointerUrl);
      if (snapshot.catalogVersion !== 3) throw new Error("Snapshot catalog does not match Catalog 3");
      dispatch({ epoch, type: "snapshot-ready", request, snapshot, receivedAt: Date.now() });
    } catch { dispatch({ epoch, type: "snapshot-failed", request }); }
  }, [mode, snapshotUrl]);
  const loadCatalog = useCallback(async () => {
    const active = activeRef.current;
    if (active?.key === resourceKey) await fetchCatalog(active.epoch);
  }, [resourceKey, fetchCatalog]);
  const loadSnapshot = useCallback(async () => {
    const active = activeRef.current;
    if (active?.key === resourceKey) await fetchSnapshot(active.epoch);
  }, [resourceKey, fetchSnapshot]);
  useEffect(() => {
    const epoch = ++epochRef.current;
    activeRef.current = { key: resourceKey, epoch };
    dispatch({ type: "reset", epoch, resourceKey });
    const initial = window.setTimeout(() => {
      void fetchCatalog(epoch);
      void fetchSnapshot(epoch);
      dispatch({ type: "start", epoch });
    }, 0);
    const refresh = mode === "live" ? window.setInterval(() => void fetchSnapshot(epoch), 600_000) : null;
    return () => {
      if (activeRef.current?.epoch === epoch) activeRef.current = null;
      window.clearTimeout(initial);
      if (refresh !== null) window.clearInterval(refresh);
    };
  }, [resourceKey, fetchCatalog, fetchSnapshot, mode]);
  // A changed release/origin must not render the prior resource before its effect resets it.
  return { ...(state.resourceKey === resourceKey ? state : initialSafetyDataState), loadCatalog, loadSnapshot };
}
