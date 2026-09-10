import { describe, expect, it } from "vitest";
import { conditionsWarmNextAction } from "../../scripts/warm-conditions";

type Verification = Parameters<typeof conditionsWarmNextAction>[2];
const verification = (blockers: Verification["blockers"] = [], warnings: Verification["warnings"] = []) => ({ blockers, warnings, metrics: {} }) as Verification;

describe("conditions warm-up next action", () => {
  it("returns one deterministic action for route, release, recovery, persistent, and converged states", () => {
    expect(conditionsWarmNextAction(false, "failed", verification())).toMatch(/route failure/);
    expect(conditionsWarmNextAction(true, "ok", verification([{ code: "snapshot_invalid", message: "bad" }]))).toMatch(/Production blockers/);
    expect(conditionsWarmNextAction(true, "partial", verification())).toMatch(/105 seconds/);
    expect(conditionsWarmNextAction(true, "ok", verification([{ code: "conditions_sha_mismatch", message: "pending" }]))).toMatch(/105 seconds/);
    expect(conditionsWarmNextAction(true, "ok", verification([], [{ code: "conditions_weather_incomplete", message: "11 missing" }]))).toMatch(/next hourly/);
    expect(conditionsWarmNextAction(true, "ok", verification([], [{ code: "conditions_source_health_persistent", message: "DE/autobahn-traffic:partial" }]))).toBe(
      "Investigate persistent conditions sources: DE/autobahn-traffic:partial",
    );
    expect(conditionsWarmNextAction(true, "ok", verification([], [{ code: "conditions_stale_infrastructure", message: "DE/autobahn" }]))).toBe(
      "Investigate persistent conditions sources: DE/autobahn",
    );
    expect(conditionsWarmNextAction(true, "ok", verification([], [{ code: "gdelt_reliability_gate", message: "disabled" }]))).toMatch(/no additional warm-up/);
  });
});
