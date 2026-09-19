import { describe, expect, it } from "vitest";
import { CollectionChangedError } from "@/lib/domain/catalog-state";
import { StateLimitError } from "@/lib/ingestion/limits";
import { PublicationRaceError, classifyOperationFailure } from "@/lib/operation-failure";
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
