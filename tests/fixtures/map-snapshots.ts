import { readFileSync } from "node:fs";
import type { z } from "zod";

type SnapshotV11 = z.infer<typeof import("../../src/lib/domain/catalog-public").SnapshotV11Schema>;

/** Schema-valid catalog fixtures: counts resemble production, not a new risk model. */
export function mapSnapshot(alertCount = 108, unavailableCount = 33) {
  const pointer = JSON.parse(readFileSync(new URL("../../public/catalogs/3/publication/latest.json", import.meta.url), "utf8")) as { manifestPath: string };
  const manifest = JSON.parse(readFileSync(new URL(`../../public/${pointer.manifestPath}`, import.meta.url), "utf8")) as { snapshot: { path: string } };
  const snapshot = JSON.parse(readFileSync(new URL(`../../public/${manifest.snapshot.path}`, import.meta.url), "utf8")) as SnapshotV11;
  const hazard = snapshot.locations["at-austrian-alps"].hazards[0]!;
  const ids = Object.keys(snapshot.locations).filter((id) => id !== "at-vienna");
  for (const [id, state] of Object.entries(snapshot.locations)) {
    snapshot.locations[id] = { ...state, level: "NORMAL", hazards: [], delayedHazards: [], coverage: "partial", updatePending: undefined };
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
