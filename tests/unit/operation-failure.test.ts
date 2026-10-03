import { describe, expect, it } from "vitest";
import {
  BlobAccessError, BlobError, BlobNotFoundError, BlobPreconditionFailedError, BlobRequestAbortedError,
  BlobServiceNotAvailable, BlobServiceRateLimited, BlobStoreNotFoundError, BlobStoreSuspendedError, BlobUnknownError,
} from "@vercel/blob";
import { ZodError } from "zod";
import { CollectionChangedError } from "@/lib/domain/catalog-state";
import { StateLimitError } from "@/lib/ingestion/limits";
import { PublicationRaceError, classifyOperationFailure, operationFailureReason } from "@/lib/operation-failure";
import { ConcurrencyError } from "@/lib/state-store";

describe("classifyOperationFailure", () => {
  it.each([
    [new ConcurrencyError("lease lost"), "concurrency"],
    [new CollectionChangedError("collection moved"), "collection_changed"],
    [new PublicationRaceError("Private state changed during publication"), "state_changed_during_publication"],
    [new StateLimitError("Private ingestion state exceeds 5 MB hard limit"), "state_limit"],
    [new Error("Private state changed during publication"), "operation_failed"],
    [new Error("secret-sentinel"), "operation_failed"],
    ["string", "operation_failed"],
  ] as const)("classifies %s", (error, code) => {
    expect(classifyOperationFailure(error)).toBe(code);
  });
});

describe("PublicationRaceError", () => {
  it("is not a ConcurrencyError", () => {
    expect(new PublicationRaceError("Private state changed during publication")).not.toBeInstanceOf(ConcurrencyError);
  });
});

describe("operationFailureReason", () => {
  const secret = "https://blob.example/private/state?token=secret-sentinel";

  it.each([
    [new BlobAccessError(), "blob_access"],
    [new BlobNotFoundError(), "blob_not_found"],
    [new BlobStoreNotFoundError(), "blob_store_not_found"],
    [new BlobStoreSuspendedError(), "blob_store_suspended"],
    [new BlobServiceRateLimited(1), "blob_rate_limited"],
    [new BlobServiceNotAvailable(), "blob_unavailable"],
    [new BlobRequestAbortedError(), "blob_aborted"],
    [new BlobPreconditionFailedError(), "blob_precondition"],
    [new BlobUnknownError(), "blob_unknown"],
    [new BlobError(secret), "blob_error"],
  ] as const)("uses the fixed SDK reason %s without reading its message", (error, reason) => {
    error.message = secret;
    error.name = secret;
    error.cause = { privatePath: secret };
    expect(operationFailureReason(error)).toBe(reason);
    expect(classifyOperationFailure(error)).toBe("operation_failed");
  });

  it.each([
    [new ZodError([{ code: "custom", path: ["private-state", secret], message: secret }]), "schema_invalid"],
    [new SyntaxError(secret), "json_invalid"],
  ] as const)("uses the fixed parsing reason without exposing private issue details", (error, reason) => {
    expect(operationFailureReason(error)).toBe(reason);
    expect(classifyOperationFailure(error)).toBe("operation_failed");
  });

  it.each([
    ["generic error", new Error(secret)],
    ["forged error name", Object.assign(new Error(secret), { name: "BlobNotFoundError" })],
    ["forged constructor", { constructor: BlobNotFoundError, message: secret }],
    ["forged code", { code: "blob_not_found", message: secret }],
    ["forged identity", { name: "BlobNotFoundError", constructor: BlobNotFoundError, code: "blob_not_found", cause: new BlobNotFoundError() }],
    ["wrapped SDK cause", new Error(secret, { cause: new BlobNotFoundError() })],
    ["string", `BlobNotFoundError: ${secret}`],
    ["plain object", { privatePath: secret }],
    ["array", [new BlobNotFoundError()]],
    ["null", null],
    ["undefined", undefined],
    ["number", 503],
    ["boolean", false],
  ])("returns unknown for %s rather than trusting arbitrary error values", (_label, error) => {
    expect(operationFailureReason(error)).toBe("unknown");
  });

  it("does not inspect arbitrary getters or serialize unknown thrown objects", () => {
    const error = Object.fromEntries(["name", "message", "constructor", "code", "cause", "toJSON", "toString"]
      .map((key) => [key, secret]));
    for (const key of Object.keys(error)) Object.defineProperty(error, key, { get() { throw new Error(secret); } });
    expect(operationFailureReason(error)).toBe("unknown");
  });
});
