import { z } from "zod";
import mappingJson from "../../../data/rws-water-mapping.json";
import { ObservationSchema, type Observation } from "../domain/conditions";
import { distanceKm } from "../geospatial";

export const rwsWaterMappings = mappingJson.mappings;
export const rwsWaterEndpoint = "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen";
const qualityCodes = ["00", "10", "20", "25", "30", "40"] as const;
const qualityStatus = { Ongecontroleerd: "provisional", Gecontroleerd: "checked", Definitief: "final" } as const;
const responseSchema = z.object({
  Succesvol: z.literal(true),
  WaarnemingenLijst: z.array(z.object({
    AquoMetadata: z.object({
      Compartiment: z.object({ Code: z.literal("OW") }), Eenheid: z.object({ Code: z.literal("cm") }),
      Grootheid: z.object({ Code: z.literal("WATHTE") }), Hoedanigheid: z.object({ Code: z.literal("NAP") }),
      ProcesType: z.literal("meting"),
    }),
    Locatie: z.object({ Code: z.string(), Coordinatenstelsel: z.literal("ETRS89"), Lat: z.number(), Lon: z.number(), Naam: z.string().min(1).max(120) }),
    MetingenLijst: z.array(z.object({
      Meetwaarde: z.object({ Waarde_Numeriek: z.number().finite() }), Tijdstip: z.string().datetime({ offset: true }),
      WaarnemingMetadata: z.object({ Kwaliteitswaardecode: z.string(), Statuswaarde: z.string() }),
    })).max(8),
  })).max(256),
});

export function rwsWaterRequest() {
  return {
    LocatieLijst: rwsWaterMappings.map(({ stationId }) => ({ Code: stationId })),
    AquoPlusWaarnemingMetadataLijst: [{
      AquoMetadata: { Compartiment: { Code: "OW" }, Grootheid: { Code: "WATHTE" }, Eenheid: { Code: "cm" }, Hoedanigheid: { Code: "NAP" }, ProcesType: "meting" },
      WaarnemingMetadata: { KwaliteitswaardecodeLijst: qualityCodes },
    }],
  };
}

export function parseRwsWater(value: unknown, now: Date): Map<string, Observation> {
  const response = responseSchema.parse(value);
  const observations = new Map<string, Observation>();
  for (const row of response.WaarnemingenLijst) {
    const mapping = rwsWaterMappings.find(({ stationId }) => stationId === row.Locatie.Code);
    if (!mapping) throw new Error(`Rijkswaterstaat returned an unrequested station: ${row.Locatie.Code}`);
    if (distanceKm(mapping.coordinates as [number, number], [row.Locatie.Lon, row.Locatie.Lat]) > 0.25) throw new Error(`Rijkswaterstaat station coordinates changed: ${row.Locatie.Code}`);
    for (const measurement of row.MetingenLijst) {
      if (!qualityCodes.includes(measurement.WaarnemingMetadata.Kwaliteitswaardecode as typeof qualityCodes[number])) throw new Error("Rijkswaterstaat returned an undocumented quality code");
      const status = qualityStatus[measurement.WaarnemingMetadata.Statuswaarde as keyof typeof qualityStatus];
      if (!status) throw new Error("Rijkswaterstaat returned an undocumented quality status");
      const observed = Date.parse(measurement.Tijdstip);
      if (observed > now.getTime() + 300_000 || now.getTime() - observed >= 2 * 3_600_000) continue;
      const value = measurement.Meetwaarde.Waarde_Numeriek;
      if (value < -2_000 || value > 20_000) throw new Error("Rijkswaterstaat returned an implausible NAP water level");
      const observation = ObservationSchema.parse({ sourceId: "rws-water", sourceUpdatedAt: new Date(observed).toISOString(), observedAt: new Date(observed).toISOString(),
        checkedAt: now.toISOString(), expiresAt: new Date(observed + 2 * 3_600_000).toISOString(), stationId: mapping.stationId,
        stationName: row.Locatie.Naam, sourceUrl: "https://rijkswaterstaatdata.nl/waterdata/", distanceKm: mapping.distanceKm,
        datum: "NAP", qualityCode: measurement.WaarnemingMetadata.Kwaliteitswaardecode, qualityStatus: status,
        measurements: [{ metric: "water-level", value, unit: "cm" }] });
      const previous = observations.get(mapping.stationId);
      if (!previous || Date.parse(previous.observedAt) < observed) observations.set(mapping.stationId, observation);
    }
  }
  return observations;
}
