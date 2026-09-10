import { expandedCheckIsCurrent } from "./expanded-source-health";
import { expandedHazardCoverage, expandedProviderApplies, isExpandedDestination } from "./expanded-coverage";
import { catalogLocationState, type PublicCatalogLocation as PublicLocation, type CatalogSnapshot as Snapshot } from "./domain/catalog-public";
import coverageJson from "../../data/coverage.json";
import {
  CoverageMatrixSchema,
  HazardTypeSchema,
  type HazardType,
  type LocationState,
  type ProviderId,
  type PublicProviderState} from "./domain/schemas";
import { providerRegistry } from "./provider-registry";
import { hazardAppliesToLocation, weatherFamily } from "./risk-policy";
import { nationalWarningManifest, nationalWarningSources } from "./national-warning-sources";
import { hazardLabels } from "./ui-presentation";

const nationalSourcesByCountry = new Map(Object.entries(nationalWarningSources));
const nationalSystemsByCountry = new Map(Object.entries(nationalWarningManifest.countries));

export type CoverageCategoryKey =
  | "weather"
  | "flood-coastal"
  | "fire"
  | "earthquake"
  | "drought"
  | "avalanche"
  | "air-quality"
  | "major-emergencies"
  | "security-conflict";

export type CoveragePresentationStatus = "available" | "limited" | "delayed" | "not_monitored" | "not_applicable";
export type CoverageStatus = "available" | "limited" | "not_monitored";
export type FreshnessStatus = "current" | "delayed";

export interface CoverageProviderPresentation {
  key: string;
  id: ProviderId;
  name: string;
  role: string;
  status: Exclude<CoveragePresentationStatus, "not_applicable">;
  statusLabel: string;
  updateLabel: string | null;
  limitation: string | null;
  officialUrl: string;
}

export interface LocationCoverageCategory {
  key: CoverageCategoryKey;
  label: string;
  status: Exclude<CoveragePresentationStatus, "not_applicable">;
  statusLabel: string;
  coverageStatus: CoverageStatus;
  freshnessStatus: FreshnessStatus;
  description: string;
  subchecks: LocationCoverageSubcheck[];
  providers: CoverageProviderPresentation[];
}

export interface LocationCoverageSubcheck {
  hazard: HazardType;
  label: string;
  status: Exclude<CoveragePresentationStatus, "not_applicable">;
  statusLabel: string;
  coverageStatus: CoverageStatus;
  freshnessStatus: FreshnessStatus;
}

export interface DestinationFreshnessPresentation {
  status: "current" | "delayed" | "unavailable";
  visibleLabel: string;
  accessibleLabel: string;
}

export interface LocationCoveragePresentation {
  categories: LocationCoverageCategory[];
  delayed: LocationCoverageCategory[];
  gaps: LocationCoverageCategory[];
  fullyChecked: LocationCoverageCategory[];
  contextProviders: CoverageProviderPresentation[];
  nationalSystemGap: CoverageProviderPresentation | null;
  freshness: DestinationFreshnessPresentation;
  summaryLabel: string;
  accessibleSummary: string;
  counts: Record<Exclude<CoveragePresentationStatus, "not_applicable">, number>;
}

export const coverageCategoryDefinitions: Array<{
  key: CoverageCategoryKey;
  label: string;
  hazards: HazardType[];
}> = [
  { key: "weather", label: "Weather", hazards: ["severe-weather", "extreme-heat", "extreme-cold", "snow-ice"] },
  { key: "flood-coastal", label: "Flooding and coastal hazards", hazards: ["flood", "coastal"] },
  { key: "fire", label: "Wildfire and fire danger", hazards: ["wildfire", "fire-danger"] },
  { key: "earthquake", label: "Earthquakes and volcanic activity", hazards: ["earthquake", "volcano"] },
  { key: "drought", label: "Drought context", hazards: ["drought"] },
  { key: "avalanche", label: "Avalanches", hazards: ["avalanche"] },
  { key: "air-quality", label: "Air quality", hazards: ["air-quality"] },
  { key: "major-emergencies", label: "Major emergencies", hazards: ["industrial", "nuclear", "civil-emergency"] },
  { key: "security-conflict", label: "Security and conflict", hazards: ["civil-unrest", "security", "terrorism", "armed-conflict"] },
];

