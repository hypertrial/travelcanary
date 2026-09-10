import { aliases as countryAliases } from "../../data/country-identities.json";
import { catalogLocationState, type PublicCatalogLocation as PublicLocation, type CatalogSnapshot as Snapshot } from "./domain/catalog-public";
import type {
  HazardType,
  LocationState,
  PublicHazard} from "./domain/schemas";
import type { DataMode } from "./config";
import { providerRegistry } from "./provider-registry";

function unavailableLocationState(): LocationState {
  return {
    level: "UNKNOWN",
    coverage: "delayed",
    coverageGaps: ["severe-weather", "wildfire", "earthquake", "civil-emergency"],
    delayedHazards: ["severe-weather", "wildfire", "earthquake", "civil-emergency"],
    hazards: [],
  };
}

export type SelectionOrigin = "search" | "map" | "attention" | "alerts" | "directory";
export type RiskLevel = LocationState["level"];
export type UiDataState =
  | "initial-loading"
  | "ready"
  | "refresh-delayed"
  | "snapshot-unavailable"
  | "catalog-unavailable"
  | "tiles-unavailable";

export interface LocationSummary {
  location: PublicLocation;
  state: LocationState;
}

export type LiveStatusTone = "live" | "loading" | "demo" | "delayed" | "unavailable";

export interface LiveStatusPresentation {
  tone: LiveStatusTone;
  label: string;
  detail?: string;
  desktopLabel: string;
  accessibleLabel: string;
}

export interface SelfHostedInstanceStatus {
  health: string;
  restrictedSources: { active: boolean };
}

export function parseSelfHostedInstanceStatus(value: unknown): SelfHostedInstanceStatus | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { health?: unknown; restrictedSources?: { active?: unknown } };
  return typeof candidate.health === "string" && typeof candidate.restrictedSources?.active === "boolean"
    ? { health: candidate.health, restrictedSources: { active: candidate.restrictedSources.active } }
    : null;
}

export function unavailableInstanceStatus(previous: SelfHostedInstanceStatus | null): SelfHostedInstanceStatus {
  return { health: "unavailable", restrictedSources: { active: previous?.restrictedSources.active ?? false } };
}

export type AttentionActionKey = "emergency" | "change-plans" | "be-aware" | "unavailable";

export interface AttentionActionGroup {
  key: AttentionActionKey;
  label: string;
  level: Exclude<RiskLevel, "NORMAL">;
  items: LocationSummary[];
}

export interface AttentionPresentation {
  groups: AttentionActionGroup[];
  total: number;
  label: string;
  compactLabel: string;
  railTitle: string;
  railDetail: string;
  accessibleLabel: string;
  globalUnavailable: boolean;
}

export const publicLabels: Record<RiskLevel, string> = {
  NORMAL: "No major alert found",
  ELEVATED: "Be aware",
  HIGH: "Consider changing plans",
  SEVERE: "Emergency conditions",
  UNKNOWN: "Updates unavailable",
};

export const publicAccessibleLabels: Record<RiskLevel, string> = {
  ...publicLabels,
  NORMAL: "No major alert found in checked sources",
};

export const publicSymbols: Record<RiskLevel, string> = {
  NORMAL: "✓",
  ELEVATED: "!",
  HIGH: "!",
  SEVERE: "!!",
  UNKNOWN: "?",
};

export const locationTypeLabels: Record<PublicLocation["type"], string> = {
  capital: "Capital city",
  city: "City",
  resort: "Resort area",
  island: "Island",
  park: "National park",
  mountain: "Mountain region",
  coastal: "Coastal destination",
};

export const hazardLabels: Record<HazardType, string> = {
  "severe-weather": "Severe weather",
  flood: "Flooding",
  "extreme-heat": "Extreme heat",
  "extreme-cold": "Extreme cold",
  wildfire: "Active wildfire",
  "fire-danger": "Fire danger",
  "air-quality": "Air quality",
  earthquake: "Earthquake activity",
  volcano: "Volcanic activity",
  drought: "Drought",
  "snow-ice": "Snow and ice",
  avalanche: "Avalanche",
  coastal: "Coastal hazards",
  "civil-unrest": "Civil unrest",
  security: "Security incidents",
  terrorism: "Terrorism",
  "armed-conflict": "Armed conflict",
  industrial: "Industrial emergencies",
  nuclear: "Nuclear emergencies",
  "civil-emergency": "Civil emergencies",
};

const attentionGroups: Array<{
  key: AttentionActionKey;
  label: string;
  level: Exclude<RiskLevel, "NORMAL">;
}> = [
  { key: "emergency", label: "Emergency conditions", level: "SEVERE" },
  { key: "change-plans", label: "Consider changing plans", level: "HIGH" },
  { key: "be-aware", label: "Be aware", level: "ELEVATED" },
  { key: "unavailable", label: "Updates unavailable", level: "UNKNOWN" },
];

