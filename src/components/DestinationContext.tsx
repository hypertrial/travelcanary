import type { PublicCatalogLocation as PublicLocation, CatalogSnapshot as Snapshot } from "@/lib/domain/catalog-public";
import type { LocationState} from "@/lib/domain/schemas";
import { LocationCoverageDetails, LocationCoverageSummary } from "./LocationCoveragePanel";
import { LocalConditions } from "./LocalConditions";

export function DestinationContext({ location, state, snapshot, now, countryIds, snapshotUrl, catalogVersion = 2 }: {
  location: PublicLocation;
  state: LocationState;
  snapshot: Snapshot | null;
  now: Date;
  countryIds: string[];
  snapshotUrl: string | null;
  catalogVersion?: 2 | 3;
}) {
  return <>
    <LocationCoverageSummary location={location} state={state} snapshot={snapshot} now={now} isFirst={state.hazards.length === 0} />
    {snapshotUrl && <LocalConditions catalogVersion={catalogVersion} location={location} countryIds={countryIds} snapshotUrl={snapshotUrl} now={now} />}
    <LocationCoverageDetails location={location} state={state} snapshot={snapshot} now={now} />
  </>;
}