const coverageMatrix = CoverageMatrixSchema.parse(coverageJson);
const statusLabels: Record<Exclude<CoveragePresentationStatus, "not_applicable">, string> = {
  available: "Fully checked",
  limited: "Partly checked",
  delayed: "Update delayed",
  not_monitored: "Not checked",
};

function relativeUpdatePhrase(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < -5) return null;
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function relativeUpdate(iso: string | null, now: Date): string | null {
  const phrase = relativeUpdatePhrase(iso, now);
  return phrase ? `Updated ${phrase}` : null;
}

function providerStateForLocation(snapshot: Snapshot | null, providerId: ProviderId, location: PublicLocation, now: Date): PublicProviderState | null {
  if (!snapshot || catalogLocationState(snapshot, location.id).updatePending) return null;
  const provider = snapshot.providers[providerId];
  if (!provider) return null;
  if (isExpandedDestination(location)) {
    if (!expandedProviderApplies(providerId, location)) return { ...provider, status: "disabled", lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null, partitions: undefined };
    const receipt = "expandedCoverage" in provider ? provider.expandedCoverage : undefined;
    if (!receipt) return null;
    const checked = receipt.checkedLocationIds.includes(location.id) && !receipt.unavailableLocationIds.includes(location.id);
    const current = expandedCheckIsCurrent(receipt, location.id, providerRegistry[providerId].cadenceMinutes, now);
    return { ...provider, status: receipt.status === "disabled" ? "disabled" : current ? "ok" : checked ? "delayed" : "failed",
      lastSuccess: checked ? receipt.checkedAt : null, sourceUpdatedAt: null,
      nextExpectedUpdate: null, partitions: undefined,
    };
  }
  if (!provider.partitions) return provider;
  const partition = Object.entries(provider.partitions).find(([code]) => code === location.countryCode)?.[1];
  return partition ? { ...provider, ...partition, partitions: undefined } : null;
}

function providerSatisfiesCoverage(providerId: ProviderId, location: PublicLocation, hazard?: HazardType): boolean {
  if (providerId !== "national-civil-alerts") return providerRegistry[providerId].satisfiesCoverage !== false;
  const source = nationalSourcesByCountry.get(location.countryCode);
  return Boolean(source?.enabled && source.satisfiesCoverage && (!hazard || source.hazards.includes(hazard))
    && (!source.coverageLocationIds || source.coverageLocationIds.includes(location.id)));
}

function providerDeterminesCoverage(providerId: ProviderId, location: PublicLocation, hazard: HazardType): boolean {
  const mode = providerRegistry[providerId].mode;
  return providerSatisfiesCoverage(providerId, location, hazard) && (mode === "authoritative" || mode === "complementary");
}

function providerStatus(
  providerId: ProviderId,
  snapshot: Snapshot | null,
  location: PublicLocation,
  now: Date,
): Exclude<CoveragePresentationStatus, "not_applicable"> {
  const definition = providerRegistry[providerId];
  if (definition.mode === "disabled" || definition.mode === "discovery") return "not_monitored";
  const provider = providerStateForLocation(snapshot, providerId, location, now);
  if (!provider) return "delayed";
  if (provider.status === "disabled") {
    const nationalSource = providerId === "national-civil-alerts" ? nationalSourcesByCountry.get(location.countryCode) : null;
    if (nationalSource?.enabled || provider.limitationCode === "not_yet_checked") return "delayed";
    return "not_monitored";
  }
  if (now.getTime() - Date.parse(snapshot!.generatedAt) > 30 * 60_000) return "delayed";
  if (!isExpandedDestination(location) && provider.status === "delayed"
    && definition.healthScope === "coverage"
    && !definition.hazards.some((hazard) => hazardWasDelayed(snapshot!.locations[location.id], hazard))) return "available";
  if (provider.status === "failed" || provider.status === "delayed") return "delayed";
  if (provider.status === "partial") return "limited";
  return "available";
}

