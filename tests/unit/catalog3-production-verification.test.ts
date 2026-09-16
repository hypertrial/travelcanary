import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { verifyProduction } from "../../scripts/verify-production";
import { createEmptyState } from "@/lib/risk-state";
import { buildCatalog3Snapshot, buildCatalog3Conditions } from "@/lib/catalog-projections";
import { serializeCatalog3Conditions } from "@/lib/conditions/serialization";
import { conditionAttribution } from "@/lib/conditions/sources";
import { ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { catalog3ConditionsCountryLimit } from "@/lib/conditions/publication-budget";
import release2 from "../../data/catalog-releases/2.json";

const origin = "https://travelcanary.test"; const url = "https://unit.public.blob.vercel-storage.com/catalogs/3/latest.json";
const now = new Date("2026-09-09T00:00:00Z"); const sha = "a".repeat(40);
function fixture() {
  const state = createEmptyState(now); state.collection = { catalogVersion: 3, revision: 1 };
  const healthy = { status: "ok" as const, lastAttempt: now.toISOString(), lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(),
    nextExpectedUpdate: new Date(+now + 60 * 60_000).toISOString(), itemCount: 0, consecutiveFailures: 0, error: null };
  for (const [id, value] of Object.entries(state.sources)) if (value.status !== "not_monitored") state.sources[id as keyof typeof state.sources] = { ...healthy };
  for (const [id, value] of Object.entries(state.providers)) if (value.status !== "not_monitored") state.providers[id as keyof typeof state.providers] = { ...healthy };
  for (const partitions of Object.values(state.sourcePartitions)) for (const value of Object.values(partitions)) if (value.status !== "not_monitored") Object.assign(value, healthy);
  for (const countries of Object.values(state.partitionTransports)) for (const transports of Object.values(countries)) {
    for (const value of Object.values(transports)) if (value.status !== "not_monitored") Object.assign(value, healthy);
  }
  for (const id of ["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "pse-energy-compass"] as const) state.conditions.health[id] = { checkedAt: now.toISOString(), status: "ok", matched: 0, code: null };
  const catalogWire = readFileSync("public/catalogs/3/locations.json", "utf8"); const catalog = JSON.parse(catalogWire);
  const legacyIds = new Set<string>(release2.locationIds);
  const added = catalog.filter(({ id }: { id: string }) => !legacyIds.has(id)).map(({ id }: { id: string }) => id);
  state.expandedSourceHealth.usgs = { health: { ...healthy }, checkedLocationIds: added, unavailableLocationIds: [] };
  state.expandedSourceHealth["slf-avalanche"] = { health: { ...healthy }, checkedLocationIds: ["li-malbun"], unavailableLocationIds: [] };
  const snapshot = buildCatalog3Snapshot(state, now);
  const files = buildCatalog3Conditions(state, now, { LOCAL_CONDITIONS_ENABLED: "true", NONCOMMERCIAL_DATA_ENABLED: "true", VERCEL_GIT_COMMIT_SHA: sha });
  const html = `<meta name="travelcanary-data-mode" content="live"><meta name="travelcanary-catalog-version" content="3"><meta name="travelcanary-snapshot" content="${url}"><meta name="travelcanary-release" content="${sha}"><meta name="travelcanary-local-conditions" content="enabled"><meta name="travelcanary-noncommercial" content="enabled">`;
  const bodies = new Map([[origin + "/", html], [origin + "/catalogs/3/locations.json", catalogWire], [url, JSON.stringify(snapshot)]]);
  for (const file of files) bodies.set(new URL(`conditions/v3/${file.countryCode}.json`, url).href, serializeCatalog3Conditions(file));
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => { const body = bodies.get(String(input)); return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } }); });
  return { snapshot, catalog, files, bodies, fetch,
    verify: (expectedCatalogVersion: 2 | 3 = 3) => verifyProduction({ origin, now, expectedSha: sha, expectedCatalogVersion, fetch }) };
}