function plural(count: number, singular: string, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function relativeUpdateTime(iso: string, now: Date): string | null {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < -5) return null;
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

export function liveStatusPresentation({
  mode,
  uiState,
  generatedAt,
  now,
}: {
  mode: DataMode;
  uiState: UiDataState;
  generatedAt: string | null;
  now: Date;
}): LiveStatusPresentation {
  if (uiState === "initial-loading") {
    return { tone: "loading", label: "Loading", detail: "updates", desktopLabel: "Checking updates", accessibleLabel: "Loading updates." };
  }
  if (mode === "demo") {
    return { tone: "demo", label: "Demo data", detail: "Not live", desktopLabel: "Demo · not live", accessibleLabel: "Demo data. Not live." };
  }
  if (uiState === "catalog-unavailable" || uiState === "snapshot-unavailable" || !generatedAt) {
    return { tone: "unavailable", label: "Updates", detail: "unavailable", desktopLabel: "Unavailable", accessibleLabel: "Live updates unavailable." };
  }
  const relative = relativeUpdateTime(generatedAt, now);
  if (uiState === "refresh-delayed") {
    return {
      tone: "delayed",
      label: "Delayed",
      detail: relative || "Time unavailable",
      desktopLabel: `Delayed · ${relative || "time unavailable"}`,
      accessibleLabel: relative ? `Updates delayed. Last updated ${relative}.` : "Updates delayed. Last update time unavailable.",
    };
  }
  return {
    tone: "live",
    label: "Live",
    detail: relative || "Time unavailable",
    desktopLabel: `Live · ${relative || "time unavailable"}`,
    accessibleLabel: relative ? `Live information. Updated ${relative}.` : "Live information. Update time unavailable.",
  };
}

const riskRank: Record<RiskLevel, number> = {
  NORMAL: 0,
  UNKNOWN: 1,
  ELEVATED: 2,
  HIGH: 3,
  SEVERE: 4,
};

export function locationState(snapshot: Snapshot | null, locationId: string): LocationState {
  return snapshot ? catalogLocationState(snapshot, locationId).state : unavailableLocationState();
}

export function normalizeSearchTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function searchScore(location: PublicLocation, needle: string): number | null {
  const names = [location.name, ...location.aliases].map(normalizeSearchTerm);
  const countries = [location.country, ...((countryAliases as Partial<Record<string, string[]>>)[location.countryCode] || [])].map(normalizeSearchTerm);
  const type = normalizeSearchTerm(locationTypeLabels[location.type]);

  if (names.some((name) => name === needle)) return 0;
  if (names.some((name) => name.startsWith(needle))) return 10;
  if (names.some((name) => name.includes(needle))) return 20;
  if (countries.some((country) => country.startsWith(needle))) return 30;
  if (countries.some((country) => country.includes(needle))) return 35;
  if (type.includes(needle)) return 40;
  return null;
}

export function searchLocationSummaries(
  locations: PublicLocation[],
  snapshot: Snapshot | null,
  query: string,
  limit = 20,
): LocationSummary[] {
  const needle = normalizeSearchTerm(query);
  if (!needle) return [];

  return locations
    .map((location) => ({ location, score: searchScore(location, needle) }))
    .filter((entry): entry is { location: PublicLocation; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.location.name.localeCompare(b.location.name, "en"))
    .slice(0, limit)
    .map(({ location }) => ({ location, state: locationState(snapshot, location.id) }));
}

export function attentionLocationSummaries(
  locations: PublicLocation[],
  snapshot: Snapshot | null,
): LocationSummary[] {
  return locations
    .map((location) => ({ location, state: locationState(snapshot, location.id) }))
    .filter(({ state }) => state.level !== "NORMAL")
    .sort((a, b) => {
      const levelDifference = riskRank[b.state.level] - riskRank[a.state.level];
      if (levelDifference) return levelDifference;
      const aTiming = "timing" in a.state && a.state.timing === "ACTIVE" ? 0 : 1;
      const bTiming = "timing" in b.state && b.state.timing === "ACTIVE" ? 0 : 1;
      return aTiming - bTiming || a.location.name.localeCompare(b.location.name, "en");
    });
}

export function attentionPresentation(
  summaries: LocationSummary[],
  options: { catalogCount?: number; catalogAvailable?: boolean } = {},
): AttentionPresentation {
  const groups = attentionGroups
    .map((group) => ({ ...group, items: summaries.filter(({ state }) => state.level === group.level) }))
    .filter((group) => group.items.length > 0);
  const total = summaries.length;
  const catalogCount = options.catalogCount ?? 0;
  if (options.catalogAvailable === false) {
    return {
      groups: [], total: 0,
      label: "Destinations unavailable", compactLabel: "Unavailable",
      railTitle: "Destinations unavailable", railDetail: "Destination list could not load",
      accessibleLabel: "Destination alerts are unavailable because the destination list could not be loaded.",
      globalUnavailable: true,
    };
  }
  const globalUnavailable =
    catalogCount > 0 &&
    total === catalogCount &&
    summaries.every(({ state }) => state.level === "UNKNOWN");
  if (total === 0) {
    return {
      groups,
      total,
      label: "No destinations flagged",
      compactLabel: "None flagged",
      railTitle: "No destinations flagged",
      railDetail: "Monitoring limits still apply",
      accessibleLabel: "No destinations currently need attention.",
      globalUnavailable: false,
    };
  }
  if (globalUnavailable) {
    return {
      groups: [],
      total,
      label: `${plural(total, "update")} unavailable`,
      compactLabel: `${total} unavailable`,
      railTitle: `${plural(total, "update")} unavailable`,
      railDetail: "Check affected destinations",
      accessibleLabel: `${plural(total, "destination")} with updates unavailable. Search a destination or check official local sources.`,
      globalUnavailable: true,
    };
  }

  const leading = groups[0];
  const leadingCount = leading.items.length;
  const label = leading.key === "unavailable"
    ? `${plural(leadingCount, "update")} unavailable`
    : leading.key === "emergency"
      ? `${plural(leadingCount, "emergency")} · ${total} need attention`
      : leading.key === "change-plans"
        ? `${plural(leadingCount, "change plan")} · ${total} need attention`
        : `${leadingCount} be aware${leadingCount === total ? "" : ` · ${total} need attention`}`;
  const accessibleLabel = groups.map((group) => {
    const count = group.items.length;
    if (group.key === "emergency") return plural(count, "emergency condition");
    if (group.key === "change-plans") return `${plural(count, "destination")} where plans may need changing`;
    if (group.key === "be-aware") return `${plural(count, "destination")} to be aware of`;
    return `${plural(count, "destination")} with updates unavailable`;
  }).join(", ");
  const compactLabel = leading.key === "unavailable"
    ? `${leadingCount} unavailable`
    : total === 1 ? "1 needs attention" : `${total} need attention`;
  const railDetail = leading.key === "unavailable"
    ? "Open affected destinations"
    : leading.key === "emergency"
      ? plural(leadingCount, "emergency")
      : leading.key === "change-plans"
        ? `${leadingCount} may need plan changes`
        : `${leadingCount} marked Be aware`;
  return {
    groups,
    total,
    label,
    compactLabel,
    railTitle: leading.key === "unavailable"
      ? `${plural(leadingCount, "update")} unavailable`
      : total === 1 ? "1 needs attention" : `${total} need attention`,
    railDetail,
    accessibleLabel: `${accessibleLabel}.`,
    globalUnavailable: false,
  };
}

export function destinationHeadline(location: PublicLocation, hazard: PublicHazard): string {
  if (hazard.id.startsWith("meteoalarm:met-eireann:")) return hazard.headline;
  const pluralHazards = new Set<HazardType>(["coastal", "security", "industrial", "nuclear", "civil-emergency"]);
  const verb = hazard.timing === "UPCOMING" ? "may affect" : pluralHazards.has(hazard.type) ? "are affecting" : "is affecting";
  return `${hazardLabels[hazard.type]} ${verb} ${location.name}.`;
}

export function destinationSummary(state: LocationState, locationName: string): string {
  switch (state.level) {
    case "NORMAL":
      return `Review source freshness and monitoring gaps for ${locationName} below.`;
    case "UNKNOWN":
      return "Check official local sources before relying on this result.";
    case "ELEVATED":
      return state.timing === "UPCOMING" ? "Your plans may need extra care soon." : "Your plans may need extra care today.";
    case "HIGH":
      return state.timing === "UPCOMING" ? "Consider changing affected plans before conditions begin." : "Consider changing or delaying affected plans.";
    case "SEVERE":
      return state.timing === "UPCOMING" ? "Prepare to follow official emergency instructions." : "Follow official emergency instructions now.";
  }
}

export function evidenceLabel(hazard: PublicHazard): string {
  if (hazard.providerId === "gdelt") return "Multiple independent reports";
  if (providerRegistry[hazard.providerId].satisfiesCoverage === false || hazard.id.startsWith("catalonia-plan:")) return "Context only";
  return hazard.confidence === "HIGH" ? "Official source" : "Preliminary official source";
}

export function deriveUiDataState({
  locationsLoaded,
  catalogError,
  snapshot,
  snapshotError,
  tilesFailed,
}: {
  locationsLoaded: boolean;
  catalogError: boolean;
  snapshot: Snapshot | null;
  snapshotError: boolean;
  tilesFailed: boolean;
}): UiDataState {
  if (catalogError && !locationsLoaded) return "catalog-unavailable";
  if (!locationsLoaded || (!snapshot && !snapshotError)) return "initial-loading";
  if (!snapshot && snapshotError) return "snapshot-unavailable";
  if (snapshotError || snapshot?.dataHealth !== "complete") return "refresh-delayed";
  if (tilesFailed) return "tiles-unavailable";
  return "ready";
}
