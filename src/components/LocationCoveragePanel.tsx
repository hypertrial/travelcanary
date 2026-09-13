import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "@/lib/domain/catalog-public";
import type { LocationState} from "@/lib/domain/schemas";
import {
  locationCoveragePresentation,
  type CoveragePresentationStatus,
  type CoverageProviderPresentation,
  type LocationCoverageCategory,
} from "@/lib/coverage-presentation";
import countryInformationLinks from "../../data/country-information-links.json";
import { UiIcon, type IconName } from "./UiIcon";
import styles from "./LocationCoveragePanel.module.css";

const statusIcons: Record<Exclude<CoveragePresentationStatus, "not_applicable">, IconName> = {
  available: "check",
  limited: "attention",
  delayed: "clock",
  not_monitored: "unknown",
};

function ProviderList({ providers }: { providers: CoverageProviderPresentation[] }) {
  return <ul>{providers.map((provider) => <li key={provider.key}>
    <div className={styles.providerHeading}>
      <div><strong>{provider.name}</strong><small>{provider.role}</small></div>
      <span data-status={provider.status}>{provider.statusLabel}</span>
    </div>
    {provider.limitation && <p className={styles.providerLimitation}>{provider.limitation}</p>}
    <div className={styles.providerMeta}>
      {provider.updateLabel && <span><UiIcon name="clock" />{provider.updateLabel}</span>}
      <a href={provider.officialUrl} target="_blank" rel="noreferrer">
        Official provider site<UiIcon name="external" /><span className="sr-only"> (opens in a new tab)</span>
      </a>
    </div>
  </li>)}</ul>;
}

function CoverageRow({ category }: { category: LocationCoverageCategory }) {
  return <details className={styles.coverageRow} data-status={category.status}>
    <summary>
      <span className={styles.statusIcon}><UiIcon name={statusIcons[category.status]} /></span>
      <span className={styles.rowText}>
        <strong>{category.label}</strong>
        <small>{category.description}</small>
        <span className={styles.subchecks} aria-label={`${category.label} checks`}>
          {category.subchecks.map((subcheck) => <span key={subcheck.hazard} data-status={subcheck.status}>
            <span>{subcheck.label}</span><b>{subcheck.statusLabel}</b>
          </span>)}
        </span>
      </span>
      <span className={styles.statusLabel}>{category.statusLabel}</span>
      <UiIcon name="chevron" />
    </summary>
    <div className={styles.rowDetails}>
      {category.providers.length > 0
        ? <ProviderList providers={category.providers} />
        : <p className={styles.noProvider}>No approved live source is connected for this category.</p>}
    </div>
  </details>;
}

type LocationCoverageProps = {
  location: PublicLocation;
  state: LocationState;
  snapshot: Snapshot | null;
  now: Date;
  isFirst?: boolean;
};

export function LocationCoverageSummary({
  location,
  state,
  snapshot,
  now,
  isFirst = false,
}: LocationCoverageProps) {
  const presentation = locationCoveragePresentation({ location, state, snapshot, now });
  return <section className={styles.coveragePanel} data-first={isFirst || undefined} aria-labelledby="location-coverage-heading">
    <header className={styles.coverageHeader}>
      <span className={styles.coverageIcon}><UiIcon name="coverage" /></span>
      <div>
        <h3 id="location-coverage-heading">What TravelCanary checks for {location.name}</h3>
      </div>
    </header>
    <div className={styles.coverageSummaries}>
      <p data-status={presentation.freshness.status}>
        <span aria-hidden="true"><strong>Source updates:</strong> {presentation.freshness.visibleLabel}</span>
        <span className="sr-only">{presentation.freshness.accessibleLabel}</span>
      </p>
      <p>
        <span aria-hidden="true"><strong>Monitoring coverage:</strong> {presentation.summaryLabel}</span>
        <span className="sr-only">{presentation.accessibleSummary}</span>
      </p>
    </div>
    <p className={styles.coverageIntro}>These checks describe the sources TravelCanary monitors. They are separate from the risk result above.</p>
    {(presentation.delayed.length > 0 || presentation.gaps.length > 0) && <div className={styles.gapChips} aria-label="Current update and monitoring limitations">
      {presentation.delayed.map((category) => <span key={`delayed:${category.key}`} data-status="delayed">{category.label} · {category.statusLabel}</span>)}
      {presentation.gaps.map((category) => <span key={`gap:${category.key}`} data-status={category.status}>{category.label} · {category.statusLabel}</span>)}
    </div>}
  </section>;
}

