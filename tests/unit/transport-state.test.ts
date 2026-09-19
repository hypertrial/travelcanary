import { describe, expect, it } from "vitest";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
import { catalogV2CountryCodes } from "@/lib/domain/contract-identities";
import type { SourceHealth } from "@/lib/domain/schemas";
import { nationalWarningManifest } from "@/lib/national-warning-sources";
import { projectCoreSnapshot } from "@/lib/risk-snapshot";
import { createEmptyState } from "@/lib/risk-state";
import { deriveTransportState, type DeriveTransportStateInput } from "@/lib/transport-state";

const now = new Date("2026-09-08T12:00:00Z");
const atAlert = nationalWarningManifest.countries.AT.systems.find(({ id }) => id === "at-alert")!;
const dhmz = nationalWarningManifest.countries.HR.systems.find(({ id }) => id === "dhmz-cap")!;
const imgw = nationalWarningManifest.countries.PL.systems.find(({ id }) => id === "imgw-hydrology")!;
const vigilance = nationalWarningManifest.countries.FR.systems.find(({ id }) => id === "meteofrance-vigilance")!;
const edr = nationalWarningManifest.countries.AD.systems.find(({ id }) => id === "meteoalarm-edr")!;
const skCrisis = nationalWarningManifest.countries.SK.systems.find(({ id }) => id === "sk-crisis-rest")!;

function health(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    status: "ok", lastAttempt: now.toISOString(), lastSuccess: now.toISOString(),
    sourceUpdatedAt: "2026-09-08T11:50:00.000Z", nextExpectedUpdate: "2026-09-08T12:10:00.000Z",
    itemCount: 0, consecutiveFailures: 0, error: null, ...overrides,
  };
}

function overdue(minutes: number) {
  const last = new Date(now.getTime() - minutes * 60_000);
  return health({
    lastAttempt: last.toISOString(), lastSuccess: last.toISOString(), sourceUpdatedAt: last.toISOString(),
    nextExpectedUpdate: new Date(last.getTime() + 10 * 60_000).toISOString(),
  });
}

