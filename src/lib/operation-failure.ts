import { CollectionChangedError } from "./domain/catalog-state";
import { StateLimitError } from "./ingestion/limits";
import { ConcurrencyError } from "./state-store";

export class PublicationRaceError extends Error {}

export type OperationFailureCode =
  | "concurrency"
  | "collection_changed"
  | "state_changed_during_publication"
  | "state_limit"
  | "operation_failed";

export function classifyOperationFailure(error: unknown): OperationFailureCode {
  if (error instanceof ConcurrencyError) return "concurrency";
  if (error instanceof CollectionChangedError) return "collection_changed";
  if (error instanceof PublicationRaceError) return "state_changed_during_publication";
  if (error instanceof StateLimitError) return "state_limit";
  return "operation_failed";
}
