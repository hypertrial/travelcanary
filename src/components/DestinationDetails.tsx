import { catalogLocationState } from "@/lib/domain/catalog-public";
import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "@/lib/domain/catalog-public";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import type { LocationState, PublicHazard} from "@/lib/domain/schemas";
import { destinationTime } from "@/lib/time";
import {
  destinationHeadline,
  destinationSummary,
  evidenceLabel,
  locationTypeLabels,
  publicAccessibleLabels,
  publicLabels,
  publicSymbols,
} from "@/lib/ui-presentation";
import { DestinationContextLoader } from "./DestinationContextLoader";
import { UiIcon } from "./UiIcon";
import styles from "./DestinationDetails.module.css";

function timingDescription(hazard: PublicHazard, timezone: string, now: Date): string {
  const start = destinationTime(hazard.startsAt, timezone, now);
  const end = destinationTime(hazard.endsAt, timezone, now);
  return hazard.timing === "UPCOMING" ? `Starts ${start} · Ends ${end}` : `Started ${start} · Ends ${end}`;
}

function HazardCard({ hazard, location, now }: { hazard: PublicHazard; location: PublicLocation; now: Date }) {
  return <article className={styles.hazardCard}>
    <p className={styles.hazardTiming}><UiIcon name="clock" /><strong>{hazard.timing === "UPCOMING" ? `Starts ${destinationTime(hazard.startsAt, location.timezone, now)}` : "Active now"}</strong></p>
    <h3>{destinationHeadline(location, hazard)}</h3>
    <section className={styles.actionCard} aria-label="Suggested action"><span className={styles.actionIcon}><UiIcon name="attention" /></span><div><strong>What to do</strong><p>{hazard.action}</p></div></section>
    <p className={styles.hazardExplanation}>{hazard.explanation}</p>
    <dl className={styles.hazardFacts}>
      <div><dt>Affected area</dt><dd>{hazard.affectedArea.label}</dd></div>
      <div><dt>Local timing</dt><dd>{timingDescription(hazard, location.timezone, now)}</dd></div>
    </dl>
    <div className={styles.verification}>
      <span><UiIcon name="check" /><span><strong>{evidenceLabel(hazard)}</strong><small>Evidence</small></span></span>
      <span><UiIcon name="clock" /><span><strong>{destinationTime(hazard.sourceUpdatedAt, location.timezone, now)}</strong><small>Source updated</small></span></span>
    </div>
    <div className={styles.evidenceList} aria-label={`Evidence sources (${hazard.evidence.length})`}>
      <strong>Evidence{hazard.evidence.length > 1 ? ` · ${hazard.evidence.length} sources` : ""}</strong>
      {hazard.evidence.map((evidence) => <a key={`${evidence.sourceUrl}:${evidence.sourceUpdatedAt}`} className={styles.sourceLink} href={evidence.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${evidenceLabel(hazard)}: ${evidence.sourceName}, updated ${destinationTime(evidence.sourceUpdatedAt, location.timezone, now)} (opens in a new tab)`}>
        <span><b>{evidence.sourceName}</b><small>Updated {destinationTime(evidence.sourceUpdatedAt, location.timezone, now)}</small></span><UiIcon name="external" />
      </a>)}
    </div>
  </article>;
}

function DetailsContent({
  countryIds, snapshotUrl, catalogVersion = 2,
  location,
  state,
  snapshot,
  now,
  onClose,
}: {
  countryIds: string[]; snapshotUrl: string | null; catalogVersion?: 2 | 3;
  location: PublicLocation;
  state: LocationState;
  snapshot: Snapshot | null;
  now: Date;
  onClose: () => void;
}) {
  return <>
    <header className={styles.detailsHeader} data-level={state.level}>
      <div className={styles.placeMeta}><span>{location.country}</span><span aria-hidden="true">·</span><span>{locationTypeLabels[location.type]}</span></div>
      <h2>{location.name}</h2>
      {location.scopeNote && <p>{location.scopeNote}</p>}
      <span className={styles.statusBadge} data-level={state.level}>
        <span aria-hidden="true">{state.level === "NORMAL" ? <UiIcon name="search" /> : publicSymbols[state.level]}</span>
        {state.level === "NORMAL" ? publicAccessibleLabels.NORMAL : publicLabels[state.level]}
      </span>
      <p className={styles.tripImpact}>{destinationSummary(state, location.name)}</p>
      {snapshot && catalogLocationState(snapshot, location.id).updatePending && <p role="status">Monitoring update pending for this destination.</p>}
      <button type="button" className={styles.closeDetails} onClick={onClose} aria-label="Close destination details"><UiIcon name="close" /></button>
    </header>
    <div className={styles.detailsBody}>
      {state.hazards.length > 0 && <div className={styles.hazardList}>{state.hazards.map((hazard) => <HazardCard key={hazard.id} hazard={hazard} location={location} now={now} />)}</div>}
      <DestinationContextLoader catalogVersion={catalogVersion} location={location} state={state} snapshot={snapshot} now={now} countryIds={countryIds} snapshotUrl={snapshotUrl} />
      <p className={styles.safetyNote}>TravelCanary is an information aid, not an emergency service. Official local instructions always take precedence.</p>
    </div>
  </>;
}

export function DestinationDetails({
  countryIds, snapshotUrl, catalogVersion = 2,
  location,
  state,
  snapshot,
  now,
  isCompact,
  onClose,
}: {
  countryIds: string[]; snapshotUrl: string | null; catalogVersion?: 2 | 3;
  location: PublicLocation;
  state: LocationState;
  snapshot: Snapshot | null;
  now: Date;
  isCompact: boolean;
  onClose: () => void;
}) {
  const detailsRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [sheetState, setSheetState] = useState<"peek" | "expanded">("peek");
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!isCompact) detailsRef.current?.focus({ preventScroll: true });
  }, [isCompact, location.id]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const sheet = event.currentTarget.closest<HTMLElement>("[data-ui='destination-sheet']");
    if (!sheet) return;
    const startHeight = sheet.getBoundingClientRect().height;
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight };
    setDragHeight(startHeight);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const delta = event.clientY - drag.startY;
    setDragHeight(Math.max(160, Math.min(viewportHeight, drag.startHeight - delta)));
  };
  const finishDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragHeight(null);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    if (cancelled) return;
    const delta = event.clientY - drag.startY;
    if (delta < -56) setSheetState("expanded");
    else if (delta > 56 && sheetState === "expanded") setSheetState("peek");
    else if (delta > 88 && sheetState === "peek") onClose();
  };

  if (isCompact) return <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }} className={styles.modalOverlay} data-sheet-state={sheetState}>
    <Modal
      className={styles.detailsModal}
      data-ui="destination-sheet"
      data-sheet-state={sheetState}
      data-alert={state.hazards.length > 0 || undefined}
      data-dragging={dragHeight !== null || undefined}
      style={dragHeight === null ? undefined : ({ height: `${dragHeight}px` } satisfies CSSProperties)}
    >
      <Dialog className={styles.detailsDialog} aria-label={`${location.name} risk details`}>
        <div
          className={styles.sheetToolbar}
          data-ui="sheet-drag-handle"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          <span aria-hidden="true" />
          <Button onPress={() => setSheetState((current) => current === "peek" ? "expanded" : "peek")} aria-label={`${sheetState === "peek" ? "Expand" : "Collapse"} destination details`}>
            <UiIcon name="chevron" />{sheetState === "peek" ? "Expand" : "Collapse"}
          </Button>
        </div>
        <DetailsContent catalogVersion={catalogVersion} location={location} countryIds={countryIds} snapshotUrl={snapshotUrl} state={state} snapshot={snapshot} now={now} onClose={onClose} />
      </Dialog>
    </Modal>
  </ModalOverlay>;

  const detailVariant = state.hazards.length > 0 ? "alert" : "compact";
  return <aside ref={detailsRef} tabIndex={-1} className={styles.detailsDrawer} data-variant={detailVariant} aria-label={`${location.name} risk details`}>
    <DetailsContent catalogVersion={catalogVersion} location={location} countryIds={countryIds} snapshotUrl={snapshotUrl} state={state} snapshot={snapshot} now={now} onClose={onClose} />
  </aside>;
}
