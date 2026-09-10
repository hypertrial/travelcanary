import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import booleanIntersects from "@turf/boolean-intersects";
import { point } from "@turf/helpers";
import type { FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import catalog from "../../data/review-inputs/europe-expansion-catalog.json";
import dossier from "../../data/review-inputs/europe-expansion-sources.json";
import legacy from "../../data/locations.json";
import release3 from "../../data/catalog-releases/3.json";
import { HazardTypeSchema, LocationSchema, PublicLocationSchema } from "@/lib/domain/schemas";
import { normalizeSearchTerm } from "@/lib/ui-presentation";
import { parseOpenMeteo, type ForecastKind } from "@/lib/conditions/forecast";
import { distanceKm } from "@/lib/geospatial";

// Review inputs deliberately do not widen the current production country enum.
const targets = { AL: 12, AD: 5, BY: 8, BA: 10, IS: 12, XK: 6, LI: 3, MD: 8, MC: 1, ME: 8, MK: 8, NO: 20, SM: 2, RS: 12, GB: 30, VA: 1, TR: 30 };
const candidateSchema = LocationSchema.extend({
  countryCode: z.string().refine((code) => code in targets),
  coverageRef: z.string().refine((code) => code in targets),
  sourceRegionCodes: LocationSchema.shape.sourceRegionCodes.extend({ meteoalarm: z.array(z.string().min(2)) }),
});
const publicCandidateSchema = PublicLocationSchema.extend({ countryCode: candidateSchema.shape.countryCode });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("European expansion review inputs", () => {
  it("accounts for all459 assessed categories without activating them", () => {
    let rows = 0;
    for (const country of Object.values(dossier.countries)) {
      const report = readFileSync(country.assessmentReport, "utf8");
      for (const assessment of [...Object.values(country.hazards), ...Object.values(country.conditions)]) {
        rows += 1;
        expect(assessment.reviewState).toBe("assessed");
        expect(assessment.assessmentReport).toBe(country.assessmentReport);
        expect(report).toContain(assessment.assessment);
      }
      for (const hazard of Object.values(country.hazards)) expect(hazard.coverage).toBe("not_monitored");
    }
    expect(rows).toBe(459);
    for (const source of Object.values(dossier.sourceReviews)) {
      expect(["activate", "blocked", "official-link-only", "excluded"]).toContain(source.decision);
      expect(source.activationStatus).toBe("not-activated-for-expanded-catalog");
      for (const report of source.assessmentReports) expect(readFileSync(report, "utf8").length).toBeGreaterThan(100);
    }
  });

  it("retains the attributable SLF winter geometry and an explicitly empty current sample", () => {
    for (const sample of dossier.slfSamples) {
      const bytes = readFileSync(sample.path);
      expect(bytes.byteLength).toBe(sample.bytes);
      expect(hash(bytes)).toBe(sample.sha256);
      expect(sample.license).toBe("CC-BY-4.0");
    }
    expect(JSON.parse(readFileSync(dossier.slfSamples[0].path, "utf8")).features).toEqual([]);
    const winter = JSON.parse(readFileSync(dossier.slfSamples[1].path, "utf8")) as FeatureCollection<Polygon, { regions: { regionID: string }[] }>;
    const bulletin = winter.features.find(({ properties }) => properties.regions.some(({ regionID }) => regionID === "CH-3311"));
    expect(bulletin).toBeDefined();
    const malbun = catalog.locations.find(({ id }) => id === "li-malbun")!;
    expect(booleanIntersects(bulletin!, point(malbun.centroid))).toBe(true);
    expect(dossier.sourceReviews["slf-liechtenstein"].eligibleLocationIds).toEqual([malbun.id]);
    // This verifies a retained winter bulletin, not a fresh warning or town eligibility.
  });

  it("freezes catalog3 identities from the independently reviewed roster without activating them", () => {
    expect(release3.catalogVersion).toBe(3);
    expect(release3.identityStatus).toBe("frozen");
    expect(release3.activationStatus).toBe("not-activated");
    expect(release3.provenance.legacyCatalogSha256).toBe(catalog.baseline.sha256);
    expect(release3.provenance.reviewedRosterSha256).toBe(hash(readFileSync("data/review-inputs/europe-expansion-catalog.json")));
    expect(release3.locationIds).toEqual([...legacy, ...catalog.locations].map(({ id }) => id).sort());
    expect(new Set(release3.locationIds).size).toBe(679);
    expect(new Set(release3.locationIds.map((id) => id.slice(0, 2))).size).toBe(45);
  });

  it("preserves the exact legacy catalog and adds the agreed country allocations without ID collisions", () => {
    expect(hash(readFileSync("data/locations.json"))).toBe(catalog.baseline.sha256);
    expect(legacy).toHaveLength(catalog.baseline.locationCount);
    expect(catalog.baseline.locationCount).toBe(503);
    expect(Object.fromEntries(Object.entries(catalog.countries).map(([code, value]) => [code, value.target]))).toEqual(targets);
    const candidates = candidateSchema.array().parse(catalog.locations);
    for (const [code, count] of Object.entries(targets)) {
      expect(candidates.filter((location) => location.countryCode === code)).toHaveLength(count);
    }
    const all = [...legacy, ...candidates];
    expect(all).toHaveLength(679);
    expect(new Set(all.map(({ id }) => id)).size).toBe(all.length);
    expect(new Set(all.map(({ countryCode }) => countryCode)).size).toBe(45);
    for (const location of candidates) {
      expect(location.coverageRef).toBe(location.countryCode);
      expect(location.id.startsWith(`${location.countryCode.toLowerCase()}-`)).toBe(true);
      expect(() => new Intl.DateTimeFormat("en", { timeZone: location.timezone })).not.toThrow();
      expect(location.provenance.name).toMatch(/^https:\/\/www\.geonames\.org\/\d+$/);
      expect(location.geometry).toMatchObject({ kind: "radius", center: location.centroid });
    }
  });

  it("fits the unchanged public catalog limit using the actual public projection", () => {
    const publicLocations = [
      ...PublicLocationSchema.array().parse(legacy),
      ...publicCandidateSchema.array().parse(catalog.locations),
    ];
    expect(Buffer.byteLength(`${JSON.stringify(publicLocations)}\n`)).toBeLessThanOrEqual(150_000);
    // This measures the existing projection, not a future release envelope or scope field.
  });

  it("supports reviewed non-decomposing Latin spellings and avoids ambiguous exact aliases", () => {
    const queries = { "no-bodo": "Bodo", "no-tromso": "Tromso", "no-svolvaer": "Svolvaer", "is-egilsstadir": "Egilsstadir", "is-isafjordur": "Isafjordur", "by-gomel": "Gomel", "by-grodno": "Grodno", "by-mogilev": "Mogilev" };
    for (const [id, query] of Object.entries(queries)) {
      const location = catalog.locations.find((entry) => entry.id === id)!;
      expect([location.name, ...location.aliases].map(normalizeSearchTerm)).toContain(normalizeSearchTerm(query));
    }
    // Existing same-name cities may be disambiguated by country. New aliases may not
    // introduce two exact matches inside one country, including its existing entries.
    const owners = new Map<string, string>();
    for (const location of [...legacy, ...catalog.locations]) {
      for (const name of [location.name, ...location.aliases]) {
        const key = `${location.countryCode}:${normalizeSearchTerm(name)}`;
        if (owners.has(key)) expect(owners.get(key), key).toBe(location.id);
        owners.set(key, location.id);
      }
    }
  });

  it("keeps microstate footprints local and labels representative regional scope for later UI activation", () => {
    for (const location of catalog.locations) {
      if (["VA", "MC", "LI", "SM"].includes(location.countryCode)) expect(location.geometry.radiusKm).toBeLessThanOrEqual(1);
      if (["island", "park", "mountain"].includes(location.type)) {
        expect(location).toHaveProperty("scope", "local-area");
        expect(location).toHaveProperty("scopeNote");
      }
    }
    expect(catalog.locations.filter((location) => location.countryCode === "NO").every((location) => location.centroid[1] < 72)).toBe(true);
    expect(catalog.locations.some((location) => location.id === "tr-van" && location.centroid[0] > 43)).toBe(true);
    expect(catalog.locations.find((location) => location.id === "tr-ankara")?.country).toBe("Türkiye");
  });

  it("accounts for every hazard and conditions category without granting unreviewed coverage", () => {
    expect(Object.keys(dossier.countries).sort()).toEqual(Object.keys(targets).sort());
    for (const country of Object.values(dossier.countries)) {
      expect(Object.keys(country.hazards).sort()).toEqual([...HazardTypeSchema.options].sort());
      expect(Object.keys(country.conditions).sort()).toEqual(["weather", "air-quality", "marine", "airport-observation", "hydrology", "transport", "utilities"].sort());
      for (const assessment of [...Object.values(country.hazards), ...Object.values(country.conditions)]) {
        expect(assessment.gate.length).toBeGreaterThan(20);
        for (const id of assessment.candidateSourceIds) expect(dossier.sourceReviews).toHaveProperty(id);
      }
      for (const assessment of Object.values(country.hazards)) {
        if (assessment.reviewState === "pending") expect(assessment.coverage).toBe("not_monitored");
      }
    }
  });

  it("retains immutable, attributable Atom samples, including healthy-empty and stale-content cases", () => {
    const samples = dossier.meteoalarmSamples.samples;
    expect(samples.map(({ country }) => country).sort()).toEqual(["AD", "BA", "GB", "IS", "MD", "ME", "MK", "NO", "RS"]);
    expect(dossier.meteoalarmSamples.license).toBe("CC-BY-4.0");
    const parser = new XMLParser({ removeNSPrefix: true });
    for (const sample of samples) {
      const bytes = readFileSync(sample.path);
      expect(bytes.byteLength).toBe(sample.bytes);
      expect(hash(bytes)).toBe(sample.sha256);
      expect(sample.url).toMatch(/^https:\/\/feeds\.meteoalarm\.org\/feeds\/meteoalarm-legacy-atom-/);
      expect(XMLValidator.validate(bytes.toString())).toBe(true);
      const feed = parser.parse(bytes.toString()).feed;
      expect(feed).toBeDefined();
      expect(feed.updated).toBe(sample.updated);
      const entries = feed.entry ? [feed.entry].flat() : [];
      expect(entries).toHaveLength(sample.entries);
      if (sample.country === "IS") {
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((entry) => Date.parse(entry.expires) < Date.parse(dossier.meteoalarmSamples.checkedAt))).toBe(true);
      }
    }
  });

  it("replays every sampled forecast point and preserves unavailable marine outcomes", () => {
    for (const [kind, sample] of Object.entries(dossier.forecastSamples)) {
      const fixtures = new Map(sample.fixtures.map((fixture) => {
        const bytes = readFileSync(fixture.path);
        expect(bytes.byteLength).toBe(fixture.bytes);
        expect(hash(bytes)).toBe(fixture.sha256);
        return [fixture.path, JSON.parse(bytes.toString())];
      }));
      expect(sample.failures).toEqual([]);
      const candidates = catalog.locations.filter((location) => kind !== "marine" || location.isCoastal);
      expect(sample.rows.map(({ id }) => id).sort()).toEqual(candidates.map(({ id }) => id).sort());
      for (const row of sample.rows) {
        const value = fixtures.get(row.sample)[row.index];
        const parse = () => parseOpenMeteo(value, kind as ForecastKind, new Date(sample.checkedAt));
        if (row.status === "unavailable") {
          expect(parse).toThrow(/representative data/);
        } else {
          expect(parse).not.toThrow();
          const point = candidates.find(({ id }) => id === row.id)!.centroid as [number, number];
          expect(distanceKm(point, [value.longitude, value.latitude])).toBeLessThanOrEqual(kind === "airQuality" ? 50 : 25);
        }
      }
    }
  });

  it("preserves specialist fixture identity and recorded failure outcomes", () => {
    for (const sample of dossier.specialistSamples.samples) {
      if (typeof sample.path !== "string") {
        if ("retention" in sample) {
          expect(sample.retention).toBe("metadata-only-pending-reuse");
          expect(sample.status).toBe(200);
          expect(sample.sha256).toMatch(/^[a-f0-9]{64}$/);
          expect(sample.retentionReason).toBeTruthy();
        } else {
          expect(sample).toHaveProperty("error");
        }
        continue;
      }
      const bytes = readFileSync(sample.path);
      expect(hash(bytes)).toBe(sample.sha256);
      expect(bytes.byteLength).toBe(sample.bytes);
      expect(sample.status).toBe(200);
      if (sample.path.endsWith(".xml")) expect(XMLValidator.validate(bytes.toString())).toBe(true);
      else expect(Array.isArray(JSON.parse(bytes.toString()))).toBe(true);
    }
  });
});
