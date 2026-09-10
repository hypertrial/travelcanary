import { describe, expect, it } from "vitest";
import { sourceAdapters } from "@/lib/ingestion/adapters";
import { assertSourceRuntimeIntegrity, sourceRuntimeProblems } from "@/lib/ingestion/source-runtime";
import { enabledSources } from "@/lib/risk-policy";

describe("source runtime manifest", () => {
  it("keeps enabled providers, adapters, and cadence definitions aligned", () => {
    expect(sourceRuntimeProblems()).toEqual([]);
    expect(() => assertSourceRuntimeIntegrity()).not.toThrow();
    expect(new Set(sourceAdapters.map(({ id }) => id))).toEqual(enabledSources);
  });
});
