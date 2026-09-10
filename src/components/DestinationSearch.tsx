import { useId, useState, type RefObject } from "react";
import { Button, ComboBox, ComboBoxStateContext, Input, Label, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { locationTypeLabels, normalizeSearchTerm, publicAccessibleLabels, publicLabels, publicSymbols, type LocationSummary, type SelectionOrigin } from "@/lib/ui-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./DestinationSearch.module.css";

function destinationToCommit(results: LocationSummary[], query: string): LocationSummary | null {
  const needle = normalizeSearchTerm(query);
  if (!needle) return null;
  const names = (summary: LocationSummary) => [summary.location.name, ...summary.location.aliases].map(normalizeSearchTerm);
  return results.find((summary) => names(summary).includes(needle))
    ?? (results.length === 1 ? results[0] : null);
}

export function DestinationSearch({
  query,
  selectedId,
  results,
  isDisabled,
  isMobile,
  inputRef,
  searchTriggerRef,
  portalContainer,
  onQueryChange,
  onSelect,
  onClear,
}: {
  query: string;
  selectedId: string | null;
  results: LocationSummary[];
  isDisabled: boolean;
  isMobile: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  searchTriggerRef: RefObject<HTMLButtonElement | null>;
  portalContainer: HTMLElement | null;
  onQueryChange: (value: string) => void;
  onSelect: (id: string, origin: SelectionOrigin, returnTarget: HTMLElement | null) => void;
  onClear: () => void;
}) {
  const descriptionId = useId();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const hasQuery = query.trim().length > 0;
  const items = results.map((summary) => ({ ...summary, id: summary.location.id }));
  const closeMobileSearch = () => {
    setMobileExpanded(false);
    inputRef.current?.blur();
    requestAnimationFrame(() => searchTriggerRef.current?.focus({ preventScroll: true }));
  };

  return <div className={styles.searchCard} data-has-query={hasQuery || undefined} data-mobile={isMobile || undefined} data-mobile-expanded={isMobile && mobileExpanded || undefined} data-ui="destination-search">
    <ComboBox
      items={items}
      inputValue={query}
      selectedKey={selectedId}
      onSelectionChange={(key) => {
        if (!key) return;
        setMobileExpanded(false);
        onSelect(String(key), "search", inputRef.current);
      }}
      menuTrigger="input"
      allowsEmptyCollection={hasQuery}
      isDisabled={isDisabled}
    >
      {isMobile && mobileExpanded && <ComboBoxStateContext.Consumer>{(state) => <div className={styles.mobileSearchHeader}><strong>Find a destination</strong>{!state?.isOpen && <button type="button" className={styles.mobileSearchClose} onClick={closeMobileSearch}><UiIcon name="close" /><span className="sr-only">Close destination search</span></button>}</div>}</ComboBoxStateContext.Consumer>}
      <div className={styles.searchMeta}>
        <Label>Where are you going?</Label>
        <span aria-hidden="true">Major hazards · next 24 hours</span>
      </div>
      <div className={styles.searchInputWrap}>
        <Button ref={searchTriggerRef} className={styles.searchTrigger} aria-label="Show destination suggestions" onPress={() => inputRef.current?.focus()}><UiIcon name="search" /></Button>
        <ComboBoxStateContext.Consumer>{(state) => <Input
          ref={inputRef}
          onChange={(event) => {
            const value = event.target.value;
            onQueryChange(value);
            if (value.trim() && state && !state.isOpen) state.open();
          }}
          onFocusCapture={() => {
            if (isMobile) setMobileExpanded(true);
          }}
          placeholder={isMobile ? "Where are you going?" : "City, island, park…"}
          aria-describedby={descriptionId}
          autoComplete="off"
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && isMobile) {
              closeMobileSearch();
              return;
            }
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (!state || state.selectionManager.focusedKey != null) return;
            const match = destinationToCommit(results, query);
            if (!match) return;
            event.preventDefault();
            event.stopPropagation();
            state.selectionManager.select(match.location.id);
          }}
        />}</ComboBoxStateContext.Consumer>
        {hasQuery && <button
          type="button"
          className={styles.clearSearch}
          aria-label="Clear destination search"
          disabled={isDisabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClear();
            inputRef.current?.focus();
          }}
        ><UiIcon name="clear" /></button>}
      </div>
      {!selectedId && <Popover isNonModal className={`${styles.searchPopover} ${isMobile && mobileExpanded ? styles.mobileSearchPopover : ""}`.trim()} placement="bottom start" offset={8} UNSTABLE_portalContainer={portalContainer || undefined}>
        {isMobile && mobileExpanded && <ComboBoxStateContext.Consumer>{(state) => <Button className={`${styles.mobileSearchClose} ${styles.popoverSearchClose}`} onPress={() => {
          state?.setFocused(false);
          state?.close();
          closeMobileSearch();
        }}><UiIcon name="close" /><span className="sr-only">Close destination search</span></Button>}</ComboBoxStateContext.Consumer>}
        <ComboBoxStateContext.Consumer>{(comboState) => <ListBox items={items} aria-label="Destination results" onPointerDownCapture={(event) => {
          if (event.pointerType === "mouse") event.preventDefault();
        }} renderEmptyState={() => <div className={styles.emptySearch}>No curated destination found. Try a nearby city, island, park, or region.</div>}>
          {({ location, state }) => <ListBoxItem
            id={location.id}
            textValue={`${location.name}, ${location.country}, ${publicAccessibleLabels[state.level]}`}
            className={styles.searchOption}
            onPointerDown={(event) => {
              if (event.pointerType !== "mouse" || event.button !== 0) return;
              event.preventDefault();
              comboState?.selectionManager.select(location.id);
            }}
          >
            <span className={styles.resultStatus} data-level={state.level} aria-hidden="true">{state.level === "NORMAL" ? <UiIcon name="search" /> : publicSymbols[state.level]}</span>
            <span className={styles.resultCopy}>
              <strong>{location.name}</strong>
              <small>{location.country} · {locationTypeLabels[location.type]}</small>
              <em>{publicLabels[state.level]}{state.level === "NORMAL" && <span className="sr-only"> in checked sources</span>}</em>
            </span>
            <UiIcon name="chevron" className={styles.resultChevron} />
          </ListBoxItem>}
        </ListBox>}</ComboBoxStateContext.Consumer>
      </Popover>}
    </ComboBox>
    <p id={descriptionId} className={styles.searchDescription}>Check major hazards now and in the next 24 hours.</p>
  </div>;
}
