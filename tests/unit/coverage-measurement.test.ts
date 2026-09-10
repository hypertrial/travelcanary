import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildSnapshot, createEmptyState } from "@/lib/risk";
import { parseLatvianWarnings } from "@/lib/ingestion/adapters/national-civil-alerts-lv";
import { providerRegistry } from "@/lib/provider-registry";
import { describe, expect, it } from "vitest";
import demo from "../../public/demo-snapshot.json";
import { locations } from "@/lib/data";
import { SnapshotSchema } from "@/lib/domain/schemas";
import { measureCapture, measureCoverage } from "../../scripts/coverage-measurement";
import { summarizeCoverageHistory } from "../../scripts/coverage-history";

const snapshot = () => SnapshotSchema.parse(structuredClone(demo));
describe("effective coverage measurements", () => {
  it("counts applicable destination-hazard pairs and separates freshness from completeness", () => {
    const value = snapshot(); const now = new Date(value.generatedAt);
    const current = measureCoverage(value, locations, now);
    const expired = measureCoverage(value, locations, new Date(now.getTime() + 31 * 60_000));
    expect(current.byHazard.coastal.applicable).toBe(152);
    expect(current.byHazard.volcano.applicable).toBe(118);
    expect(current.byHazard.avalanche.applicable).toBe(18);
    expect(current.byHazard.volcano.notChecked).toBe(118);
    expect(expired.totals).toMatchObject({ applicable: current.totals.applicable,
      fullyChecked: current.totals.fullyChecked, partlyChecked: current.totals.partlyChecked,
      freshFullyChecked: 0, freshPartlyChecked: 0, delayed: current.totals.fullyChecked + current.totals.partlyChecked });
    expect(current.totals.applicable).toBe(current.totals.fullyChecked + current.totals.partlyChecked + current.totals.notChecked);
    expect(Object.values(current.byCountry).reduce((sum, item) => sum + item.applicable, 0)).toBe(current.totals.applicable);
    expect(expired.contractSha256).toBe(current.contractSha256);
    expect(measureCoverage(value, [...locations].reverse(), now).contractSha256).toBe(current.contractSha256);
  });
  it("fingerprints registry policy changes", () => {
    const value = snapshot(); const now = new Date(value.generatedAt);
    const before = measureCoverage(value, locations, now);
    const mode = providerRegistry.meteoalarm.mode;
    try {
      providerRegistry.meteoalarm.mode = "disabled";
      expect(measureCoverage(value, locations, now).contractSha256).not.toBe(before.contractSha256);
    } finally { providerRegistry.meteoalarm.mode = mode; }
  });
  it("captures the recorded official Latvian flood incident after parsing and public snapshot generation", () => {
    const now = new Date("2026-09-07T08:00:00Z");
    const tables = JSON.parse(gunzipSync(readFileSync("tests/fixtures/warning-expansion/lvgmc-tables.json.gz")).toString());
    const state = createEmptyState(now);
    state.events = parseLatvianWarnings(tables, { locations, now, fetch }, "2026-09-06T04:50:21.969Z").events;
    const cases = [{ id: "lvgmc-28067", headline: "An official yellow water-level warning affects Liepāja.",
      hazard: "flood", sourceUpdatedAt: "2026-09-06T04:50:21.969Z",
      evidenceUrl: "https://data.gov.lv/dati/dataset/hidrometeorologiskie-bridinajumi", locationIds: ["lv-liepaja"] }];
    expect(measureCapture(buildSnapshot(state, now), cases)).toEqual([{ id: "lvgmc-28067", expected: ["lv-liepaja"], captured: ["lv-liepaja"], missed: [], unexpected: [] }]);
  });
  it("rejects mismatched catalog, duplicate IDs and invalid dates", () => {
    const value = snapshot(); const now = new Date(value.generatedAt);
    expect(() => measureCoverage(value, locations.slice(1), now)).toThrow(/catalog/);
    expect(() => measureCoverage(value, [...locations, locations[0]], now)).toThrow(/catalog/);
    expect(() => measureCoverage(value, locations, new Date(NaN))).toThrow(/time/);
  });
  it("reports sample trends without mixing contracts or duplicating samples", () => {
    const value = snapshot(); const now = new Date(value.generatedAt);
    const first = { metrics: { coverageMeasurement: measureCoverage(value, locations, now) } };
    const second = { metrics: { coverageMeasurement: measureCoverage(value, locations, new Date(now.getTime() + 31 * 60_000)) } };
    const report = summarizeCoverageHistory([second, first]);
    expect(report.samples).toBe(2);
    expect(report.last.freshFullyChecked).toBe(0);
    expect(report.meanFreshFullyCheckedPairs).toBe(first.metrics.coverageMeasurement.totals.freshFullyChecked / 2);
    expect(() => summarizeCoverageHistory([first, first])).toThrow(/Duplicate/);
    second.metrics.coverageMeasurement.contractSha256 = "a".repeat(64);
    expect(() => summarizeCoverageHistory([first, second])).toThrow(/contracts differ/);
    expect(() => summarizeCoverageHistory([])).toThrow(/1–366/);
    expect(() => summarizeCoverageHistory([{}])).toThrow();
  });
  it("checks evidence-specific sample capture and reports both missed and unexpected destinations", () => {
    const value = snapshot();
    const [id, state] = Object.entries(value.locations).find(([, item]) => item.hazards.length)!;
    const event = state.hazards[0];
    const sample = { id: "reviewed-sample", headline: event.headline, sourceUpdatedAt: event.evidence[0].sourceUpdatedAt, hazard: event.type, evidenceUrl: event.evidence[0].sourceUrl, locationIds: [id] };
    const result = measureCapture(value, [sample])[0];
    expect(result.captured).toContain(id);
    expect(result.missed).toEqual([]);
    expect(measureCapture(value, [{ ...sample, evidenceUrl: "https://example.test/different-incident" }])[0].missed).toEqual([id]);
    expect(() => measureCapture(value, [{ ...sample, locationIds: ["unknown"] }])).toThrow(/Unknown/);
    expect(() => measureCapture(value, [sample, sample])).toThrow(/Duplicate/);
    event.id = "new-cluster-primary";
    expect(measureCapture(value, [sample])[0].captured).toContain(id);
    const otherId = Object.keys(value.locations).find((candidate) => candidate !== id)!;
    value.locations[otherId].hazards = [structuredClone(event)];
    expect(measureCapture(value, [sample])[0].unexpected).toContain(otherId);
    expect(measureCapture(value, [{ ...sample, sourceUpdatedAt: "2000-01-01T00:00:00Z" }])[0].missed).toEqual([id]);
  });
});
