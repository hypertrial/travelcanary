import Image from "next/image";
import type { LiveStatusPresentation, UiDataState } from "@/lib/ui-presentation";
import { UiIcon } from "./UiIcon";
import { AppMenu } from "./AppMenu";
import type { InstallPlatform } from "@/lib/install-presentation";
import styles from "./AppChrome.module.css";

export function AppHeader({ status, compact, installPlatform, installed }: { status: LiveStatusPresentation; compact: boolean; installPlatform: InstallPlatform; installed: boolean }) {
  return <header className={styles.topbar}>
    <h1 className="sr-only">TravelCanary — current Europe location risk</h1>
    {/* A document link avoids loading the client router solely for the static brand home link. */}
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
    <a className={styles.brand} href="/" aria-label="TravelCanary, current Europe location risk. Alpha preview">
      <span className={styles.brandMarkWrap} aria-hidden="true">
        <Image className={styles.brandMark} src="/brand/logo-icon.png" alt="" width={32} height={32} priority unoptimized />
      </span>
      <span className={styles.wordmark} aria-hidden="true">
        <strong><span className={styles.travel}>Travel</span><span className={styles.canary}>Canary</span></strong>
        <small>ALPHA · PREVIEW</small>
      </span>
    </a>
    <div className={styles.headerActions}>
      <div className={styles.liveStatus} data-tone={status.tone} role="status" aria-label={status.accessibleLabel}>
        <span className={styles.liveDot} aria-hidden="true" />
        <span className={styles.desktopLiveLabel} aria-hidden="true">{status.desktopLabel}</span>
        <span className={styles.compactLiveCopy} aria-hidden="true">
          <span className={styles.liveLabel}>{status.label}</span>
          {status.detail && <span className={styles.liveDetail}>{status.detail}</span>}
        </span>
      </div>
      <AppMenu compact={compact} platform={installPlatform} installed={installed} />
    </div>
  </header>;
}

export function DataHealthBanner({
  state,
  message,
  onRetry,
}: {
  state: UiDataState;
  message: string | null;
  onRetry: () => void;
}) {
  if (!(["catalog-unavailable", "snapshot-unavailable", "refresh-delayed"] as UiDataState[]).includes(state)) return null;

  const content = state === "catalog-unavailable"
    ? { title: "Destinations unavailable.", detail: message || "The destination catalog could not be loaded." }
    : state === "snapshot-unavailable"
      ? { title: "Live updates unavailable.", detail: message || "Check official local sources before relying on this map." }
      : { title: "Updates may be delayed.", detail: message || "Previously loaded alerts remain visible while we try again." };
  const toneClass = state === "catalog-unavailable" || state === "snapshot-unavailable"
    ? styles[`healthBanner_${state}`]
    : "";

  return <div className={`${styles.healthBanner} ${toneClass}`.trim()} role="status" data-ui="data-health-banner">
    <UiIcon name={state === "snapshot-unavailable" ? "unknown" : "attention"} />
    <p><strong>{content.title}</strong> {content.detail}</p>
    <button type="button" onClick={onRetry}>Retry</button>
  </div>;
}

export function ConnectivityBanner({ online }: { online: boolean }) {
  if (online) return null;
  return <div className={styles.offlineBanner} role="status" data-ui="offline-banner">
    <UiIcon name="unknown" />
    <p><strong>Offline.</strong> Live information cannot refresh. Already loaded information keeps its original timestamps.</p>
  </div>;
}