function hazardWasDelayed(state: LocationState, hazard: HazardType): boolean {
  return state.delayedHazards.includes(hazard)
    || (weatherFamily.includes(hazard) && state.delayedHazards.includes("severe-weather"));
}

function categoryDescription(
  key: CoverageCategoryKey,
  status: LocationCoverageCategory["status"],
  location: PublicLocation,
  includesFireDanger: boolean,
): string {
  if (status === "delayed") return `This source is normally checked, but its latest ${location.name} update is late.`;
  if (status === "not_monitored") return `This map does not currently check ${key === "security-conflict" ? "security and conflict information" : key === "major-emergencies" ? "major emergency information" : key === "flood-coastal" ? location.isCoastal ? "flooding and coastal hazards" : "flooding" : key.replace("-", " ")} for ${location.name}.`;
  if (status === "available") {
    if (key === "earthquake") return `Current official earthquake information is available for ${location.name}.`;
    return `Current official ${key === "major-emergencies" ? "major emergency" : key === "security-conflict" ? "security" : key === "flood-coastal" ? location.isCoastal ? "flood and coastal" : "flood" : key.replace("-", " ")} checks are available for ${location.name}.`;
  }
  if (isExpandedDestination(location) && key === "earthquake") return "Earthquake reports are normally checked. Volcanic warnings are not connected.";
  switch (key) {
    case "weather": return "Official weather warnings are checked, but regional matching and related weather coverage remain incomplete.";
    case "flood-coastal": return location.isCoastal
      ? "Official flood and coastal warnings plus Copernicus-mapped emergencies are checked; satellite flood detection is candidate-directed."
      : "Official flood warnings and Copernicus-mapped emergencies are checked; satellite flood detection is candidate-directed.";
    case "fire": return includesFireDanger
      ? "Official warnings and fire-danger forecasts are checked; NASA satellite hotspot coverage can miss fires and does not confirm a perimeter."
      : "Official warnings and mapped emergency context are checked; NASA satellite hotspot coverage can miss fires and does not confirm a perimeter.";
    case "earthquake": return "Current official earthquake events are checked, but local intensity evidence may be incomplete.";
    case "drought": return "Copernicus agricultural drought context is available, but it is not an immediate emergency-warning service.";
    case "avalanche": return "Available official warnings are checked, but dedicated regional avalanche bulletins are not enabled.";
    case "air-quality": return "Some official air-quality information is available, but current index coverage is incomplete.";
    case "major-emergencies": return "Copernicus-mapped emergencies are checked, but this is not a complete civil, industrial, or nuclear alert service.";
    case "security-conflict": return "Some official emergency context is checked, but security, unrest, terrorism, and conflict coverage is incomplete.";
  }
}

function providerPresentation(
  providerId: ProviderId,
  snapshot: Snapshot | null,
  location: PublicLocation,
  now: Date,
): CoverageProviderPresentation {
  const definition = providerRegistry[providerId];
  const state = providerStateForLocation(snapshot, providerId, location, now);
  const status = providerStatus(providerId, snapshot, location, now);
  const nationalSource = providerId === "national-civil-alerts" ? nationalSourcesByCountry.get(location.countryCode) : null;
  const nationalLimitation = nationalSource
    ? nationalWarningLimitation(
      state?.limitationCode === "not_available_in_snapshot_v2"
        ? state.limitationCode
        : nationalSource.limitationCode || state?.limitationCode || null,
    )
    : null;
  return {
    key: providerId,
    id: providerId,
    name: nationalSource?.systemName || definition.displayName,
    role: providerSatisfiesCoverage(providerId, location) ? definition.roleLabel : "Context only",
    status,
    statusLabel: statusLabels[status],
    updateLabel: isExpandedDestination(location)
      ? state?.lastSuccess ? `Checked ${relativeUpdatePhrase(state.lastSuccess, now) || "time unavailable"}` : null
      : relativeUpdate(state?.sourceUpdatedAt || state?.lastSuccess || null, now),
    limitation: nationalSource && !providerSatisfiesCoverage(providerId, location)
      ? `${nationalLimitation ? `${nationalLimitation} ` : ""}Context only; this source does not establish complete monitoring.`
      : nationalSource && !nationalSource.enabled ? nationalLimitation : definition.limitation,
    officialUrl: nationalSource?.officialUrl || definition.officialUrl,
  };
}

