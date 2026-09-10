"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { DataMode } from "@/lib/config";
import { applySnapshotStaleness } from "@/lib/snapshot-health";
import { useSafetyData } from "@/lib/use-safety-data";
import { locationInCoreOverview, mapFilterCounts, type MapFilter } from "@/lib/map-presentation";
import { navigationUrl, parseAppNavigation, type AppView } from "@/lib/app-navigation";
import { INSTALL_HINT_STORAGE_KEY, installPlatform, isStandaloneDisplay, type InstallPlatform } from "@/lib/install-presentation";
import {
  attentionLocationSummaries,
  attentionPresentation,
  deriveUiDataState,
  liveStatusPresentation,
  locationState,
  searchLocationSummaries,
  type SelectionOrigin,
} from "@/lib/ui-presentation";
import { AppHeader, ConnectivityBanner, DataHealthBanner } from "./AppChrome";
import { AttentionTray } from "./AttentionTray";
import { AlertsView } from "./AlertsView";
import { DestinationDetails } from "./DestinationDetails";
import { DestinationSearch } from "./DestinationSearch";
import { MapLoadBoundary } from "./MapLoadBoundary";
import { MapFilters } from "./MapFilters";
import { MobileNavigation } from "./MobileNavigation";
import type { MapCameraCommand } from "./RiskMap";
import { UiIcon } from "./UiIcon";
import styles from "./TravelCanaryApp.module.css";

const RiskMap = dynamic(() => import("./RiskMap").then((module) => module.RiskMap), { ssr: false, loading: () => <div className={styles.mapPlaceholder} role="status">Loading map</div> });
const MapFallback = dynamic(() => import("./MapFallback").then((module) => module.MapFallback));

function useResponsiveLayout() {
  const [layout, setLayout] = useState({ isCompact: false, isMobile: false, detailsOverlay: false });
  useEffect(() => {
    const compactMedia = window.matchMedia("(max-width: 1023px)");
    const mobileMedia = window.matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)");
    const overlayMedia = window.matchMedia("(min-width: 1024px) and (max-width: 1359px)");
    const update = () => setLayout({ isCompact: compactMedia.matches, isMobile: mobileMedia.matches, detailsOverlay: overlayMedia.matches });
    update();
    for (const media of [compactMedia, mobileMedia, overlayMedia]) media.addEventListener("change", update);
    return () => { for (const media of [compactMedia, mobileMedia, overlayMedia]) media.removeEventListener("change", update); };
  }, []);
  return layout;
}