const cases: Array<{ name: string; input: DeriveTransportStateInput; expected: object }> = [
  {
    name: "legacy coverage ok omits freshness keys",
    input: { mode: "legacy", system: atAlert, health: health(), fallbackStatus: "failed", effectiveStatus: "ok", now },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "ok",
      sourceUpdatedAt: "2026-09-08T11:50:00.000Z", limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "expanded coverage ok always emits freshness keys",
    input: { mode: "expanded", system: atAlert, health: health(), fallbackStatus: "failed" },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "ok",
      lastSuccess: now.toISOString(), sourceUpdatedAt: "2026-09-08T11:50:00.000Z",
      nextExpectedUpdate: "2026-09-08T12:10:00.000Z", limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "legacy fallback override uses delayed-adjusted effective.status before not_monitored",
    input: { mode: "legacy", system: dhmz, health: health({ status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null }),
      fallbackStatus: "failed", effectiveStatus: "ok", now },
    expected: {
      id: "dhmz-cap", name: "DHMZ direct CAP warnings", role: "fallback", status: "ok",
      sourceUpdatedAt: "2026-09-08T11:50:00.000Z", limitationCode: null,
      officialUrl: "https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici",
    },
  },
  {
    name: "expanded folds not_monitored into the first disabled check with no fallback override",
    input: { mode: "expanded", system: dhmz, health: health({ status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null }),
      fallbackStatus: "ok" },
    expected: {
      id: "dhmz-cap", name: "DHMZ direct CAP warnings", role: "fallback", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: "2026-09-08T11:50:00.000Z", nextExpectedUpdate: null,
      limitationCode: "credential_not_configured",
      officialUrl: "https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici",
    },
  },
  {
    name: "legacy not_monitored disables after a failed fallback override and keeps a null limitation",
    input: { mode: "legacy", system: dhmz, health: health({ status: "not_monitored" }),
      fallbackStatus: "delayed", effectiveStatus: "delayed", now },
    expected: {
      id: "dhmz-cap", name: "DHMZ direct CAP warnings", role: "fallback", status: "disabled",
      sourceUpdatedAt: "2026-09-08T11:50:00.000Z", limitationCode: null,
      officialUrl: "https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici",
    },
  },
  {
    name: "legacy coverage overdue after two cadences is delayed",
    input: { mode: "legacy", system: imgw, health: overdue(21), fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "delayed",
      sourceUpdatedAt: overdue(21).sourceUpdatedAt, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "legacy coverage at the overdue boundary stays current",
    input: { mode: "legacy", system: imgw, health: overdue(20), fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "ok",
      sourceUpdatedAt: overdue(20).sourceUpdatedAt, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "expanded ignores cadence delay and keeps the raw health status",
    input: { mode: "expanded", system: imgw, health: overdue(21), fallbackStatus: "ok" },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "ok",
      lastSuccess: overdue(21).lastSuccess, sourceUpdatedAt: overdue(21).sourceUpdatedAt,
      nextExpectedUpdate: overdue(21).nextExpectedUpdate, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "legacy coverage delayed status and consecutive failures force delayed",
    input: { mode: "legacy", system: imgw, health: health({ status: "ok", consecutiveFailures: 2 }),
      fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "delayed",
      sourceUpdatedAt: "2026-09-08T11:50:00.000Z", limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "legacy unauthorized credential-gated omits freshness and keeps the system limitation",
    input: { mode: "legacy", system: vigilance, fallbackStatus: "failed", effectiveStatus: "failed", now },
    expected: {
      id: "meteofrance-vigilance", name: "Météo-France Vigilance API", role: "fallback", status: "disabled",
      sourceUpdatedAt: null, limitationCode: "source_contract_incomplete",
      officialUrl: "https://www.data.gouv.fr/dataservices/api-bulletin-vigilance",
    },
  },
  {
    name: "expanded unauthorized credential-gated still emits null freshness keys",
    input: { mode: "expanded", system: vigilance, fallbackStatus: "failed" },
    expected: {
      id: "meteofrance-vigilance", name: "Météo-France Vigilance API", role: "fallback", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "source_contract_incomplete",
      officialUrl: "https://www.data.gouv.fr/dataservices/api-bulletin-vigilance",
    },
  },
  {
    name: "expanded disabled active coverage with a null limitation uses credential_not_configured",
    input: { mode: "expanded", system: atAlert, health: health({ status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null }),
      fallbackStatus: "failed" },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: "2026-09-08T11:50:00.000Z", nextExpectedUpdate: null,
      limitationCode: "credential_not_configured", officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "legacy missing health on coverage uses the delayed-adjusted fallback status",
    input: { mode: "legacy", system: atAlert, fallbackStatus: "delayed", effectiveStatus: "delayed", now },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "delayed",
      sourceUpdatedAt: null, limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "expanded missing health uses publicProviderPartitionState as fallback only",
    input: { mode: "expanded", system: atAlert, fallbackStatus: "failed" },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "failed",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "credential-gated coverage becomes authorized only when health is present and monitored",
    input: { mode: "expanded", system: skCrisis, health: health({ status: "partial" }), fallbackStatus: "failed" },
    expected: {
      id: "sk-crisis-rest", name: "Crisis-management REST service", role: "coverage", status: "partial",
      lastSuccess: now.toISOString(), sourceUpdatedAt: "2026-09-08T11:50:00.000Z",
      nextExpectedUpdate: "2026-09-08T12:10:00.000Z", limitationCode: null,
      officialUrl: "https://portal.minv.sk/wps/esispz-api/docs/index.html",
    },
  },
  {
    name: "legacy fallback failed transport stays ok only while effective.status is ok",
    input: { mode: "legacy", system: edr, health: health({ status: "failed" }), fallbackStatus: "failed", effectiveStatus: "ok", now },
    expected: {
      id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery", role: "fallback", status: "ok",
      sourceUpdatedAt: "2026-09-08T11:50:00.000Z", limitationCode: null, officialUrl: "https://www.meteoalarm.org/",
    },
  },
  {
    name: "expanded failed transport uses the raw failed status",
    input: { mode: "expanded", system: edr, health: health({ status: "failed" }), fallbackStatus: "ok" },
    expected: {
      id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery", role: "fallback", status: "failed",
      lastSuccess: now.toISOString(), sourceUpdatedAt: "2026-09-08T11:50:00.000Z",
      nextExpectedUpdate: "2026-09-08T12:10:00.000Z", limitationCode: null, officialUrl: "https://www.meteoalarm.org/",
    },
  },
];

function snapshotTransports(value: unknown) {
  const found: Array<{ country: string; transport: Record<string, unknown> }> = [];
  const providers = (value as { providers?: Record<string, { partitions?: Record<string, { transports?: Record<string, unknown>[] }> }> }).providers || {};
  for (const provider of Object.values(providers)) {
    for (const [country, partition] of Object.entries(provider.partitions || {})) {
      for (const transport of partition.transports || []) found.push({ country, transport });
    }
  }
  return found;
}

describe("deriveTransportState", () => {
  it.each(cases)("$name", ({ input, expected }) => {
    expect(JSON.stringify(deriveTransportState(input))).toBe(JSON.stringify(expected));
  });

  it("keeps lastSuccess and nextExpectedUpdate absent from legacy JSON even when health has values", () => {
    const result = deriveTransportState({
      mode: "legacy", system: imgw, health: health(), fallbackStatus: "ok", effectiveStatus: "ok", now,
    });
    const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "lastSuccess")).toBe(false);
    expect(Object.hasOwn(parsed, "nextExpectedUpdate")).toBe(false);
    expect(Object.keys(parsed)).toEqual(["id", "name", "role", "status", "sourceUpdatedAt", "limitationCode", "officialUrl"]);
  });

  it("keeps lastSuccess and nextExpectedUpdate present on expanded JSON when values are null", () => {
    const result = deriveTransportState({ mode: "expanded", system: atAlert, fallbackStatus: "failed" });
    const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "lastSuccess")).toBe(true);
    expect(Object.hasOwn(parsed, "nextExpectedUpdate")).toBe(true);
    expect(parsed.lastSuccess).toBeNull();
    expect(parsed.nextExpectedUpdate).toBeNull();
    expect(Object.keys(parsed)).toEqual([
      "id", "name", "role", "status", "lastSuccess", "sourceUpdatedAt", "nextExpectedUpdate", "limitationCode", "officialUrl",
    ]);
  });
});

