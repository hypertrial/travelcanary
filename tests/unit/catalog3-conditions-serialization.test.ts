import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { ConditionsV2Schema, conditionRecords } from "@/lib/domain/conditions";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { conditionAttribution } from "@/lib/conditions/sources";
import release2 from "../../data/catalog-releases/2.json";

const countries = [...new Set(release2.locationIds.map((id) => id.slice(0, 2).toUpperCase()))];
const emptyArrays = ["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions", "limitations"];
function legacy(country: string) { return ConditionsV2Schema.parse(JSON.parse(readFileSync(`public/conditions/v2/${country}.json`, "utf8"))); }

describe("catalog3 lossless compact conditions wire", () => {
  it("omits only default-empty arrays and roundtrips every populated legacy country without mutation", () => {
    const seen = new Set<string>();
    for (const country of countries) {
      const v2 = legacy(country); const frozenV2 = JSON.stringify(v2);
      const input = ConditionsV3Schema.parse({ ...v2, schemaVersion: 3, catalogVersion: 3 }); const before = structuredClone(input);
      const wire = serializeCatalog3Conditions(input); const decoded = JSON.parse(wire);
      const normalized = ConditionsV3Schema.parse(decoded);
      expect(normalized).toEqual(input); expect(input).toEqual(before);
      expect(JSON.stringify(v2)).toBe(frozenV2);
      expect(decoded.sources).toEqual(input.sources); expect(decoded.sourceHealth).toEqual(input.sourceHealth);
      for (const [id, data] of Object.entries(input.locations)) {
        for (const [key, value] of Object.entries(data)) {
          if (emptyArrays.includes(key) && Array.isArray(value) && value.length === 0) expect(decoded.locations[id]).not.toHaveProperty(key);
          else { expect(decoded.locations[id][key]).toEqual(value); seen.add(key); }
        }
        expect(conditionRecords(normalized.locations[id])).toEqual(conditionRecords(data));
      }
    }
    for (const key of ["weather", "airQuality", "marine", "observations", "rivers", "infrastructureIncidents", "systemConditions", "limitations"]) expect(seen.has(key), key).toBe(true);
  });

  it("preserves nonempty earthquake arrays and UTF8 attribution text exactly", () => {
    const v2 = legacy("PT"); const input = ConditionsV3Schema.parse({ ...v2, schemaVersion: 3, catalogVersion: 3 });
    input.sources["ipma-seismic"] = { ...conditionAttribution("ipma-seismic"), notice: "Informação sísmica — Açores 🌊" };
    input.locations["pt-horta"].earthquakes = [{ id: "ipma:retained", sourceId: "ipma-seismic", sourceUpdatedAt: input.generatedAt,
      checkedAt: input.generatedAt, expiresAt: new Date(Date.parse(input.generatedAt) + 3600000).toISOString(), occurredAt: input.generatedAt,
      magnitude: 3, distanceKm: 0, sourceUrl: "https://www.ipma.pt/" }];
    const wire = serializeCatalog3Conditions(input);
    expect(ConditionsV3Schema.parse(JSON.parse(wire))).toEqual(input);
    expect(wire).toContain("Informação sísmica — Açores 🌊");
    expect(Buffer.byteLength(wire, "utf8")).toBe(new TextEncoder().encode(wire).byteLength);
    expect(Buffer.byteLength(wire, "utf8")).toBeGreaterThan(wire.length);
  });

  it.each(["wrong version", "wrong catalog", "invalid forecast", "missing attribution"])("rejects %s before producing wire output", (mode) => {
    const v2 = legacy("HU"); const input = ConditionsV3Schema.parse({ ...v2, schemaVersion: 3, catalogVersion: 3 });
    if (mode === "wrong version") Object.assign(input, { schemaVersion: 2 });
    if (mode === "wrong catalog") Object.assign(input, { catalogVersion: 2 });
    if (mode === "invalid forecast") input.locations["hu-budapest"].weather!.temperature[0] = 999;
    if (mode === "missing attribution") delete input.sources["open-meteo-weather"];
    expect(() => serializeCatalog3Conditions(input)).toThrow();
  });
});
