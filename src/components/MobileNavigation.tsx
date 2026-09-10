import type { AppView } from "@/lib/app-navigation";
import { UiIcon } from "./UiIcon";
import styles from "./MobileNavigation.module.css";

export function MobileNavigation({ view, itemCount, itemCountLabel, onChange }: { view: AppView; itemCount: number | null; itemCountLabel: string; onChange: (view: AppView) => void }) {
  return <nav className={styles.navigation} aria-label="Primary navigation">
    <button type="button" aria-current={view === "map" ? "page" : undefined} onClick={() => onChange("map")}>
      <UiIcon name="map" /><span>Map</span>
    </button>
    <button type="button" aria-label={`Alerts${itemCount === null ? "" : `, ${itemCount} ${itemCountLabel}`}`} aria-current={view === "alerts" ? "page" : undefined} onClick={() => onChange("alerts")}>
      <span className={styles.iconWithCount}><UiIcon name="list" />{itemCount !== null && itemCount > 0 && <b>{itemCount > 99 ? "99+" : itemCount}</b>}</span><span>Alerts</span>
    </button>
  </nav>;
}
