import { CollectionChangedError } from "./domain/catalog-state";
import { StateLimitError } from "./ingestion/limits";
import { ConcurrencyError } from "./state-store";
import { BlobAccessError, BlobError, BlobNotFoundError, BlobPreconditionFailedError,
  BlobRequestAbortedError, BlobServiceNotAvailable, BlobServiceRateLimited,
  BlobStoreNotFoundError, BlobStoreSuspendedError, BlobUnknownError } from "@vercel/blob";
import { ZodError } from "zod";

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

const failureReasons = [
  [BlobAccessError, "blob_access"],
  [BlobNotFoundError, "blob_not_found"],
  [BlobStoreNotFoundError, "blob_store_not_found"],
  [BlobStoreSuspendedError, "blob_store_suspended"],
  [BlobServiceRateLimited, "blob_rate_limited"],
  [BlobServiceNotAvailable, "blob_unavailable"],
  [BlobRequestAbortedError, "blob_aborted"],
  [BlobPreconditionFailedError, "blob_precondition"],
  [BlobUnknownError, "blob_unknown"],
  [BlobError, "blob_error"],
  [ZodError, "schema_invalid"],
  [SyntaxError, "json_invalid"],
] as const;

export function operationFailureReason(error: unknown) {
  for (const [type, reason] of failureReasons) if (error instanceof type) return reason;
  return "unknown";
}
