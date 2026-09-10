"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DataMode } from "./config";
import { parseCatalogSnapshot, PublicCatalogV2Schema, PublicCatalogV3Schema } from "./domain/catalog-public";
import { initialSafetyDataState, safetyDataReducer } from "./safety-data-state";
import { catalogV2Paths, catalogV3Paths } from "./catalog-paths";

export function useSafetyData({ mode, snapshotUrl, catalogVersion = 2 }: { mode: DataMode; snapshotUrl: string | null; catalogVersion?: 2 | 3 }) {
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
      const response = await fetch((catalogVersion === 3 ? catalogV3Paths : catalogV2Paths).catalog);
      if (!response.ok) throw new Error();
      dispatch({ epoch, type: "catalog-ready", request, locations: (catalogVersion === 3 ? PublicCatalogV3Schema : PublicCatalogV2Schema).parse(await response.json()) });
    } catch { dispatch({ epoch, type: "catalog-failed", request }); }
  }, [catalogVersion]);
  const fetchSnapshot = useCallback(async (epoch: number) => {
    const request = ++requestRef.current;
    dispatch({ epoch, type: "snapshot-loading", request });
    if (!snapshotUrl) return dispatch({ epoch, type: "snapshot-unconfigured", request });
    try {
      const suffix = mode === "live" ? `?v=${Math.floor(Date.now() / 600_000)}` : "";
      const response = await fetch(`${snapshotUrl}${suffix}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const snapshot = parseCatalogSnapshot(await response.json());
      if (catalogVersion === 2 && snapshot.catalogVersion !== 2) throw new Error("Snapshot catalog does not match requested release");
      dispatch({ epoch, type: "snapshot-ready", request, snapshot, receivedAt: Date.now() });
    } catch { dispatch({ epoch, type: "snapshot-failed", request }); }
  }, [mode, snapshotUrl, catalogVersion]);
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
