import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "@/lib/domain/catalog-public";
import type { LocationState} from "@/lib/domain/schemas";
import { LocationCoverageDetails, LocationCoverageSummary } from "./LocationCoveragePanel";
import { LocalConditions } from "./LocalConditions";
import type { ConditionsSource } from "@/lib/use-conditions";

export function DestinationContext({ location, state, snapshot, now, countryIds, conditionsSource, onRetryPublication, catalogVersion = 3 }: {
  location: PublicLocation;
  state: LocationState;
  snapshot: Snapshot | null;
  now: Date;
  countryIds: string[];
  conditionsSource: ConditionsSource | null;
  onRetryPublication: () => Promise<void>;
  catalogVersion?: 2 | 3;
}) {
  return <>
    <LocationCoverageSummary location={location} state={state} snapshot={snapshot} now={now} isFirst={state.hazards.length === 0} />
    {conditionsSource && <LocalConditions catalogVersion={catalogVersion} location={location} countryIds={countryIds} conditionsSource={conditionsSource} onRetryPublication={onRetryPublication} now={now} />}
    <LocationCoverageDetails location={location} state={state} snapshot={snapshot} now={now} />
  </>;
}
