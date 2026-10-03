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

  describe("bounded SDK fetch status reasons", () => {
    const prefix = "Vercel Blob: Failed to fetch blob: ";

    it.each([400, 401, 403, 408, 429, 500, 502, 503, 504])("recognizes only the fixed SDK status token for %i", (status) => {
      const error = new BlobError(`Failed to fetch blob: ${status} ${secret}\r\nforged-log-event`);
      expect(operationFailureReason(error)).toBe(`blob_fetch_${status}`);
      expect(classifyOperationFailure(error)).toBe("operation_failed");
    });

    it("ignores a million-character hostile suffix", () => {
      const error = new BlobError(`Failed to fetch blob: 403 ${secret}\r\n${"x".repeat(1_000_000)}`);
      expect(operationFailureReason(error)).toBe("blob_fetch_403");
      expect(classifyOperationFailure(error)).toBe("operation_failed");
    });

    it("recognizes an SDK status with an empty status text after the required space", () => {
      expect(operationFailureReason(new BlobError("Failed to fetch blob: 403 "))).toBe("blob_fetch_403");
    });

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
    ] as const)("preserves the specific SDK reason despite a fetch-looking message", (error, reason) => {
      error.message = `${prefix}403 ${secret}`;
      expect(operationFailureReason(error)).toBe(reason);
    });

    it.each([
      "Failed to fetch blob: 403 forbidden",
      ` ${prefix}403 forbidden`,
      "vercel Blob: Failed to fetch blob: 403 forbidden",
      "Vercel Blob: failed to fetch blob: 403 forbidden",
      "Vercel Blob: Failed to fetch blob:403 forbidden",
      `${prefix}4030 forbidden`,
      `${prefix}0403 forbidden`,
      `${prefix}403`,
      `${prefix}403\tforbidden`,
      `${prefix}403\nforbidden`,
      `${prefix}+403 forbidden`,
      `${prefix}404 not found`,
      `${prefix}200 ok`,
    ])("keeps malformed or unsupported SDK messages generic: %s", (message) => {
      const error = new BlobError("unused");
      error.message = message;
      expect(operationFailureReason(error)).toBe("blob_error");
    });

    it.each([new Error(`${prefix}403 ${secret}`), { name: "BlobError", constructor: BlobError, message: `${prefix}403 ${secret}` }])
      ("does not trust a fetch-looking message on a non-SDK error", (error) => {
        expect(operationFailureReason(error)).toBe("unknown");
      });

    it("does not invoke an SDK message getter", () => {
      const error = new BlobError("unused");
      let reads = 0;
      Object.defineProperty(error, "message", { get() { reads += 1; throw new Error(secret); } });
      expect(operationFailureReason(error)).toBe("blob_error");
      expect(reads).toBe(0);
    });

    it.each([null, 403, { toString() { throw new Error(secret); } }])("does not coerce a non-string SDK message", (message) => {
      const error = new BlobError("unused");
      Object.defineProperty(error, "message", { value: message });
      expect(operationFailureReason(error)).toBe("blob_error");
    });

    it.each(["absent", "inherited value", "inherited getter"])("does not use an %s SDK message", (kind) => {
      const error = new BlobError("unused");
      Reflect.deleteProperty(error, "message");
      let reads = 0;
      if (kind !== "absent") Object.setPrototypeOf(error, Object.create(BlobError.prototype, {
        message: kind === "inherited value" ? { value: `${prefix}403 ${secret}` }
          : { get() { reads += 1; throw new Error(secret); } },
      }));
      expect(operationFailureReason(error)).toBe("blob_error");
      expect(reads).toBe(0);
    });

    it("fails closed if obtaining the SDK message descriptor throws", () => {
      const error = new Proxy(new BlobError(`Failed to fetch blob: 403 ${secret}`), {
        getOwnPropertyDescriptor() { throw new Error(secret); },
      });
      expect(operationFailureReason(error)).toBe("blob_error");
    });
  });
});