function fallbackTransportPresentations(
  snapshot: Snapshot | null,
  location: PublicLocation,
  now: Date,
  hazards: HazardType[],
): CoverageProviderPresentation[] {
  const transports = Object.entries(snapshot?.providers.meteoalarm.partitions || {}).find(([code]) => code === location.countryCode)?.[1].transports || [];
  const systems = (nationalSystemsByCountry.get(location.countryCode)?.systems || []);
  return transports.filter(({ id, role }) => role === "fallback"
    && systems.some((system) => system.id === id && system.hazards.some((hazard) => hazards.includes(hazard)))).map((transport) => {
    const delayed = transport.status === "failed" || transport.status === "delayed";
    const disabled = transport.status === "disabled";
    const status = disabled ? "not_monitored" : delayed ? "delayed" : transport.status === "partial" ? "limited" : "available";
    return {
      key: `meteoalarm:${transport.id}`, id: "meteoalarm", name: transport.name,
      role: "National-authority fallback", status, statusLabel: disabled ? "Not enabled" : delayed ? "Update delayed" : "Fallback ready",
      updateLabel: relativeUpdate(transport.sourceUpdatedAt, now),
      limitation: "Used only when the matching MeteoAlarm country feed fails. Recovery remains partial and does not add monitoring coverage.",
      officialUrl: transport.officialUrl,
    };
  });
}

function contextProviderPresentation(
  providerId: ProviderId,
  snapshot: Snapshot | null,
  location: PublicLocation,
  now: Date,
): CoverageProviderPresentation {
  const definition = providerRegistry[providerId];
  const state = providerStateForLocation(snapshot, providerId, location, now);
  const delayed = !state || state.status === "failed" || state.status === "delayed";
  const disabled = definition.mode === "disabled" || state?.status === "disabled";
  const nationalSource = providerId === "national-civil-alerts" ? nationalSourcesByCountry.get(location.countryCode) : null;
  const nationalLimitation = nationalSource
    ? nationalWarningLimitation(nationalSource.limitationCode || state?.limitationCode || null)
    : null;
  const status = disabled ? "not_monitored" : delayed ? "delayed" : state?.status === "partial" ? "limited" : "available";
  return {
    key: providerId,
    id: providerId,
    name: nationalSource?.systemName || definition.displayName,
    role: "Additional context",
    status,
    statusLabel: disabled ? "Not enabled" : delayed ? "Update delayed" : "Context available",
    updateLabel: isExpandedDestination(location)
      ? state?.lastSuccess ? `Checked ${relativeUpdatePhrase(state.lastSuccess, now) || "time unavailable"}` : null
      : relativeUpdate(state?.sourceUpdatedAt || state?.lastSuccess || null, now),
    limitation: nationalSource
      ? `${nationalLimitation ? `${nationalLimitation} ` : ""}May add useful evidence, but does not establish complete monitoring coverage.`
      : definition.limitation,
    officialUrl: nationalSource?.officialUrl || definition.officialUrl,
  };
}

function nationalSystemGapPresentation(location: PublicLocation): CoverageProviderPresentation | null {
  const country = nationalSystemsByCountry.get(location.countryCode);
  if (!country) return null;
  const hasCoverage = country.systems.some((system) => system.status === "active" && system.role === "coverage"
    && system.coverageContribution !== "none" && (!system.coverageLocationIds || system.coverageLocationIds.includes(location.id)));
  if (hasCoverage) return null;
  const system = country.systems.find(({ status, coverageLocationIds }) => status !== "active"
    && Boolean(coverageLocationIds?.includes(location.id)))
    || country.systems.find(({ status, role, coverageLocationIds }) => status !== "active" && role !== "blocked" && !coverageLocationIds)
    || country.systems.find(({ role }) => role === "blocked")
    || country.systems.find(({ status }) => status !== "active");
  if (!system) return null;
  return {
    key: `national-gap:${system.id}`, id: "national-civil-alerts", name: "National system not connected",
    role: system.systemName, status: "not_monitored", statusLabel: "Not checked", updateLabel: null,
    limitation: `${system.blocker || "No approved live reader transport is connected."} Reviewed ${country.reviewedAt}.`,
    officialUrl: system.officialUrl,
  };
}

