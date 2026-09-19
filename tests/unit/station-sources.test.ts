import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ingestStationSource, retainStationItems, type StationSourceSpec } from "@/lib/conditions/station-sources";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { ConditionsV2Schema, conditionSourceIds, emptyConditions, type LocationConditions, type Observation } from "@/lib/domain/conditions";
import { runTestConditions as runConditions } from "../helpers/publication";
import { MemoryStateStore } from "@/lib/state-store";
import { createEmptyState } from "@/lib/risk";

const now = new Date("2026-09-08T07:30:00.000Z");
const stationCountries = ["NL", "IE", "SI", "PT"] as const;
const item = (sourceId: Observation["sourceId"], id: string) => ({ sourceId, id }) as unknown as Observation;

function catalog2ConditionsCandidates(country: string) {
  return [
    `public/conditions/v2/${country}.json`,
    `tests/fixtures/legacy-catalog-2/conditions/v2/${country}.json`,
  ] as const;
}

function resolveCatalog2ConditionsPath(country: string, exists: (path: string) => boolean = existsSync): string {
  const [publicPath, fixturePath] = catalog2ConditionsCandidates(country);
  if (exists(publicPath)) return publicPath;
  if (exists(fixturePath)) return fixturePath;
  throw new Error(`missing catalog-2 conditions fixture for ${country}`);
}

function spec(overrides: Partial<StationSourceSpec<Map<string, Observation>>> = {}): StationSourceSpec<Map<string, Observation>> {
  return {
    sourceId: "rws-water", field: "rivers", isDue: () => true,
    request: async () => ({ body: "ok" }),
    parse: () => new Map([["s1", item("rws-water", "fresh")]]),
    mappings: (parsed) => [{ locationId: "nl-rotterdam", fresh: parsed.has("s1") ? [parsed.get("s1")!] : [] }],
    retention: retainStationItems, ...overrides,
  };
}

function context(state = createEmptyState(now)) {
  return { state, changes: new Map<string, Partial<LocationConditions>>(), updateHealth: vi.fn() };
}

describe("station source ingest helper", () => {
  it("merges a successful fetch and records matched health", async () => {
    const ctx = context(); const request = vi.fn(async () => ({ body: { ok: true } }));
    const parse = vi.fn(() => new Map([["s1", item("rws-water", "fresh")]]));
    await ingestStationSource(spec({ request, parse }), ctx);
    expect(request).toHaveBeenCalledOnce(); expect(parse).toHaveBeenCalledWith({ ok: true });
    expect(ctx.changes.get("nl-rotterdam")?.rivers).toEqual([item("rws-water", "fresh")]);
    expect(ctx.updateHealth).toHaveBeenCalledExactlyOnceWith("rws-water", 1, false);
  });

  it("treats a healthy empty parse as no-data and drops only this source", async () => {
    const state = createEmptyState(now);
    state.conditions.locations["nl-rotterdam"] = { ...emptyConditions(),
      rivers: [item("rws-water", "old"), item("opw-hydro", "keep")] };
    const ctx = context(state);
    await ingestStationSource(spec({ parse: () => new Map() }), ctx);
    expect(ctx.changes.get("nl-rotterdam")?.rivers).toEqual([item("opw-hydro", "keep")]);
    expect(ctx.updateHealth).toHaveBeenCalledExactlyOnceWith("rws-water", 0, false);
  });

  it("marks the source failed without mutating location records", async () => {
    const state = createEmptyState(now);
    state.conditions.locations["nl-rotterdam"] = { ...emptyConditions(), rivers: [item("rws-water", "old")] };
    const ctx = context(state);
    await ingestStationSource(spec({ request: async () => { throw new Error("upstream unavailable"); } }), ctx);
    expect(ctx.changes.size).toBe(0);
    expect(state.conditions.locations["nl-rotterdam"].rivers).toEqual([item("rws-water", "old")]);
    expect(ctx.updateHealth).toHaveBeenCalledExactlyOnceWith("rws-water", 0, true);
  });

  it("caps retained items at three after replacing this source", async () => {
    const state = createEmptyState(now);
    state.conditions.locations["nl-rotterdam"] = { ...emptyConditions(),
      rivers: [item("opw-hydro", "a"), item("opw-hydro", "b"), item("rws-water", "old")] };
    const ctx = context(state);
    const fresh = [item("rws-water", "n1"), item("rws-water", "n2"), item("rws-water", "n3")];
    await ingestStationSource(spec({
      parse: () => new Map(), mappings: () => [{ locationId: "nl-rotterdam", fresh }],
    }), ctx);
    expect(retainStationItems([item("opw-hydro", "a"), item("opw-hydro", "b")], fresh))
      .toEqual([item("opw-hydro", "a"), item("opw-hydro", "b"), item("rws-water", "n1")]);
    expect(ctx.changes.get("nl-rotterdam")?.rivers)
      .toEqual([item("opw-hydro", "a"), item("opw-hydro", "b"), item("rws-water", "n1")]);
    expect(ctx.updateHealth).toHaveBeenCalledExactlyOnceWith("rws-water", 3, false);
  });

  it("skips request when the spec is not due and counts ARSO-style flattened matches", async () => {
    const skipped = context(); const request = vi.fn(async () => ({ body: null }));
    await ingestStationSource(spec({ isDue: () => false, request }), skipped);
    expect(request).not.toHaveBeenCalled(); expect(skipped.updateHealth).not.toHaveBeenCalled();

    const ctx = context();
    await ingestStationSource(spec({
      sourceId: "arso-hydro",
      mappings: () => [{ locationId: "si-celje", fresh: [item("arso-hydro", "6140"), item("arso-hydro", "6720")] }],
    }), ctx);
    expect(ctx.changes.get("si-celje")?.rivers).toHaveLength(2);
    expect(ctx.updateHealth).toHaveBeenCalledExactlyOnceWith("arso-hydro", 2, false);
  });

  it("runs RWS, OPW, ARSO, then IPMA observations sequentially", async () => {
    const order: string[] = []; let inFlight = 0; let maxInFlight = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      const url = String(input);
      order.push(url.includes("rijkswaterstaat") ? "rws-water" : url.includes("waterlevel.ie") ? "opw-hydro"
        : url.includes("arso.gov.si") ? "arso-hydro" : url.includes("obs-surface") ? "ipma-observations" : url);
      inFlight -= 1;
      return url.includes("arso.gov.si") ? new Response("<invalid/>") : Response.json({});
    });
    await runConditions({
      now, stateStore: new MemoryStateStore(createEmptyState(now)), fetch: fetchMock,
      env: { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true",
        CONDITIONS_DISABLED_SOURCES: conditionSourceIds.filter((id) =>
          !["rws-water", "opw-hydro", "arso-hydro", "ipma-observations"].includes(id)).join(",") },
    });
    expect(order).toEqual(["rws-water", "opw-hydro", "arso-hydro", "ipma-observations"]);
    expect(maxInFlight).toBe(1);
  });
});

