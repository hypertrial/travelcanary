import { locationTypeLabels, publicAccessibleLabels, publicSymbols, type AttentionPresentation, type SelectionOrigin } from "@/lib/ui-presentation";
import type { MapFilter } from "@/lib/map-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./AlertsView.module.css";

export function AlertsView({ presentation, filter, onSelect, onShowMap }: {
  presentation: AttentionPresentation;
  filter: MapFilter;
  onSelect: (id: string, origin: SelectionOrigin, returnTarget: HTMLElement | null) => void;
  onShowMap: () => void;
}) {
  const groups = presentation.groups.filter((group) => filter === "all"
    ? group.key !== "unavailable"
    : filter === "high"
      ? group.key === "emergency" || group.key === "change-plans"
      : group.key === "unavailable");
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const heading = filter === "unavailable" ? "Update problems" : filter === "high" ? "High and Severe alerts" : "Current alerts";
  const eyebrow = filter === "unavailable" ? "Source freshness" : "Current destination briefings";
  return <section className={styles.view} aria-labelledby="alerts-heading">
    <header>
      <span className={styles.headingIcon}><UiIcon name="attention" /></span>
      <div><p>{eyebrow}</p><h2 id="alerts-heading">{heading}</h2><span>{total} {total === 1 ? "destination" : "destinations"} in this view</span></div>
    </header>
    {presentation.globalUnavailable ? <div className={styles.empty} data-tone="unavailable"><b>?</b><h3>Updates unavailable</h3><p>Current alerts could not be confirmed. Search a destination or check official local sources.</p></div>
      : total === 0 ? <div className={styles.empty}><b><UiIcon name="search" /></b><h3>{filter === "high" ? "No High or Severe alerts found" : filter === "unavailable" ? "No update problems" : "No destinations are flagged"}</h3><p>This is limited to checked sources and is not an all-clear.</p><button type="button" onClick={onShowMap}>Return to map</button></div>
        : <div className={styles.groups}>{groups.map((group) => <section key={group.key} aria-labelledby={`mobile-alerts-${group.key}`}>
          <h3 id={`mobile-alerts-${group.key}`}><span>{group.label}</span><b>{group.items.length}</b></h3>
          <ul>{group.items.map(({ location, state }) => <li key={location.id}><button type="button" onClick={(event) => onSelect(location.id, "alerts", event.currentTarget)} aria-label={`${location.name}, ${location.country}. ${publicAccessibleLabels[state.level]}.`}>
            <span className={styles.status} data-level={state.level} aria-hidden="true">{publicSymbols[state.level]}</span>
            <span className={styles.place}><strong>{location.name}</strong><small><span>{location.country} · {locationTypeLabels[location.type]}</span>{"timing" in state && <>{" "}<span className={styles.timing}>{state.timing === "ACTIVE" ? "Active now" : "Starts soon"}</span></>}</small></span>
            <UiIcon name="chevron" />
          </button></li>)}</ul>
        </section>)}</div>}
  </section>;
}