export function TravelCanaryApp({ mode, snapshotUrl, catalogVersion = 2, conditionsEnabled = mode === "demo" }: { mode: DataMode; snapshotUrl: string | null; catalogVersion?: 2 | 3; conditionsEnabled?: boolean }) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pushedSelectionRef = useRef(false);
  const closeCompletionRef = useRef<(() => void) | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closingDetails, setClosingDetails] = useState(false);
  const [query, setQuery] = useState("");
  const [tilesFailed, setTilesFailed] = useState(false);
  const [mapFilter, setMapFilterState] = useState<MapFilter>("all");
  const [appView, setAppViewState] = useState<AppView>("map");
  const [cameraCommand, setCameraCommand] = useState<MapCameraCommand | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [online, setOnline] = useState(true);
  const [platform, setPlatform] = useState<InstallPlatform>("other");
  const [installed, setInstalled] = useState(false);
  const [installHintVisible, setInstallHintVisible] = useState(false);
  const [dismissedMapNotice, setDismissedMapNotice] = useState<string | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const { isCompact, isMobile, detailsOverlay } = useResponsiveLayout();
  const { locations, locationsLoaded, snapshot, catalogError, snapshotError, started, loadCatalog, loadSnapshot } = useSafetyData({ mode, snapshotUrl, catalogVersion });

  useEffect(() => () => { closeCompletionRef.current = null; }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    const environmentTimer = window.setTimeout(() => {
      updateOnline();
      setPlatform(installPlatform(navigator.userAgent));
      setInstalled(isStandaloneDisplay(window.matchMedia.bind(window), (navigator as Navigator & { standalone?: boolean }).standalone));
    }, 0);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.clearTimeout(environmentTimer);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    if (!locationsLoaded || catalogError) return;
    const validIds = new Set(locations.map(({ id }) => id));
    const applyLocationState = () => {
      const state = parseAppNavigation(window.location.search, validIds);
      if (state.destinationId) searchInputRef.current?.blur();
      pushedSelectionRef.current = Boolean(state.destinationId && window.history.state?.travelCanarySelection);
      setSelectedId(state.destinationId);
      setMapFilterState(state.filter);
      setAppViewState(state.view);
      if (state.destinationId) setQuery(locations.find(({ id }) => id === state.destinationId)?.name || "");
      else setQuery("");
      const cleaned = navigationUrl(window.location.pathname, window.location.search, state);
      if (`${window.location.pathname}${window.location.search}` !== cleaned) window.history.replaceState(window.history.state, "", cleaned);
      const completeClose = closeCompletionRef.current;
      closeCompletionRef.current = null;
      setClosingDetails(false);
      if (!state.destinationId) completeClose?.();
    };
    applyLocationState();
    window.addEventListener("popstate", applyLocationState);
    return () => window.removeEventListener("popstate", applyLocationState);
  }, [catalogError, locations, locationsLoaded]);

  const displayedSnapshot = useMemo(() => mode === "live" && snapshot ? applySnapshotStaleness(snapshot, new Date(clock), locations) : snapshot, [clock, locations, mode, snapshot]);
  const uiState = deriveUiDataState({ locationsLoaded, catalogError: Boolean(catalogError), snapshot: displayedSnapshot, snapshotError: Boolean(snapshotError), tilesFailed });
  const filterCounts = useMemo(() => locationsLoaded && !catalogError ? mapFilterCounts(locations, displayedSnapshot) : null, [catalogError, displayedSnapshot, locations, locationsLoaded]);
  const searchResults = useMemo(() => searchLocationSummaries(locations, displayedSnapshot, query), [displayedSnapshot, locations, query]);
  const attention = useMemo(() => attentionLocationSummaries(locations, displayedSnapshot), [displayedSnapshot, locations]);
  const attentionState = useMemo(() => attentionPresentation(attention, { catalogCount: locations.length, catalogAvailable: locationsLoaded && !catalogError }), [attention, catalogError, locations.length, locationsLoaded]);
  const selected = locations.find((location) => location.id === selectedId) || null;
  const selectedState = selected ? locationState(displayedSnapshot, selected.id) : null;
  const displayNow = mode === "demo" && displayedSnapshot ? new Date(displayedSnapshot.generatedAt) : new Date(clock);
  const outerDestinations = useMemo(() => locations.filter((location) => !locationInCoreOverview(location)), [locations]);
  const outerAlertCount = useMemo(() => outerDestinations.filter(({ id }) => {
    const level = locationState(displayedSnapshot, id).level;
    return level === "ELEVATED" || level === "HIGH" || level === "SEVERE";
  }).length, [displayedSnapshot, outerDestinations]);

  const replaceNavigation = useCallback((next: { destinationId?: string | null; view?: AppView; filter?: MapFilter }) => {
    const state = { destinationId: next.destinationId === undefined ? selectedId : next.destinationId, view: next.view || appView, filter: next.filter || mapFilter };
    window.history.replaceState(window.history.state, "", navigationUrl(window.location.pathname, window.location.search, state));
  }, [appView, mapFilter, selectedId]);

  const selectLocation = useCallback((id: string, _origin: SelectionOrigin, returnTarget: HTMLElement | null) => {
    if (closeCompletionRef.current) return;
    const location = locations.find((candidate) => candidate.id === id);
    if (!location) return;
    returnFocusRef.current = returnTarget || searchInputRef.current;
    setQuery(location.name);
    setSelectedId(id);
    // React Aria can report the same committed selection twice on WebKit. Do not
    // create duplicate history entries, otherwise one Back step reopens the sheet.
    const currentDestination = new URLSearchParams(window.location.search).get("destination");
    if (currentDestination === id) return;
    const state = { destinationId: id, view: appView, filter: mapFilter };
    // A destination-to-destination switch is one continuous briefing session.
    // Replace its entry so Close still returns to the pre-briefing camera/view.
    if (currentDestination) {
      window.history.replaceState(window.history.state, "", navigationUrl(window.location.pathname, window.location.search, state));
      return;
    }
    window.history.pushState({ ...(window.history.state || {}), travelCanarySelection: true }, "", navigationUrl(window.location.pathname, window.location.search, state));
    pushedSelectionRef.current = true;
  }, [appView, locations, mapFilter]);

  const closeDetails = useCallback(() => {
    if (closeCompletionRef.current) return;
    let installHintDismissed = true;
    try { installHintDismissed = Boolean(window.localStorage.getItem(INSTALL_HINT_STORAGE_KEY)); } catch {}
    const shouldHint = !installed && !installHintDismissed;
    const completeClose = () => {
      if (shouldHint) setInstallHintVisible(true);
      window.requestAnimationFrame(() => {
        const returnTarget = returnFocusRef.current?.isConnected ? returnFocusRef.current : searchInputRef.current;
        // Restoring mobile input focus opens full-screen search over the map.
        const focusTarget = isMobile && returnTarget === searchInputRef.current ? searchTriggerRef.current : returnTarget;
        focusTarget?.focus();
      });
    };
    if (window.history.state?.travelCanarySelection && pushedSelectionRef.current) {
      pushedSelectionRef.current = false;
      // Keep the briefing open until navigation completes. Returning to search
      // earlier lets the pending popstate overwrite newly entered input.
      closeCompletionRef.current = completeClose;
      setClosingDetails(true);
      window.history.back();
    } else {
      setSelectedId(null);
      replaceNavigation({ destinationId: null });
      completeClose();
    }
  }, [installed, isMobile, replaceNavigation]);

  const setMapFilter = useCallback((filter: MapFilter) => {
    setMapFilterState(filter);
    setDismissedMapNotice(null);
    replaceNavigation({ filter });
  }, [replaceNavigation]);

  const setAppView = useCallback((view: AppView) => {
    setAppViewState(view);
    replaceNavigation({ view });
  }, [replaceNavigation]);

  const handleMapFailure = useCallback(() => {
    setTilesFailed(true);
    if (isMobile) setAppView("alerts");
  }, [isMobile, setAppView]);

  const retry = useCallback(() => {
    if (catalogError) void loadCatalog();
    if (snapshotError || displayedSnapshot?.dataHealth !== "complete") void loadSnapshot();
  }, [catalogError, displayedSnapshot?.dataHealth, loadCatalog, loadSnapshot, snapshotError]);

  const healthMessage = catalogError || snapshotError || (uiState === "refresh-delayed" ? "Some source information is incomplete." : null);
  const healthBannerVisible = !online || ["catalog-unavailable", "snapshot-unavailable", "refresh-delayed"].includes(uiState);
  const liveStatus = liveStatusPresentation({ mode, uiState, generatedAt: displayedSnapshot?.generatedAt || null, now: new Date(clock) });
  const showOverview = (mode: MapCameraCommand["mode"]) => setCameraCommand({ mode, nonce: Date.now() });
  const emptyNoticeKey = filterCounts && filterCounts[mapFilter] === 0 ? `${mapFilter}:${filterCounts.elevated}:${filterCounts.unavailable}` : null;
  const mobileNavigationCount = filterCounts?.[mapFilter] ?? null;
  const mobileNavigationCountLabel = mapFilter === "unavailable"
    ? mobileNavigationCount === 1 ? "destination with updates unavailable" : "destinations with updates unavailable"
    : mobileNavigationCount === 1 ? "alert destination" : "alert destinations";

  return <main ref={setPortalContainer} className={styles.appShell} data-health-banner={healthBannerVisible || undefined} data-details-open={Boolean(selected && !isCompact) || undefined} data-selected-id={selectedId || undefined} data-mobile-view={appView}>
    <div className={styles.controlRail} aria-label="TravelCanary controls">
      <AppHeader status={liveStatus} compact={isMobile} installPlatform={platform} installed={installed} />
      <ConnectivityBanner online={online} />
      <DataHealthBanner state={uiState} message={healthMessage} onRetry={retry} />
      <DestinationSearch query={query} selectedId={selectedId} results={searchResults} isDisabled={!locationsLoaded || closingDetails} isMobile={isMobile} inputRef={searchInputRef} searchTriggerRef={searchTriggerRef} portalContainer={portalContainer}
        onQueryChange={(value) => {
          setQuery(value);
          if (selected && value !== selected.name) { setSelectedId(null); replaceNavigation({ destinationId: null }); }
        }}
        onSelect={selectLocation}
        onClear={() => { setQuery(""); setSelectedId(null); replaceNavigation({ destinationId: null }); }} />
      {!tilesFailed && <MapFilters filter={mapFilter} counts={filterCounts} onChange={setMapFilter} compact={isMobile} />}
      <div className={styles.railActions}>
        <button type="button" className={styles.allCoverageAction} onClick={() => showOverview("all-coverage")}><UiIcon name="map" /><span><strong>Show all {locations.length || "—"} destinations</strong><small>{outerDestinations.length} destinations outside the opening view{outerAlertCount ? ` · ${outerAlertCount} currently flagged` : ""}</small></span><UiIcon name="chevron" /></button>
        <AttentionTray presentation={attentionState} isCompact={isCompact} isLoading={uiState === "initial-loading"} portalContainer={portalContainer} onSelect={selectLocation} />
      </div>
    </div>

    <section className={styles.workspace} data-hidden={isMobile && appView === "alerts" || undefined} aria-label="Europe destination risk map">
      {!started && <div className={styles.mapPlaceholder} role="status">Loading map</div>}
      {started && !tilesFailed && <MapLoadBoundary onFailure={handleMapFailure}><RiskMap catalogVersion={catalogVersion} locations={locations} snapshot={displayedSnapshot} selectedId={selectedId} filter={mapFilter} detailsOpen={Boolean(selected)} compactMode={isCompact} mobileMode={isMobile} detailsOverlay={detailsOverlay} healthBannerVisible={healthBannerVisible} viewActive={!isMobile || appView === "map"} cameraCommand={cameraCommand} onSelect={selectLocation} onFailure={handleMapFailure} /></MapLoadBoundary>}
      {tilesFailed && (!isMobile || appView === "map") && <MapFallback catalogAvailable={locationsLoaded && !catalogError} locations={locations} snapshot={displayedSnapshot} onSelect={selectLocation} />}
      <button type="button" className={styles.mobileAllCoverage} onClick={() => showOverview("all-coverage")}><UiIcon name="map" />All {locations.length || "—"}{outerAlertCount ? <b>{outerAlertCount} outer alerts</b> : null}</button>
      {isMobile && appView === "map" && filterCounts && emptyNoticeKey && dismissedMapNotice !== emptyNoticeKey && <aside className={styles.mobileEmptyNotice} role="status">
        <div><strong>{mapFilter === "high" ? "No High or Severe alerts found in checked sources." : mapFilter === "all" ? "No alerts found in checked sources." : "No destinations have updates unavailable."}</strong><small>{mapFilter === "high" && filterCounts.elevated ? `${filterCounts.elevated} Be aware destinations are available.` : "Monitoring may still be incomplete."}</small></div>
        {mapFilter === "high" && filterCounts.elevated > 0 && <button type="button" onClick={() => setMapFilter("all")}>Show Be aware</button>}
        {mapFilter !== "unavailable" && filterCounts.unavailable > 0 && <button type="button" onClick={() => setMapFilter("unavailable")}>Show unavailable</button>}
        <button type="button" className={styles.dismissNotice} aria-label="Dismiss map result" onClick={() => setDismissedMapNotice(emptyNoticeKey)}><UiIcon name="close" /></button>
      </aside>}
    </section>

    {isMobile && appView === "alerts" && (tilesFailed
      ? <section className={styles.mobileMapFallback} aria-label="Map fallback directory"><MapFallback catalogAvailable={locationsLoaded && !catalogError} locations={locations} snapshot={displayedSnapshot} onSelect={selectLocation} /></section>
      : <AlertsView presentation={attentionState} filter={mapFilter} onSelect={selectLocation} onShowMap={() => setAppView("map")} />)}
    {selected && selectedState && <DestinationDetails catalogVersion={catalogVersion} key={selected.id} location={selected} countryIds={locations.filter((location) => location.countryCode === selected.countryCode).map(({ id }) => id)} snapshotUrl={conditionsEnabled ? snapshotUrl : null} state={selectedState} snapshot={displayedSnapshot} now={displayNow} isCompact={isCompact} onClose={closeDetails} />}
    {isMobile && <MobileNavigation view={appView} itemCount={mobileNavigationCount} itemCountLabel={mobileNavigationCountLabel} onChange={setAppView} />}
    {installHintVisible && <aside className={styles.installHint} role="status"><UiIcon name="install" /><span><strong>Add TravelCanary to your home screen</strong><small>{platform === "ios" ? "Open Share, then Add to Home Screen." : platform === "android" ? "Use your browser menu and choose Install app." : "Use your browser's install command."}</small></span><button type="button" aria-label="Dismiss installation hint" onClick={() => { try { window.localStorage.setItem(INSTALL_HINT_STORAGE_KEY, "true"); } catch {} setInstallHintVisible(false); }}><UiIcon name="close" /></button></aside>}
    <span className="sr-only" role="status" aria-live="polite">{isMobile ? `${appView === "map" ? "Map" : "Alerts"} view selected.` : ""}</span>
  </main>;
}
