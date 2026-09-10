import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "@/lib/domain/catalog-public";
import { locationState, publicAccessibleLabels, publicLabels, publicSymbols, type SelectionOrigin } from "@/lib/ui-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./MapFallback.module.css";

export function MapFallback({
  catalogAvailable,
  locations,
  snapshot,
  onSelect,
}: {
  catalogAvailable: boolean;
  locations: PublicLocation[];
  snapshot: Snapshot | null;
  onSelect: (id: string, origin: SelectionOrigin, returnTarget: HTMLElement | null) => void;
}) {
  const sorted = [...locations].sort((a, b) => a.name.localeCompare(b.name, "en"));
  return <section className={styles.mapFallback} aria-labelledby="map-unavailable-heading">
    <div className={styles.mapFallbackIntro}>
      <span><UiIcon name="map" /></span>
      <div><h2 id="map-unavailable-heading">The map could not load.</h2><p>{catalogAvailable ? "Search still works, or choose a destination from the list." : "The destination list is also unavailable. Retry or check official local sources."}</p></div>
    </div>
    {catalogAvailable && <div className={styles.directory} role="region" aria-labelledby="destination-list-heading">
      <h2 id="destination-list-heading">Destination list</h2>
      <ul>{sorted.map((location) => {
        const state = locationState(snapshot, location.id);
        return <li key={location.id}><button type="button" aria-label={`${location.name}, ${location.country}. ${publicAccessibleLabels[state.level]}.`} onClick={(event) => onSelect(location.id, "directory", event.currentTarget)}>
          <span className={styles.directoryStatus} data-level={state.level} aria-hidden="true">{state.level === "NORMAL" ? <UiIcon name="search" /> : publicSymbols[state.level]}</span>
          <span><strong>{location.name}</strong><small>{location.country}</small></span>
          <em>{publicLabels[state.level]}</em>
        </button></li>;
      })}</ul>
    </div>}
  </section>;
}
