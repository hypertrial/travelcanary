import { useRef, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { MapFilter, MapFilterCounts } from "@/lib/map-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./MapFilters.module.css";

const filters: { id: MapFilter; label: string }[] = [
  { id: "all", label: "All alerts" },
  { id: "high", label: "High & Severe" },
  { id: "unavailable", label: "Updates unavailable" },
];

export function MapFilters({ filter, counts, onChange, compact = false }: {
  filter: MapFilter;
  counts: MapFilterCounts | null;
  onChange: (filter: MapFilter) => void;
  compact?: boolean;
}) {
  const buttons = useRef<Partial<Record<MapFilter, HTMLButtonElement | null>>>({});
  const [open, setOpen] = useState(false);
  const recover = (next: MapFilter) => {
    onChange(next);
    buttons.current[next]?.focus();
  };
  if (compact) {
    const active = filters.find(({ id }) => id === filter)!;
    return <div className={styles.compactWrap} data-ui="map-filters">
      <Button className={styles.compactTrigger} onPress={() => setOpen(true)} aria-label={`Map filter: ${active.label}, ${counts ? counts[filter] : "count unavailable"}. Change filter.`}><UiIcon name="attention" /><span>{active.label} · {counts ? counts[filter] : "—"}</span><UiIcon name="chevron" /></Button>
      <ModalOverlay isOpen={open} onOpenChange={setOpen} isDismissable className={styles.overlay}><Modal className={styles.modal}><Dialog className={styles.dialog} aria-label="Choose map filter">{({ close }) => <>
        <div className={styles.modalHeading}><div><Heading slot="title">Choose what the map shows</Heading><p>Counts are destinations, not incidents.</p></div><Button slot="close" className={styles.close} aria-label="Close map filters"><UiIcon name="close" /></Button></div>
        <div className={styles.mobileOptions}>{filters.map(({ id, label }) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => { onChange(id); close(); }}><span><strong>{label}</strong><small>{id === "all" ? "Be aware, High, and Severe" : id === "high" ? "The strongest current alerts" : "Places without confirmed updates"}</small></span><b>{counts ? counts[id] : "—"}</b></button>)}</div>
      </>}</Dialog></Modal></ModalOverlay>
    </div>;
  }
  return <div className={styles.panel} data-ui="map-filters">
    <div className={styles.panelHeading}>
      <strong>Map view</strong>
      <span>Filter destinations</span>
    </div>
    <div className={styles.filters} role="group" aria-label="Map filters">
      {filters.map(({ id, label }) => <button
        key={id}
        ref={(button) => { buttons.current[id] = button; }}
        type="button"
        aria-pressed={filter === id}
        aria-label={`${label} · ${counts ? counts[id] : "—"}`}
        disabled={!counts}
        onClick={() => onChange(id)}
      ><span>{label}</span><b aria-hidden="true">{counts ? counts[id] : "—"}</b></button>)}
    </div>
    <div className={styles.summary} role="status" aria-live="polite" aria-atomic="true">
      <span className={styles.hint}>Counts are destinations. Search always includes every place.</span>
      {counts && counts[filter] === 0 && <p>
        {filter === "high" ? "No High or Severe alerts found in checked sources."
          : filter === "all" ? "No alerts found in checked sources. Monitoring may be incomplete."
            : "No destinations have updates unavailable."}
        {filter === "high" && counts.elevated > 0 && <button type="button" onClick={() => recover("all")}>
          Show {counts.elevated} Be aware destinations
        </button>}
        {filter !== "unavailable" && counts.unavailable > 0 && <button type="button" onClick={() => recover("unavailable")}>
          Show {counts.unavailable} destinations with updates unavailable
        </button>}
      </p>}
    </div>
  </div>;
}
