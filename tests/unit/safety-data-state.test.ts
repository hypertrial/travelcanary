import { describe, expect, it } from "vitest";
import { parseSnapshot } from "@/lib/domain/schemas";
import { initialSafetyDataState, safetyDataReducer } from "@/lib/safety-data-state";
import type { VerifiedPublicationSnapshot } from "@/lib/publication-client";
import demo from "../fixtures/legacy-catalog-2/demo-snapshot.json";

function snapshot(generatedAt: string) {
  return parseSnapshot({ ...structuredClone(demo), generatedAt });
}
function publication(generatedAt: string, generation = "a".repeat(64)): VerifiedPublicationSnapshot {
  return { snapshot: snapshot(generatedAt), generation, publishedAt: generatedAt, conditionsByCountry: {
    AT: { url: `https://example.test/catalogs/3/objects/sha256/${generation}.json`,
      reference: { countryCode: "AT", path: `catalogs/3/objects/sha256/${generation}.json`, sha256: generation, bytes: 1, generatedAt } },
  } };
}

describe("safety data state", () => {
  it("ignores stale catalog failures and successes from overlapping retries", () => {
    const first = safetyDataReducer(initialSafetyDataState, { type: "catalog-loading", request: 1 });
    const second = safetyDataReducer(first, { type: "catalog-loading", request: 2 });
    const loaded = safetyDataReducer(second, { type: "catalog-ready", request: 2, locations: [] });
    expect(safetyDataReducer(loaded, { type: "catalog-failed", request: 1 })).toBe(loaded);
    expect(safetyDataReducer(loaded, { type: "catalog-ready", request: 1, locations: [] })).toBe(loaded);
  });

  it("keeps a loaded snapshot visible when the latest refresh fails", () => {
    const loaded = safetyDataReducer(initialSafetyDataState, {
      type: "publication-ready", request: 1, publication: publication("2026-08-25T12:00:00.000Z"), receivedAt: Date.parse("2026-08-25T12:00:00.000Z"),
    });
    const pending = safetyDataReducer(loaded, { type: "snapshot-loading", request: 2 });
    const failed = safetyDataReducer(pending, { type: "snapshot-failed", request: 2 });
    expect(failed.publication).toBe(loaded.publication);
    expect(failed.snapshotError).toMatch(/Previously loaded alerts remain visible/);
  });

  it("ignores a stale failure after a newer request succeeds", () => {
    const first = safetyDataReducer(initialSafetyDataState, { type: "snapshot-loading", request: 1 });
    const second = safetyDataReducer(first, { type: "snapshot-loading", request: 2 });
    const loaded = safetyDataReducer(second, {
      type: "publication-ready", request: 2, publication: publication("2026-08-25T12:10:00.000Z"), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(safetyDataReducer(loaded, { type: "snapshot-failed", request: 1 })).toBe(loaded);
  });

  it("accepts the freshest snapshot regardless of request completion order", () => {
    const pending = safetyDataReducer(
      safetyDataReducer(initialSafetyDataState, { type: "snapshot-loading", request: 1 }),
      { type: "snapshot-loading", request: 2 },
    );
    const newer = safetyDataReducer(pending, {
      type: "publication-ready", request: 1, publication: publication("2026-08-25T12:10:00.000Z", "b".repeat(64)), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    const older = safetyDataReducer(newer, {
      type: "publication-ready", request: 2, publication: publication("2026-08-25T12:00:00.000Z"), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(older).toBe(newer);
  });

  it("recovers from an accepted snapshot with an implausibly future timestamp", () => {
    const future = safetyDataReducer(initialSafetyDataState, {
      type: "publication-ready", request: 1, publication: publication("2099-01-01T00:00:00.000Z"), receivedAt: Date.parse("2026-08-25T12:00:00.000Z"),
    });
    const recovered = safetyDataReducer(future, {
      type: "publication-ready", request: 2, publication: publication("2026-08-25T12:10:00.000Z", "b".repeat(64)), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(recovered.publication?.snapshot.generatedAt).toBe("2026-08-25T12:10:00.000Z");
    const newerFuture = safetyDataReducer(future, {
      type: "publication-ready", request: 3, publication: publication("2099-01-01T00:00:00.000Z", "c".repeat(64)), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(safetyDataReducer(newerFuture, {
      type: "publication-ready", request: 2, publication: publication("2099-01-01T00:00:00.000Z", "b".repeat(64)), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    })).toBe(newerFuture);
  });

  it("switches snapshot and country reference together, and rejects a late equal-time generation", () => {
    const time = "2026-08-25T12:10:00.000Z";
    const older = publication(time, "a".repeat(64));
    const newer = publication(time, "b".repeat(64));
    const pending = safetyDataReducer(safetyDataReducer(initialSafetyDataState,
      { type: "snapshot-loading", request: 1 }), { type: "snapshot-loading", request: 2 });
    const accepted = safetyDataReducer(pending, { type: "publication-ready", request: 2, publication: newer, receivedAt: Date.parse(time) });
    expect(accepted.publication).toBe(newer);
    expect(accepted.publication?.conditionsByCountry.AT.reference.sha256).toBe("b".repeat(64));
    expect(safetyDataReducer(accepted, { type: "publication-ready", request: 1, publication: older, receivedAt: Date.parse(time) })).toBe(accepted);
    const reset = safetyDataReducer(accepted, { type: "reset", epoch: 1, resourceKey: "another" });
    expect(reset.publication).toBeNull();
  });
});
