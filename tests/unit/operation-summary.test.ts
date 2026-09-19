import { describe, expect, it } from "vitest";
import { publicOperationSummary } from "@/lib/operation-summary";

describe("publicOperationSummary", () => {
  it("copies the closed orchestrator timing keys", () => {
    expect(publicOperationSummary({
      status: "ok",
      timings: { sourcesMs: 1, readMs: 2, mergeAndBuildMs: 3, publishMs: 4, totalMs: 10, extraMs: 99, negativeMs: -1 },
    })).toEqual({
      status: "ok",
      timings: { sourcesMs: 1, readMs: 2, mergeAndBuildMs: 3, publishMs: 4, totalMs: 10 },
    });
  });

  it("rejects non-numeric or negative timings and drops unknown keys", () => {
    expect(publicOperationSummary({
      status: "ok",
      timings: { sourcesMs: "1", readMs: Number.NaN, mergeAndBuildMs: -3, publishMs: Infinity, totalMs: 4, leaked: "secret" },
    })).toEqual({ status: "ok", timings: { totalMs: 4 } });
  });

  it("omits an empty timings object", () => {
    expect(publicOperationSummary({ status: "ok", timings: {} })).toEqual({ status: "ok" });
  });
});
