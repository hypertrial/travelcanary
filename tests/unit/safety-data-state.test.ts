import { describe, expect, it } from "vitest";
import { parseSnapshot } from "@/lib/domain/schemas";
import { initialSafetyDataState, safetyDataReducer } from "@/lib/safety-data-state";
import demo from "../../public/demo-snapshot.json";

function snapshot(generatedAt: string) {
  return parseSnapshot({ ...structuredClone(demo), generatedAt });
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
      type: "snapshot-ready", request: 1, snapshot: snapshot("2026-08-25T12:00:00.000Z"), receivedAt: Date.parse("2026-08-25T12:00:00.000Z"),
    });
    const pending = safetyDataReducer(loaded, { type: "snapshot-loading", request: 2 });
    const failed = safetyDataReducer(pending, { type: "snapshot-failed", request: 2 });
    expect(failed.snapshot?.generatedAt).toBe("2026-08-25T12:00:00.000Z");
    expect(failed.snapshotError).toMatch(/Previously loaded alerts remain visible/);
  });

  it("ignores a stale failure after a newer request succeeds", () => {
    const first = safetyDataReducer(initialSafetyDataState, { type: "snapshot-loading", request: 1 });
    const second = safetyDataReducer(first, { type: "snapshot-loading", request: 2 });
    const loaded = safetyDataReducer(second, {
      type: "snapshot-ready", request: 2, snapshot: snapshot("2026-08-25T12:10:00.000Z"), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(safetyDataReducer(loaded, { type: "snapshot-failed", request: 1 })).toBe(loaded);
  });

  it("accepts the freshest snapshot regardless of request completion order", () => {
    const pending = safetyDataReducer(
      safetyDataReducer(initialSafetyDataState, { type: "snapshot-loading", request: 1 }),
      { type: "snapshot-loading", request: 2 },
    );
    const newer = safetyDataReducer(pending, {
      type: "snapshot-ready", request: 1, snapshot: snapshot("2026-08-25T12:10:00.000Z"), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    const older = safetyDataReducer(newer, {
      type: "snapshot-ready", request: 2, snapshot: snapshot("2026-08-25T12:00:00.000Z"), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(older).toBe(newer);
  });

  it("recovers from an accepted snapshot with an implausibly future timestamp", () => {
    const future = safetyDataReducer(initialSafetyDataState, {
      type: "snapshot-ready", request: 1, snapshot: snapshot("2099-01-01T00:00:00.000Z"), receivedAt: Date.parse("2026-08-25T12:00:00.000Z"),
    });
    const recovered = safetyDataReducer(future, {
      type: "snapshot-ready", request: 2, snapshot: snapshot("2026-08-25T12:10:00.000Z"), receivedAt: Date.parse("2026-08-25T12:10:00.000Z"),
    });
    expect(recovered.snapshot?.generatedAt).toBe("2026-08-25T12:10:00.000Z");
  });
});
