import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import mapping from "../../data/marine-condition-mapping-v3.json";
import legacy from "../../data/marine-condition-mapping.json";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { locations } from "@/lib/data";
import { catalog3MarineMappingByLocation, marineConditionEligible, marineMappingByLocation } from "@/lib/conditions/marine";
import { forecastUrl, parseOpenMeteo } from "@/lib/conditions/forecast";
import { emptyConditions, MarineForecastSchema } from "@/lib/domain/conditions";
import { createEmptyState } from "@/lib/risk-state";
import { forecastBatches } from "@/lib/conditions/worker";
import { distanceKm } from "@/lib/geospatial";

describe("reviewed catalog3 marine cells", () => {
  it("retains hashed source samples and replays all30 approved cells at their exact reviewed coordinates", () => {
    for (const sample of mapping.samples) {
      const bytes = readFileSync(sample.path);
      expect(bytes.byteLength).toBe(sample.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sample.sha256);
    }
    const approved = mapping.mappings.filter(({ status }) => status === "mapped");
    expect(approved).toHaveLength(30);
    for (const cell of approved) {
      const sample = mapping.samples.find(({ path }) => path.endsWith(`/${cell.repeatSample}`))!;
      expect(sample).toBeDefined();
      const rows = JSON.parse(readFileSync(sample.path, "utf8"));
      const row = rows[cell.repeatIndex!];
      expect([row.longitude, row.latitude]).toEqual(cell.queryCoordinates);
      expect(row.elevation).toBe(0);
      const parsed = parseOpenMeteo(row, "marine", new Date(sample.checkedAt));
      expect(parsed.sourceId).toBe("open-meteo-marine");
      const location = catalogLocationsV3.find(({ id }) => id === cell.locationId)!;
      expect(distanceKm(location.centroid, cell.queryCoordinates as [number, number])).toBeLessThanOrEqual(25);
      expect(catalog3MarineMappingByLocation.get(cell.locationId)?.queryCoordinates).toEqual(cell.queryCoordinates);
      const url = new URL(forecastUrl("marine", [cell.queryCoordinates as [number, number]]));
      expect(url.searchParams.get("cell_selection")).toBe("sea");
      expect(Number(url.searchParams.get("longitude"))).toBeCloseTo(cell.queryCoordinates![0], 4);
      expect(Number(url.searchParams.get("latitude"))).toBeCloseTo(cell.queryCoordinates![1], 4);
      expect(marineConditionEligible(cell.locationId, 3)).toBe(true);
      expect(marineConditionEligible(cell.locationId)).toBe(false);
    }
  });

  it("preserves all131 legacy mappings and partitions all63 new coastal destinations into30 eligible and33 excluded", () => {
    const oldIds = new Set(locations.map(({ id }) => id));
    const coastal = catalogLocationsV3.filter(({ id, isCoastal }) => !oldIds.has(id) && isCoastal);
    expect(mapping.mappings.map(({ locationId }) => locationId).sort()).toEqual(coastal.map(({ id }) => id).sort());
    const excluded = mapping.mappings.filter(({ status }) => status === "unsupported");
    expect(excluded).toHaveLength(33);
    for (const cell of excluded) {
      expect(cell).not.toHaveProperty("queryCoordinates");
      expect(marineConditionEligible(cell.locationId, 3)).toBe(false);
      expect(catalog3MarineMappingByLocation.has(cell.locationId)).toBe(false);
    }
    const oldMapped = legacy.mappings.filter(({ status }) => status === "mapped");
    expect(oldMapped).toHaveLength(131); expect(marineMappingByLocation.size).toBe(131);
    expect(catalog3MarineMappingByLocation.size).toBe(161);
    for (const { locationId } of oldMapped) expect(catalog3MarineMappingByLocation.get(locationId)).toEqual(marineMappingByLocation.get(locationId));
    for (const location of locations) expect(marineConditionEligible(location.id, 3)).toBe(marineConditionEligible(location.id));
    for (const { id, isCoastal } of catalogLocationsV3) if (!isCoastal) expect(marineConditionEligible(id, 3)).toBe(false);
  });

  it("schedules every eligible cell once across a drained cold start and never any excluded marine request", () => {
    const now = new Date("2026-09-08T17:00:00Z"); const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
    const scheduled = new Set<string>();
    const sample = JSON.parse(readFileSync(mapping.samples[0].path, "utf8"))[0];
    const marine = MarineForecastSchema.parse(parseOpenMeteo(sample, "marine", now));
    const env = { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", CONDITIONS_DISABLED_SOURCES: "open-meteo-weather,open-meteo-air" };
    for (let run = 0; run < 3; run += 1) {
      const batches = forecastBatches(state, now, env).filter(({ kind }) => kind === "marine");
      for (const { ids } of batches) for (const id of ids) {
        expect(scheduled.has(id)).toBe(false); scheduled.add(id);
        // A successful response removes this destination from the due queue.
        state.conditions.locations[id] = { ...emptyConditions(), marine };
        state.conditions.attempts[`marine:${id}`] = now.toISOString();
      }
    }
    expect([...scheduled].sort()).toEqual([...catalog3MarineMappingByLocation.keys()].sort());
  });
});