describe("core snapshot transport JSON", () => {
  it("omits lastSuccess and nextExpectedUpdate on every legacy transport after stringify", () => {
    const snapshot = projectCoreSnapshot(createEmptyState(now), now);
    const frozen = JSON.stringify(snapshot);
    const transports = snapshotTransports(JSON.parse(frozen));
    expect(transports.length).toBeGreaterThan(0);
    for (const { transport } of transports) {
      expect(Object.hasOwn(transport, "lastSuccess")).toBe(false);
      expect(Object.hasOwn(transport, "nextExpectedUpdate")).toBe(false);
      expect(Object.hasOwn(transport, "sourceUpdatedAt")).toBe(true);
    }
    const imgwJson = transports.find(({ country, transport }) => country === "PL" && transport.id === "imgw-hydrology")!.transport;
    expect(JSON.stringify(imgwJson)).toBe(JSON.stringify({
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "failed",
      sourceUpdatedAt: null, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    }));
  });

  it("emits freshness keys only on expanded catalog-3 country transports", () => {
    const snapshot = buildCatalog3Snapshot(createEmptyState(now), now);
    const frozen = JSON.stringify(snapshot);
    const transports = snapshotTransports(JSON.parse(frozen));
    const legacyCountries = new Set<string>(catalogV2CountryCodes);
    const legacy = transports.filter(({ country }) => legacyCountries.has(country));
    const expanded = transports.filter(({ country }) => !legacyCountries.has(country));
    expect(legacy.length).toBeGreaterThan(0);
    expect(expanded.length).toBeGreaterThan(0);
    for (const { transport } of legacy) {
      expect(Object.hasOwn(transport, "lastSuccess")).toBe(false);
      expect(Object.hasOwn(transport, "nextExpectedUpdate")).toBe(false);
    }
    for (const { transport } of expanded) {
      expect(Object.hasOwn(transport, "lastSuccess")).toBe(true);
      expect(Object.hasOwn(transport, "nextExpectedUpdate")).toBe(true);
    }
    const edrJson = expanded.find(({ country, transport }) => country === "AD" && transport.id === "meteoalarm-edr")!.transport;
    expect(JSON.stringify(edrJson)).toBe(JSON.stringify({
      id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery", role: "fallback", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "credential_not_configured", officialUrl: "https://www.meteoalarm.org/",
    }));
    expect(frozen.includes('"id":"imgw-hydrology","name":"IMGW hydrology warnings","role":"coverage","status":"failed","sourceUpdatedAt":null')).toBe(true);
    expect(frozen.includes('"id":"imgw-hydrology","name":"IMGW hydrology warnings","role":"coverage","status":"failed","lastSuccess"')).toBe(false);
  });
});
