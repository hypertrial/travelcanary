import { readFileSync } from "node:fs";
import type { Snapshot } from "../../src/lib/domain/schemas";

/** Schema-valid catalog fixtures: counts resemble production, not a new risk model. */
export function mapSnapshot(alertCount = 108, unavailableCount = 33) {
  const snapshot = JSON.parse(readFileSync(new URL("../../public/demo-snapshot.json", import.meta.url), "utf8")) as Snapshot;
  const hazard = snapshot.locations["at-austrian-alps"].hazards[0]!;
  const ids = Object.keys(snapshot.locations).filter((id) => id !== "at-vienna");
  for (const [id, state] of Object.entries(snapshot.locations)) {
    snapshot.locations[id] = { ...state, level: "NORMAL", hazards: [], delayedHazards: [], coverage: "partial" };
  }
  for (const id of ids.slice(0, alertCount)) {
    snapshot.locations[id] = {
      ...snapshot.locations[id], level: "ELEVATED", timing: "ACTIVE",
      hazards: [{ ...hazard, id: `fixture:${id}:fire-danger`, affectedArea: { label: id } }],
    };
  }
  for (const id of ids.slice(alertCount, alertCount + unavailableCount)) {
    snapshot.locations[id] = {
      ...snapshot.locations[id], level: "UNKNOWN", hazards: [], coverage: "delayed", delayedHazards: ["severe-weather"],
    };
  }
  return snapshot;
}