describe("catalog3 production contract verification", () => {
  it("measures exactly679 destinations,45 countries and161 marine targets using versioned URLs", async () => {
    const f = fixture(); const report = await f.verify();
    expect(report.metrics).toMatchObject({ schemaVersion: 11, catalogVersion: 3, locations: 679, snapshotUrl: url,
      conditions: { countries: 45, locations: 679, releaseMatches: 45, releaseMismatches: 0, byProduct: { weather: { eligible: 679 }, airQuality: { eligible: 679 }, marine: { eligible: 161 } } } });
    expect(Object.keys(report.metrics.coverageMeasurement!.byCountry)).toHaveLength(45);
    expect(report.metrics.coverageMeasurement!.byCountry.GB.applicable).toBeGreaterThan(30);
    expect(report.metrics.coverageMeasurement).toMatchObject({
      totals: { applicable: 11_799, fullyChecked: 2_867, partlyChecked: 2_877, notChecked: 6_055 },
      tiers: { lifeSafety: { applicable: 7_237, fullyChecked: 2_853, partlyChecked: 2_226, notChecked: 2_158 } },
    });
    expect(f.fetch.mock.calls.filter(([input]) => String(input).includes("/conditions/v3/"))).toHaveLength(45);
    expect(f.fetch.mock.calls.some(([input]) => /\/conditions\/v2\/|\/locations\.json$/.test(String(input)) && !String(input).includes("/catalogs/3/"))).toBe(false);
    expect(report.blockers.some(({ code }) => ["snapshot_invalid", "catalog_invalid", "conditions_publication_invalid"].includes(code))).toBe(false);
    // The pending projection remains honest about unsupported capabilities;
    // reviewed applicability excludes non-relevant destination/hazard pairs.
    expect(report.metrics.coverageMeasurement!.byHazard.volcano.notChecked).toBeGreaterThan(0);
    expect(report.metrics.coverageMeasurement!.byHazard["fire-danger"].notChecked).toBeGreaterThan(0);
  });

  it("blocks an unexpected catalog version", async () => {
    expect((await fixture().verify(2)).blockers).toContainEqual(expect.objectContaining({ code: "catalog_version_unexpected" }));
  });

  it("blocks changed catalog applicability that regresses the exact coverage contract", async () => {
    const f = fixture();
    f.catalog.find(({ id }: { id: string }) => id === "gb-aberdeen").isCoastal = false;
    f.bodies.set(origin + "/catalogs/3/locations.json", JSON.stringify(f.catalog));
    expect((await f.verify()).blockers).toContainEqual(expect.objectContaining({ code: "coverage_capability_regression" }));
  });

  it.each(["missing", "failed", "stale"])("keeps %s optional Met Office transport health neutral", async (mode) => {
    const f = fixture();
    const transport = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .find(({ id }) => id === "met-office-nswws")!;
    if (mode === "missing") f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .filter(({ id }) => id !== "met-office-nswws");
    else if (mode === "failed") Object.assign(transport, { status: "failed", lastSuccess: new Date(+now - 5 * 60_000).toISOString(),
      nextExpectedUpdate: new Date(+now + 5 * 60_000).toISOString() });
    else Object.assign(transport, { status: "ok", lastSuccess: new Date(+now - 30 * 60_000).toISOString(),
      nextExpectedUpdate: new Date(+now - 20 * 60_000).toISOString() });
    f.bodies.set(url, JSON.stringify(f.snapshot));
    expect((await f.verify()).blockers).not.toContainEqual(expect.objectContaining({ code: "required_transport_unhealthy",
      message: expect.stringContaining("transport/GB/met-office-nswws") }));
  });

  it("still blocks a missing non-optional national coverage transport", async () => {
    const f = fixture();
    f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .filter(({ id }) => id !== "ea-flood");
    f.bodies.set(url, JSON.stringify(f.snapshot));

    expect((await f.verify()).blockers).toContainEqual(expect.objectContaining({
      code: "required_transport_unhealthy", message: expect.stringContaining("transport/GB/ea-flood"),
    }));
  });

  it("authorizes configured credential-gated EDR transport health without granting coverage", async () => {
    const f = fixture();
    const before = (await f.verify()).metrics.coverageMeasurement!.byCountry.AD;
    f.snapshot.providers.meteoalarm.partitions!.AD.transports = [{ id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery",
      role: "fallback", status: "ok", lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      nextExpectedUpdate: new Date(+now + 360 * 60_000).toISOString(), limitationCode: null, officialUrl: "https://www.meteoalarm.org/" }];
    f.bodies.set(url, JSON.stringify(f.snapshot));
    const report = await f.verify();
    expect(report.blockers).not.toContainEqual(expect.objectContaining({ code: "unauthorized_transport_active", message: expect.stringContaining("AD/meteoalarm-edr") }));
    expect(report.metrics.coverageMeasurement!.byCountry.AD).toEqual(before);
  });

  it("authorizes configured optional Met Office transport health without granting coverage", async () => {
    const f = fixture();
    const before = (await f.verify()).metrics.coverageMeasurement!.byCountry.GB;
    const transport = f.snapshot.providers["national-civil-alerts"].partitions!.GB.transports!
      .find(({ id }) => id === "met-office-nswws")!;
    Object.assign(transport, { status: "ok", lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      nextExpectedUpdate: new Date(+now + 10 * 60_000).toISOString(), limitationCode: null });
    f.bodies.set(url, JSON.stringify(f.snapshot));
    const report = await f.verify();
    expect(report.blockers).not.toContainEqual(expect.objectContaining({ code: "unauthorized_transport_active",
      message: expect.stringContaining("GB/met-office-nswws") }));
    expect(report.metrics.coverageMeasurement!.byCountry.GB).toEqual(before);
  });

  it("blocks runtime activity for evidence-gated country transports", async () => {
    const f = fixture();
    f.snapshot.providers.meteoalarm.partitions!.BA.transports = [{ id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery",
      role: "context", status: "ok", lastSuccess: now.toISOString(), sourceUpdatedAt: now.toISOString(),
      nextExpectedUpdate: new Date(+now + 360 * 60_000).toISOString(), limitationCode: null, officialUrl: "https://www.meteoalarm.org/" }];
    f.bodies.set(url, JSON.stringify(f.snapshot));
    expect((await f.verify()).blockers).toContainEqual(expect.objectContaining({ code: "unauthorized_transport_active",
      message: expect.stringContaining("BA/meteoalarm-edr") }));
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
