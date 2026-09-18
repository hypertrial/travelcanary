import { CollectionChangedError, type CollectionControl, type IngestionState } from "./domain/catalog-state";

type ExpandedHealth = IngestionState["expandedSourceHealth"];
type CatalogReceipts = IngestionState["collectionReceipts"];
export type CapturedStateControl = {
  readonly collectionControl?: Readonly<CollectionControl>;
  readonly expandedSourceControl?: ExpandedHealth;
  readonly collectionReceiptControl?: CatalogReceipts;
  readonly ingestionFenceControl?: number;
  readonly ingestionLeaseControl?: IngestionState["ingestionLease"];
};

export function captureStateControl(state: IngestionState): Required<CapturedStateControl> {
  const health = structuredClone(state.expandedSourceHealth);
  for (const receipt of Object.values(health)) {
    Object.freeze(receipt.health); Object.freeze(receipt.checkedLocationIds); Object.freeze(receipt.unavailableLocationIds); Object.freeze(receipt);
  }
  return {
    collectionControl: Object.freeze({ ...state.collection }),
    expandedSourceControl: Object.freeze(health),
    collectionReceiptControl: Object.freeze(structuredClone(state.collectionReceipts)),
    ingestionFenceControl: state.ingestionFence,
    ingestionLeaseControl: state.ingestionLease ? Object.freeze({ ...state.ingestionLease }) : null,
  };
}
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

// The storage CAS protects collection receipts plus lease and fence ownership
// while ordinary evidence writes update the rest of private state.
export function assertStateControlChange(next: IngestionState, before: CapturedStateControl) {
  const collection = before.collectionControl;
  const receipts = before.expandedSourceControl;
  const catalogReceipts = before.collectionReceiptControl;
  const fence = before.ingestionFenceControl;
  const lease = before.ingestionLeaseControl;
  if (!collection || !receipts || !catalogReceipts || fence === undefined || lease === undefined) throw new CollectionChangedError("Private state write requires captured controls");
  if (next.collection.catalogVersion !== 3 || next.collection.revision !== collection.revision) throw new CollectionChangedError("Collection control is immutable after V16 migration");
  if (next.ingestionFence < fence || next.ingestionFence > fence + 1) throw new CollectionChangedError("Ingestion fence must remain monotonic");
  if (next.ingestionFence === fence + 1) {
    if (!next.ingestionLease || next.ingestionLease.fence !== next.ingestionFence
      || lease && Date.parse(lease.expiresAt) > Date.parse(next.updatedAt)) throw new CollectionChangedError("A new fence requires acquisition of an absent or expired lease");
  } else if (!equal(next.ingestionLease, lease)) {
    const renewed = lease && next.ingestionLease && lease.owner === next.ingestionLease.owner && lease.fence === next.ingestionLease.fence
      && Date.parse(next.ingestionLease.expiresAt) >= Date.parse(lease.expiresAt);
    const released = lease && !next.ingestionLease;
    if (!renewed && !released) throw new CollectionChangedError("Lease changes require renewal, release, or a new fence");
  }
  for (const [source, receipt] of Object.entries(next.expandedSourceHealth)) {
    const prior = receipts[source as keyof ExpandedHealth];
    if (equal(prior, receipt)) continue;
    if (next.collection.catalogVersion !== 3 || next.collection.catalogVersion !== collection.catalogVersion || next.collection.revision !== collection.revision) {
      throw new CollectionChangedError("Expanded receipts require an unchanged expanded collection scope");
    }
    if (prior?.health.lastSuccess && (!receipt.health.lastSuccess || Date.parse(receipt.health.lastSuccess) < Date.parse(prior.health.lastSuccess))) {
      throw new CollectionChangedError("Expanded successful-check history cannot be erased or regressed");
    }
    if (!receipt.checkedLocationIds.length && (receipt.health.lastSuccess !== (prior?.health.lastSuccess ?? null)
      || receipt.health.sourceUpdatedAt !== (prior?.health.sourceUpdatedAt ?? null))) {
      throw new CollectionChangedError("Unsuccessful expanded checks must preserve prior successful-observation timestamps");
    }
    const previousAttempt = prior?.health.lastAttempt;
    if (previousAttempt && Date.parse(receipt.health.lastAttempt!) <= Date.parse(previousAttempt)) {
      throw new CollectionChangedError("Expanded receipt updates must advance their attempt time");
    }
  }
  for (const source of Object.keys(receipts)) {
    if (!(source in next.expandedSourceHealth)) throw new CollectionChangedError("Expanded receipt history cannot be erased");
  }
  for (const [source, prior] of Object.entries(catalogReceipts[3])) {
    const receipt = next.collectionReceipts[3][source as keyof typeof next.collectionReceipts[3]];
    if (!receipt) throw new CollectionChangedError("Catalog-scoped receipt history cannot be erased");
    if (!equal(prior, receipt) && (next.collection.catalogVersion !== collection.catalogVersion || next.collection.revision !== collection.revision
      || receipt.collectionRevision !== collection.revision || Date.parse(receipt.checkedAt) <= Date.parse(prior.checkedAt))) {
      throw new CollectionChangedError("Catalog-scoped receipt updates require the current unchanged collection revision and a newer check");
    }
  }
  for (const [source, receipt] of Object.entries(next.collectionReceipts[3])) {
    if (source in catalogReceipts[3]) continue;
    if (next.collection.catalogVersion !== collection.catalogVersion || next.collection.revision !== collection.revision || receipt.collectionRevision !== collection.revision) {
      throw new CollectionChangedError("New catalog-scoped receipts require the current unchanged collection revision");
    }
  }
}