function nationalWarningLimitation(code: string | null): string {
  switch (code) {
    case "no_supported_machine_feed":
      return "The public warning system does not provide a supported machine-readable event feed for automatic scoring.";
    case "undocumented_machine_feed":
      return "A browser service exists, but no documented and supported machine feed is approved for automatic scoring.";
    case "insufficient_geometry_or_lifecycle":
      return "Available machine output lacks reliable destination geometry, severity, or alert lifecycle data.";
    case "future_feed_announced":
      return "A supported machine-readable feed has been announced but is not yet available for automatic scoring.";
    case "repository_not_production_feed":
      return "Official reusable artifacts exist, but they do not establish a current, complete production alert feed.";
    case "no_nonempty_vma_fixture_or_structured_severity":
      return "The official feed is reusable, but automatic severity and lifecycle behavior have not been verified with a representative alert.";
    case "not_available_in_snapshot_v2":
      return "Country-specific national warning status is not available in this older data snapshot.";
    default:
      return "No official keyless event feed has passed the reuse, severity, and lifecycle checks for automatic scoring.";
  }
}

function categoryApplies(key: CoverageCategoryKey, location: PublicLocation): boolean {
  if (key !== "avalanche" || isExpandedDestination(location)) return true;
  return location.type === "mountain" || Boolean(coverageMatrix.locationOverrides[location.id]?.avalanche);
}

function freshnessPresentation(
  snapshot: Snapshot | null,
  hasDelayedCoverage: boolean,
  now: Date,
): DestinationFreshnessPresentation {
  const relative = relativeUpdatePhrase(snapshot?.generatedAt || null, now);
  if (!snapshot) return {
    status: "unavailable",
    visibleLabel: "Updates unavailable",
    accessibleLabel: "Source updates unavailable. Last update time unavailable.",
  };
  if (hasDelayedCoverage) return {
    status: "delayed",
    visibleLabel: relative ? `Some updates delayed · last updated ${relative}` : "Some updates delayed · last update time unavailable",
    accessibleLabel: relative ? `Some source updates are delayed. Last updated ${relative}.` : "Some source updates are delayed. Last update time unavailable.",
  };
  return {
    status: "current",
    visibleLabel: relative ? `Current · updated ${relative}` : "Current · update time unavailable",
    accessibleLabel: relative ? `Source updates are current. Updated ${relative}.` : "Source updates are current. Update time unavailable.",
  };
}

