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

const blobFetchPrefix = "Vercel Blob: Failed to fetch blob: ";
const blobFetchReasons = {
  "400": "blob_fetch_400", "401": "blob_fetch_401", "403": "blob_fetch_403",
  "408": "blob_fetch_408", "429": "blob_fetch_429", "500": "blob_fetch_500",
  "502": "blob_fetch_502", "503": "blob_fetch_503", "504": "blob_fetch_504",
} as const;

function blobFetchFailureReason(error: BlobError) {
  try {
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (!message || typeof message.value !== "string") return "blob_error";
    // Inspect only the pinned SDK's fixed prefix, status and space; discard status text.
    const prefix = message.value.slice(0, blobFetchPrefix.length + 4);
    if (!prefix.startsWith(blobFetchPrefix) || !prefix.endsWith(" ")) return "blob_error";
    const status = prefix.slice(blobFetchPrefix.length, -1);
    return blobFetchReasons[status as keyof typeof blobFetchReasons] || "blob_error";
  } catch { return "blob_error"; }
}

export function operationFailureReason(error: unknown) {
  for (const [type, reason] of failureReasons) if (error instanceof type) {
    return type === BlobError ? blobFetchFailureReason(error) : reason;
  }
  return "unknown";
}
