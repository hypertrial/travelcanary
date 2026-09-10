import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { verifyProduction } from "../../scripts/verify-production";
import { createEmptyState } from "@/lib/risk-state";
import { buildPendingCatalog3Snapshot, buildCatalog3Conditions } from "@/lib/catalog-projections";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { catalogLocationsV3 } from "@/lib/catalog-data";
import { conditionAttribution } from "@/lib/conditions/sources";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { catalog3ConditionsCountryLimit } from "@/lib/conditions/publication-budget";
import release2 from "../../data/catalog-releases/2.json";

const origin = "https://travelcanary.test"; const url = "https://unit.public.blob.vercel-storage.com/catalogs/3/latest.json";
const now = new Date("2026-09-09T00:00:00Z"); const sha = "a".repeat(40);
function fixture() {
  const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
  for (const id of ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"] as const) state.conditions.health[id] = { checkedAt: now.toISOString(), status: "ok", matched: 0, code: null };
  const snapshot = buildPendingCatalog3Snapshot(state, now); const catalogWire = readFileSync("public/catalogs/3/locations.json", "utf8"); const catalog = JSON.parse(catalogWire);
  const files = buildCatalog3Conditions(state, now, { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: sha });
  const html = `<meta name="travelcanary-data-mode" content="live"><meta name="travelcanary-catalog-version" content="3"><meta name="travelcanary-snapshot" content="${url}"><meta name="travelcanary-release" content="${sha}"><meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">`;
  const bodies = new Map([[origin + "/", html], [origin + "/catalogs/3/locations.json", catalogWire], [url, JSON.stringify(snapshot)]]);
  for (const file of files) bodies.set(new URL(`conditions/v3/${file.countryCode}.json`, url).href, serializeCatalog3Conditions(file));
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => { const body = bodies.get(String(input)); return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } }); });
  return { snapshot, catalog, files, bodies, fetch, verify: () => verifyProduction({ origin, now, expectedSha: sha, fetch }) };
}

describe("catalog3 production contract verification", () => {
  it("measures exactly679 destinations,45 countries and161 marine targets using versioned URLs", async () => {
    const f = fixture(); const report = await f.verify();
    expect(report.metrics).toMatchObject({ schemaVersion: 11, catalogVersion: 3, locations: 679, snapshotUrl: url,
      conditions: { countries: 45, locations: 679, releaseMatches: 45, releaseMismatches: 0, byProduct: { weather: { eligible: 679 }, airQuality: { eligible: 679 }, marine: { eligible: 161 } } } });
    expect(Object.keys(report.metrics.coverageMeasurement!.byCountry)).toHaveLength(45);
    expect(report.metrics.coverageMeasurement!.byCountry.GB.applicable).toBeGreaterThan(30);
    expect(f.fetch.mock.calls.filter(([input]) => String(input).includes("/conditions/v3/"))).toHaveLength(45);
    expect(f.fetch.mock.calls.some(([input]) => /\/conditions\/v2\/|\/locations\.json$/.test(String(input)) && !String(input).includes("/catalogs/3/"))).toBe(false);
    expect(report.blockers.some(({ code }) => ["snapshot_invalid", "catalog_invalid", "conditions_publication_invalid"].includes(code))).toBe(false);
    // Every added destination contributes unsupported volcano and fire-danger
    // pairs even though the legacy applicability map has no entries for them.
    const added = catalogLocationsV3.filter(({ id }) => !release2.locationIds.includes(id)).length;
    expect(report.metrics.coverageMeasurement!.byHazard.volcano.notChecked).toBeGreaterThanOrEqual(added);
    expect(report.metrics.coverageMeasurement!.byHazard["fire-danger"].notChecked).toBeGreaterThanOrEqual(added);
  });

  it.each(["namespace", "wire version", "catalog IDs", "metadata version"])("rejects a wrong %s contract", async (mode) => {
    const f = fixture();
    if (mode === "namespace") f.bodies.set(origin + "/", f.bodies.get(origin + "/")!.replace(url, url.replace("/catalogs/3", "")));
    if (mode === "metadata version") f.bodies.set(origin + "/", f.bodies.get(origin + "/")!.replace('content="3"', 'content="4"'));
    if (mode === "wire version") f.bodies.set(url, JSON.stringify({ ...f.snapshot, schemaVersion: 10, catalogVersion: 2 }));
    if (mode === "catalog IDs") { f.catalog[f.catalog.length - 1] = f.catalog[0]; f.bodies.set(origin + "/catalogs/3/locations.json", JSON.stringify(f.catalog)); }
    const report = await f.verify();
    const code = { namespace: "snapshot_url_missing", "metadata version": "catalog_version_invalid", "wire version": "snapshot_invalid", "catalog IDs": "catalog_invalid" }[mode];
    expect(report.blockers).toContainEqual(expect.objectContaining({ code })); expect(report.metrics.coverageMeasurement).toBeUndefined();
  });

  it("rejects an otherwise valid unapproved new-country source record and source-health claim", async () => {
    const f = fixture(); const gb = f.files.find(({ countryCode }) => countryCode === "GB")!;
    gb.sources["met-norway"] = conditionAttribution("met-norway");
    gb.locations["gb-london"].weather = { sourceId: "met-norway", sourceUpdatedAt: null, checkedAt: now.toISOString(), expiresAt: new Date(+now + 3600000).toISOString(), startAt: now.toISOString(), stepMinutes: 60,
      temperature: [10], wind: [1], gusts: [2], precipitationProbability: [0], precipitation: [0], weatherCode: [0] };
    gb.sourceHealth["met-norway"] = { status: "ok", checkedAt: now.toISOString(), limitationCode: null };
    expect(ConditionsV3Schema.safeParse(gb).success).toBe(true);
    f.bodies.set(new URL("conditions/v3/GB.json", url).href, serializeCatalog3Conditions(gb));
    expect((await f.verify()).blockers).toContainEqual(expect.objectContaining({ code: "conditions_unauthorized_source" }));
  });

  it("bounds actual country wire bytes while still checking the other44 country files", async () => {
    const f = fixture(); const path = new URL("conditions/v3/VA.json", url).href; const body = f.bodies.get(path)!;
    f.bodies.set(path, body + " ".repeat(catalog3ConditionsCountryLimit("VA") + 1 - Buffer.byteLength(body)));
    const report = await f.verify(); expect(report.blockers).toContainEqual(expect.objectContaining({ code: "conditions_publication_invalid" }));
    expect(report.metrics.conditions!.countries).toBe(44);
  });

  it("reports stale and mismatched producer files without presenting them as a complete matching release", async () => {
    const f = fixture(); const va = f.files.find(({ countryCode }) => countryCode === "VA")!;
    va.generatedAt = new Date(+now - 76 * 60000).toISOString(); va.producerCommitSha = "b".repeat(40);
    f.bodies.set(new URL("conditions/v3/VA.json", url).href, serializeCatalog3Conditions(va));
    const report = await f.verify(); expect(report.metrics.conditions).toMatchObject({ countries: 45, releaseMatches: 44, releaseMismatches: 1 });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "conditions_publication_overdue" }));
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "conditions_sha_mismatch" }));
  });
});