describe("catalog3 conditions fixtures stay byte-stable", () => {
  it.each(stationCountries)("roundtrips serializeCatalog3Conditions for %s", (country) => {
    const path = resolveCatalog2ConditionsPath(country);
    expect(existsSync(path), `missing catalog-2 conditions fixture for ${country}`).toBe(true);
    const v2 = ConditionsV2Schema.parse(JSON.parse(readFileSync(path, "utf8")));
    const input = ConditionsV3Schema.parse({ ...v2, schemaVersion: 3, catalogVersion: 3 });
    const frozen = JSON.stringify(input);
    const wire = serializeCatalog3Conditions(input);
    expect(ConditionsV3Schema.parse(JSON.parse(wire))).toEqual(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(serializeCatalog3Conditions(JSON.parse(wire))).toBe(wire);
  });
});

describe("catalog-2 conditions fixture path resolution", () => {
  it("fails closed when neither the public nor the fixture path exists", () => {
    const country = "ZZ";
    const [publicPath, fixturePath] = catalog2ConditionsCandidates(country);
    const exists = vi.fn(() => false);
    expect(() => resolveCatalog2ConditionsPath(country, exists)).toThrow(`missing catalog-2 conditions fixture for ${country}`);
    expect(exists).toHaveBeenCalledWith(publicPath);
    expect(exists).toHaveBeenCalledWith(fixturePath);
    expect(exists).not.toHaveBeenCalledWith(`public/conditions/v2/AT.json`);
    expect(exists).not.toHaveBeenCalledWith(`tests/fixtures/legacy-catalog-2/conditions/v2/AT.json`);
  });

  it("does not substitute another country's file when both candidate paths are missing on disk", () => {
    const country = "ZZ";
    const [publicPath, fixturePath] = catalog2ConditionsCandidates(country);
    expect(existsSync(publicPath)).toBe(false);
    expect(existsSync(fixturePath)).toBe(false);
    expect(existsSync("public/conditions/v2/AT.json")).toBe(true);
    expect(() => resolveCatalog2ConditionsPath(country)).toThrow(`missing catalog-2 conditions fixture for ${country}`);
  });

  it("prefers the public path and falls back only when that file is absent", () => {
    const country = "NL";
    const [publicPath, fixturePath] = catalog2ConditionsCandidates(country);
    expect(resolveCatalog2ConditionsPath(country, (path) => path === publicPath || path === fixturePath)).toBe(publicPath);
    expect(resolveCatalog2ConditionsPath(country, (path) => path === fixturePath)).toBe(fixturePath);
    expect(() => resolveCatalog2ConditionsPath(country, () => false)).toThrow(`missing catalog-2 conditions fixture for ${country}`);
  });
});
