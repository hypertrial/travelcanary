import { CollectionChangedError, type CollectionControl, type IngestionStateV15, type PublicationTransition } from "./domain/catalog-state";

type ExpandedHealth = IngestionStateV15["expandedSourceHealth"];
type CatalogReceipts = IngestionStateV15["collectionReceipts"];
export type CapturedStateControl = {
  readonly collectionControl?: Readonly<CollectionControl>;
  readonly publicationControl?: Readonly<PublicationTransition> | null;
  readonly expandedSourceControl?: ExpandedHealth;
  readonly collectionReceiptControl?: CatalogReceipts;
};

export function captureStateControl(state: IngestionStateV15): Required<CapturedStateControl> {
  const health = structuredClone(state.expandedSourceHealth);
  for (const receipt of Object.values(health)) {
    Object.freeze(receipt.health); Object.freeze(receipt.checkedLocationIds); Object.freeze(receipt.unavailableLocationIds); Object.freeze(receipt);
  }
  return {
    collectionControl: Object.freeze({ ...state.collection }),
    publicationControl: state.publicationTransition ? Object.freeze({ ...state.publicationTransition }) : null,
    expandedSourceControl: Object.freeze(health),
    collectionReceiptControl: Object.freeze(structuredClone(state.collectionReceipts)),
  };
}
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

// The storage CAS protects the captured controls. Ordinary evidence writes may
// not erase transition progress, extend its acknowledged window or refresh an
// expanded cohort during legacy-only collection.
export function assertStateControlChange(next: IngestionStateV15, before: CapturedStateControl) {
  const collection = before.collectionControl;
  const publication = before.publicationControl;
  const receipts = before.expandedSourceControl;
  const catalogReceipts = before.collectionReceiptControl;
  if (!collection || publication === undefined || !receipts || !catalogReceipts) throw new CollectionChangedError("Private state write requires captured collection and publication controls");
  if (next.collection.revision < collection.revision) throw new CollectionChangedError("Collection revision cannot decrease");
  const transition = next.publicationTransition;
  if (next.collection.catalogVersion !== collection.catalogVersion) {
    if (next.collection.revision <= collection.revision || !transition || transition.from !== collection.catalogVersion
      || transition.to !== next.collection.catalogVersion || transition.dualStartedAt || transition.dualUntil) {
      throw new CollectionChangedError("Catalog change requires a new unacknowledged publication transition and revision");
    }
  } else if (!publication) {
    if (transition) throw new CollectionChangedError("Publication transition requires a catalog change");
  } else {
    const expiredClosure = !transition && publication.dualUntil
      && Date.parse(next.updatedAt) >= Date.parse(publication.dualUntil);
    if (!expiredClosure && (!transition || transition.from !== publication.from || transition.to !== publication.to
      || (publication.dualStartedAt && (transition.dualStartedAt !== publication.dualStartedAt || transition.dualUntil !== publication.dualUntil)))) {
      throw new CollectionChangedError("Publication transition progress cannot be erased or rescheduled");
    }
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
  for (const version of [2, 3] as const) for (const [source, prior] of Object.entries(catalogReceipts[version])) {
    const receipt = next.collectionReceipts[version][source as keyof typeof next.collectionReceipts[typeof version]];
    if (!receipt) throw new CollectionChangedError("Catalog-scoped receipt history cannot be erased");
    if (!equal(prior, receipt) && (version !== collection.catalogVersion
      || next.collection.catalogVersion !== collection.catalogVersion || next.collection.revision !== collection.revision
      || receipt.collectionRevision !== collection.revision || Date.parse(receipt.checkedAt) <= Date.parse(prior.checkedAt))) {
      throw new CollectionChangedError("Catalog-scoped receipt updates require the current unchanged collection revision and a newer check");
    }
  }
  for (const version of [2, 3] as const) for (const [source, receipt] of Object.entries(next.collectionReceipts[version])) {
    if (source in catalogReceipts[version]) continue;
    if (version !== collection.catalogVersion || next.collection.catalogVersion !== collection.catalogVersion
      || next.collection.revision !== collection.revision || receipt.collectionRevision !== collection.revision) {
      throw new CollectionChangedError("New catalog-scoped receipts require the current unchanged collection revision");
    }
  }
}
