import { useRef, useState } from "react";
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay, Popover } from "react-aria-components";
import { publicLabels, publicSymbols, type AttentionPresentation, type SelectionOrigin } from "@/lib/ui-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./AttentionTray.module.css";

function AttentionList({
  presentation,
  close,
  onSelect,
  returnTarget,
}: {
  presentation: AttentionPresentation;
  close: () => void;
  onSelect: (id: string, origin: SelectionOrigin, returnTarget: HTMLElement | null) => void;
  returnTarget: HTMLElement | null;
}) {
  return <div className={styles.attentionContent}>
    <div className={styles.overlayHeading}>
      <span className={styles.overlayIcon}><UiIcon name="attention" /></span>
      <div><Heading slot="title">Destinations needing attention</Heading><p>Prioritized by the action a traveler may need to take.</p></div>
    </div>
    {presentation.globalUnavailable ? <div className={styles.attentionEmpty} data-tone="unavailable"><span aria-hidden="true">?</span><h3>{presentation.total ? "Updates unavailable" : "Destinations unavailable"}</h3><p>{presentation.total ? `Current alerts could not be confirmed for ${presentation.total} destinations. Search a place to open its briefing, or check official local sources.` : "The destination list could not be loaded. Retry or check official local sources."}</p></div> : presentation.total > 0 ? <div className={styles.attentionGroups}>{presentation.groups.map((group) => <section key={group.key} aria-labelledby={`attention-${group.key}`}>
      <h3 id={`attention-${group.key}`}><span>{group.label}</span><span>{group.items.length}</span></h3>
      <ul className={styles.attentionList}>{group.items.map(({ location, state }) => <li key={location.id}>
        <button type="button" onClick={() => {
          close();
          onSelect(location.id, "attention", returnTarget);
        }}>
          <span className={styles.attentionStatus} data-level={state.level} aria-hidden="true">{publicSymbols[state.level]}</span>
          <span className={styles.attentionPlace}><strong>{location.name}</strong><small>{location.country}{"timing" in state ? ` · ${state.timing === "ACTIVE" ? "Active now" : "Starts soon"}` : ""}</small></span>
          <span className="sr-only">{publicLabels[state.level]}</span>
        </button>
      </li>)}</ul>
    </section>)}</div> : <div className={styles.attentionEmpty}><span aria-hidden="true">✓</span><strong>No destinations are currently flagged.</strong><p>This does not mean every hazard is monitored or that no danger exists.</p></div>}
  </div>;
}

export function AttentionTray({
  presentation,
  isCompact,
  isLoading,
  portalContainer,
  onSelect,
}: {
  presentation: AttentionPresentation;
  isCompact: boolean;
  isLoading: boolean;
  portalContainer: HTMLElement | null;
  onSelect: (id: string, origin: SelectionOrigin, returnTarget: HTMLElement | null) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const catalogUnavailable = presentation.globalUnavailable && presentation.total === 0;
  const trigger = <Button
    ref={triggerRef}
    className={`${styles.mapAction} ${styles.railAttentionAction}`}
    isDisabled={isLoading || catalogUnavailable}
    onPress={() => isCompact && setMobileOpen(true)}
    aria-label={isLoading ? "Checking destinations for current alerts." : catalogUnavailable ? presentation.accessibleLabel : `${presentation.accessibleLabel} Open destinations needing attention`}
  >
    <span className={styles.mapActionIcon}><UiIcon name={isLoading ? "clock" : "attention"} /></span>
    <span className={styles.mapActionCopy}>
      <span className={styles.mapActionLabel}>{isLoading ? "Checking destinations" : presentation.railTitle}</span>
      <span className={styles.mapActionDetail}>{isLoading ? "Looking for current alerts" : presentation.railDetail}</span>
    </span>
    <span className={styles.compactMapActionLabel} aria-hidden="true">{isLoading ? "Checking" : presentation.compactLabel}</span>
    {!catalogUnavailable && <UiIcon name="chevron" className={styles.mapActionChevron} />}
  </Button>;

  if (isCompact) return <>
    {trigger}
    <ModalOverlay isOpen={mobileOpen} onOpenChange={setMobileOpen} isDismissable className={styles.modalOverlay}>
      <Modal className={styles.attentionModal}>
        <Dialog className={styles.overlayDialog}>{({ close }) => <>
          <Button slot="close" className={styles.overlayClose} aria-label="Close destinations needing attention"><UiIcon name="close" /></Button>
          <AttentionList presentation={presentation} close={close} onSelect={onSelect} returnTarget={triggerRef.current} />
        </>}</Dialog>
      </Modal>
    </ModalOverlay>
  </>;

  return <DialogTrigger>
    {trigger}
    <Popover isNonModal className={styles.attentionPopover} placement="top start" offset={10} UNSTABLE_portalContainer={portalContainer || undefined}>
      <Dialog className={styles.overlayDialog}>{({ close }) => <AttentionList presentation={presentation} close={close} onSelect={onSelect} returnTarget={triggerRef.current} />}</Dialog>
    </Popover>
  </DialogTrigger>;
}

function MapKeyBody() {
  return <>
    <Heading slot="title">Map key</Heading>
    <p className={styles.legendIntro}>All alerts shows Be aware, Consider changing plans, and Emergency conditions destinations. Use High &amp; Severe to focus on the strongest alerts, or Updates unavailable for places without confirmed updates. Counts are destinations, not incidents. Search and the attention list still reach every place; a searched place appears regardless of the filter.</p>
    <ul>
      <li>
        <span className={styles.legendLand} data-coverage="covered" aria-hidden="true" />
        <span><strong>Catalog countries</strong><small>Monitoring varies by destination</small></span>
      </li>
      <li>
        <span className={styles.legendLand} data-coverage="outside" aria-hidden="true" />
        <span><strong>Outside TravelCanary</strong><small>Cooler land is outside the catalog</small></span>
      </li>
      {(["NORMAL", "ELEVATED", "HIGH", "SEVERE", "UNKNOWN"] as const).map((level) => <li key={level}><span className={styles.legendSymbol} data-level={level}>{level === "NORMAL" ? <UiIcon name="search" /> : publicSymbols[level]}</span><span><strong>{publicLabels[level]}</strong>{level === "NORMAL" && <small>In checked sources</small>}{level === "UNKNOWN" && <small>Current information could not be confirmed</small>}</span></li>)}
    </ul>
  </>;
}

export function MapLegend({
  portalContainer,
  isCompact,
}: {
  portalContainer: HTMLElement | null;
  isCompact: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const trigger = <Button
    className={`${styles.mapAction} ${styles.mapKeyAction}`}
    aria-label="Open map key"
    onPress={() => isCompact && setMobileOpen(true)}
  ><span className={styles.mapActionIcon}><UiIcon name="map" /></span><span>Map key</span></Button>;

  if (isCompact) return <>
    {trigger}
    <ModalOverlay isOpen={mobileOpen} onOpenChange={setMobileOpen} isDismissable className={styles.modalOverlay}>
      <Modal className={styles.legendModal}>
        <Dialog className={styles.legendDialog}>
          <Button slot="close" className={styles.overlayClose} aria-label="Close map key"><UiIcon name="close" /></Button>
          <MapKeyBody />
        </Dialog>
      </Modal>
    </ModalOverlay>
  </>;

  return <DialogTrigger>
    {trigger}
    <Popover className={styles.legendPopover} placement="top start" offset={10} UNSTABLE_portalContainer={portalContainer || undefined}>
      <Dialog className={styles.legendDialog}><MapKeyBody /></Dialog>
    </Popover>
  </DialogTrigger>;
}