export function LocationCoverageDetails({ location, state, snapshot, now }: LocationCoverageProps) {
  const officialLinks = countryInformationLinks[location.countryCode as keyof typeof countryInformationLinks] || [];
  const presentation = locationCoveragePresentation({ location, state, snapshot, now });
  return <section className={styles.coveragePanel} aria-labelledby="monitoring-details-heading">
    <h3 id="monitoring-details-heading" className="sr-only">Detailed monitoring information for {location.name}</h3>

    {presentation.delayed.length > 0 && <section className={styles.coverageSection} aria-labelledby="update-problems-heading">
      <h4 id="update-problems-heading">Update problems</h4>
      <div className={styles.coverageRows}>
        {presentation.delayed.map((category) => <CoverageRow key={category.key} category={category} />)}
      </div>
    </section>}

    {(presentation.gaps.length > 0 || presentation.nationalSystemGap) && <section className={styles.coverageSection} aria-labelledby="monitoring-gaps-heading">
      <h4 id="monitoring-gaps-heading">Monitoring gaps</h4>
      <div className={styles.coverageRows}>
        {presentation.gaps.map((category) => <CoverageRow key={category.key} category={category} />)}
      </div>
      {presentation.nationalSystemGap && <div className={styles.contextDetails}>
        <ProviderList providers={[presentation.nationalSystemGap]} />
      </div>}
    </section>}

    {presentation.fullyChecked.length > 0 && <details className={styles.collapsibleSection}>
      <summary>Monitored ({presentation.fullyChecked.length})<UiIcon name="chevron" /></summary>
      <div className={styles.coverageRows}>
        {presentation.fullyChecked.map((category) => <CoverageRow key={category.key} category={category} />)}
      </div>
    </details>}

    {presentation.contextProviders.length > 0 && <details className={styles.contextSection}>
      <summary>Additional context sources ({presentation.contextProviders.length})<UiIcon name="chevron" /></summary>
      <div className={styles.contextDetails}>
        <p>Context only — not an all-clear. These sources may add useful evidence, but they cannot make monitoring complete.</p>
        <ProviderList providers={presentation.contextProviders} />
      </div>
    </details>}

    {officialLinks.length > 0 && <details className={styles.contextSection}>
      <summary>Official information for {location.country}<UiIcon name="chevron" /></summary>
      <div className={styles.contextDetails}>
        <p>Check these official sources for additional warnings and local guidance. These links do not mean TravelCanary automatically monitors their information.</p>
        <ul>{officialLinks.map(({ label, url }) => <li key={url}>
          <div className={styles.providerMeta}><a href={url} target="_blank" rel="noreferrer">
            {label}<UiIcon name="external" /><span className="sr-only"> (opens in a new tab)</span>
          </a></div>
        </li>)}</ul>
      </div>
    </details>}

    <details className={styles.legend}>
      <summary>What these labels mean<UiIcon name="chevron" /></summary>
      <dl>
        <div><dt>Monitored</dt><dd>Approved sources monitor this check. See Source updates for the check time and freshness.</dd></div>
        <div><dt>Partly monitored</dt><dd>Useful information is checked, but the listed limitations prevent a complete check or all-clear.</dd></div>
        <div><dt>Context only</dt><dd>Useful context may be available, but it is not an all-clear and does not close a monitoring gap.</dd></div>
        <div><dt>Monitoring unavailable</dt><dd>No approved live monitoring source is connected. Use the linked official information.</dd></div>
      </dl>
    </details>
  </section>;
}