export function locationCoveragePresentation({
  location,
  state,
  snapshot,
  now,
}: {
  location: PublicLocation;
  state: LocationState;
  snapshot: Snapshot | null;
  now: Date;
}): LocationCoveragePresentation {
  const countryCoverage = Object.entries(coverageMatrix.countries).find(([code]) => code === location.countryCode)?.[1].hazards
    || Object.fromEntries(HazardTypeSchema.options.map((hazard) => [hazard, { status: "not_monitored" as const, providerIds: [] as ProviderId[] }])) as Record<HazardType, { status: "not_monitored"; providerIds: ProviderId[] }>;
  const locationOverrides = coverageMatrix.locationOverrides[location.id] || {};
  const expanded = isExpandedDestination(location);
  const coverage = expanded ? expandedHazardCoverage(location) : { ...countryCoverage, ...locationOverrides };

  const categories = coverageCategoryDefinitions.flatMap((definition): LocationCoverageCategory[] => {
    if (!categoryApplies(definition.key, location)) return [];
    const hazards = definition.hazards.filter((hazard) => expanded ? hazard !== "coastal" || location.isCoastal
      : hazardAppliesToLocation(hazard, location) || (hazard === "volcano" && state.hazards.some((incident) => incident.type === "volcano")));
    if (hazards.length === 0) return [];
    const subchecks = hazards.map((hazard): LocationCoverageSubcheck => {
      const entry = coverage[hazard];
      let coverageStatus: CoverageStatus = "not_monitored";
      let primaryStatuses: Array<Exclude<CoveragePresentationStatus, "not_applicable">> = [];
      if (entry.status !== "not_monitored") {
        const primaryProviders = entry.providerIds.filter((providerId) => providerDeterminesCoverage(providerId, location, hazard));
        if (primaryProviders.length > 0) {
          const locationHasGap = state.coverageGaps.includes(hazard)
            || (weatherFamily.includes(hazard) && state.coverageGaps.includes("severe-weather"));
          primaryStatuses = primaryProviders.map((providerId) => providerStatus(providerId, snapshot, location, now));
          coverageStatus = entry.status === "partial" || locationHasGap
            ? "limited"
            : "available";
        }
      }
      const freshnessStatus: FreshnessStatus = hazardWasDelayed(state, hazard)
        || primaryStatuses.some((candidate) => candidate === "delayed")
        ? "delayed"
        : "current";
      const status = freshnessStatus === "delayed" ? "delayed" : coverageStatus;
      return {
        hazard, label: hazardLabels[hazard], status, statusLabel: statusLabels[status], coverageStatus, freshnessStatus,
      };
    });
    const hazardStatuses = subchecks.map(({ coverageStatus }) => coverageStatus);
    const coverageStatus: CoverageStatus = hazardStatuses.includes("limited")
      || (hazardStatuses.includes("available") && hazardStatuses.includes("not_monitored"))
      ? "limited"
      : hazardStatuses.every((candidate) => candidate === "not_monitored")
        ? "not_monitored"
        : "available";
    const freshnessStatus: FreshnessStatus = subchecks.some((subcheck) => subcheck.freshnessStatus === "delayed")
      ? "delayed"
      : "current";
    const status = freshnessStatus === "delayed" ? "delayed" : coverageStatus;
    const providerIds = [...new Set(hazards.flatMap((hazard) => coverage[hazard].providerIds))]
      .filter((providerId) => hazards.some((hazard) => coverage[hazard].providerIds.includes(providerId)
        && providerDeterminesCoverage(providerId, location, hazard)));
    const includesFireDanger = hazards.includes("fire-danger");
    return [{
      key: definition.key,
      label: definition.key === "flood-coastal" && !location.isCoastal
        ? "Flooding"
        : definition.key === "earthquake" && !hazards.includes("volcano")
          ? "Earthquakes"
          : definition.label,
      status,
      statusLabel: statusLabels[status],
      coverageStatus,
      freshnessStatus,
      description: categoryDescription(definition.key, status, location, includesFireDanger),
      subchecks,
      providers: providerIds.flatMap((providerId) => [
        providerPresentation(providerId, snapshot, location, now),
        ...(providerId === "meteoalarm" ? fallbackTransportPresentations(snapshot, location, now, subchecks.map(({ hazard }) => hazard)) : []),
      ]),
    }];
  });

  const counts = {
    available: categories.filter(({ coverageStatus, freshnessStatus }) => coverageStatus === "available" && (!expanded || freshnessStatus === "current")).length,
    limited: categories.filter(({ coverageStatus, freshnessStatus }) => coverageStatus === "limited" && (!expanded || freshnessStatus === "current")).length,
    delayed: categories.filter(({ freshnessStatus }) => freshnessStatus === "delayed").length,
    not_monitored: categories.filter(({ coverageStatus }) => coverageStatus === "not_monitored").length,
  };
  const summaryParts = [
    `${counts.available} fully checked`,
    `${counts.limited} partly checked`,
    `${counts.not_monitored} not checked`,
    ...(expanded && counts.delayed ? [`${counts.delayed} checks delayed`] : []),
  ];
  const applicableHazards = new Set(categories.flatMap(({ subchecks }) => subchecks.map(({ hazard }) => hazard)));
  const matrixProviderIds = new Set(categories.flatMap(({ subchecks }) => subchecks.flatMap(({ hazard }) => coverage[hazard].providerIds)));
  const contextProviderIds = (Object.keys(providerRegistry) as ProviderId[]).filter((providerId) => {
    if (expanded && !expandedProviderApplies(providerId, location)) return false;
    const provider = providerRegistry[providerId];
    if (provider.hazards.length === 0 || !provider.hazards.some((hazard) => applicableHazards.has(hazard))) return false;
    return provider.satisfiesCoverage === false || provider.mode === "discovery" || provider.mode === "fallback" || provider.mode === "disabled"
      || (matrixProviderIds.has(providerId) && !providerSatisfiesCoverage(providerId, location));
  });
  const delayed = categories.filter(({ freshnessStatus }) => freshnessStatus === "delayed").map((category) => {
    const delayedSubchecks = category.subchecks.filter(({ freshnessStatus }) => freshnessStatus === "delayed")
      .map((subcheck) => ({ ...subcheck, status: "delayed" as const, statusLabel: statusLabels.delayed }));
    const delayedHazards = new Set(delayedSubchecks.map(({ hazard }) => hazard));
    const delayedProviderIds = new Set(delayedSubchecks.flatMap(({ hazard }) => coverage[hazard].providerIds));
    return {
      ...category,
      status: "delayed" as const,
      statusLabel: statusLabels.delayed,
      description: categoryDescription(category.key, "delayed", location, delayedHazards.has("fire-danger")),
      subchecks: delayedSubchecks,
      providers: category.providers
        .filter((provider) => delayedProviderIds.has(provider.id) && provider.status !== "available")
        .map((provider) => ({ ...provider, status: "delayed" as const, statusLabel: statusLabels.delayed })),
    };
  });
  const gaps = categories.filter(({ coverageStatus }) => coverageStatus === "limited" || coverageStatus === "not_monitored")
    .map((category) => ({
      ...category,
      status: category.coverageStatus,
      statusLabel: statusLabels[category.coverageStatus],
      description: categoryDescription(category.key, category.coverageStatus, location, category.subchecks.some(({ hazard }) => hazard === "fire-danger")),
      subchecks: category.subchecks.map((subcheck) => ({
        ...subcheck,
        status: subcheck.coverageStatus,
        statusLabel: statusLabels[subcheck.coverageStatus],
      })),
    }));
  const fullyChecked = categories.filter(({ coverageStatus, freshnessStatus }) => coverageStatus === "available" && freshnessStatus === "current")
    .map((category) => ({ ...category, status: "available" as const, statusLabel: statusLabels.available }));
  let freshnessSnapshot = catalogLocationState(snapshot, location.id).updatePending ? null : snapshot;
  if (expanded && freshnessSnapshot) {
    const checks = (["usgs", "slf-avalanche"] as const).filter((providerId) => expandedProviderApplies(providerId, location))
      .map((providerId) => providerStateForLocation(snapshot, providerId, location, now)?.lastSuccess)
      .filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a));
    freshnessSnapshot = checks.length ? { ...freshnessSnapshot, generatedAt: checks[0] } : null;
  }
  const freshness = freshnessPresentation(freshnessSnapshot, delayed.length > 0, now);
  return {
    categories,
    delayed,
    gaps,
    fullyChecked,
    contextProviders: contextProviderIds.filter((providerId) => providerId !== "national-civil-alerts"
      || (nationalSystemsByCountry.get(location.countryCode)?.systems || []).some((system) => system.status === "active" && system.role === "context"))
      .map((providerId) => contextProviderPresentation(providerId, snapshot, location, now)),
    nationalSystemGap: nationalSystemGapPresentation(location),
    freshness,
    summaryLabel: summaryParts.join(" · "),
    accessibleSummary: `Monitoring coverage: ${summaryParts.join(", ")}.`,
    counts,
  };
}

export function validateCoverageCategoryDefinitions(): boolean {
  const grouped = coverageCategoryDefinitions.flatMap(({ hazards }) => hazards).sort();
  return grouped.length === HazardTypeSchema.options.length
    && grouped.every((hazard, index) => hazard === [...HazardTypeSchema.options].sort()[index]);
}
