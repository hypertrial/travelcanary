import { describe, expect, it } from "vitest";
import { buildCatalog3Snapshot } from "@/lib/catalog-projections";
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
    nextExpectedUpdate: new Date(last.getTime() + (imgw.cadenceMinutes || 30) * 60_000).toISOString(),
  });
}

const freshness = {
  lastSuccess: now.toISOString(), sourceUpdatedAt: "2026-09-08T11:50:00.000Z",
  nextExpectedUpdate: "2026-09-08T12:10:00.000Z",
} as const;

const cases: Array<{ name: string; input: DeriveTransportStateInput; expected: object }> = [
  {
    name: "coverage ok always emits freshness keys",
    input: { system: atAlert, health: health(), fallbackStatus: "failed", effectiveStatus: "ok", now },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "ok", ...freshness,
      limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "fallback override uses delayed-adjusted effective.status before not_monitored",
    input: { system: dhmz, health: health({ status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null }),
      fallbackStatus: "failed", effectiveStatus: "ok", now },
    expected: {
      id: "dhmz-cap", name: "DHMZ direct CAP warnings", role: "fallback", status: "ok",
      lastSuccess: null, sourceUpdatedAt: "2026-09-08T11:50:00.000Z", nextExpectedUpdate: null,
      limitationCode: null,
      officialUrl: "https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici",
    },
  },
  {
    name: "fallback plus ok plus not_monitored stays ok via the fallback override",
    input: { system: dhmz, health: health({ status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null }),
      fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "dhmz-cap", name: "DHMZ direct CAP warnings", role: "fallback", status: "ok",
      lastSuccess: null, sourceUpdatedAt: "2026-09-08T11:50:00.000Z", nextExpectedUpdate: null,
      limitationCode: null,
      officialUrl: "https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici",
    },
  },
  {
    name: "not_monitored disables after a failed fallback override and defaults limitationCode",
    input: { system: dhmz, health: health({ status: "not_monitored" }),
      fallbackStatus: "delayed", effectiveStatus: "delayed", now },
    expected: {
      id: "dhmz-cap", name: "DHMZ direct CAP warnings", role: "fallback", status: "disabled",
      ...freshness, limitationCode: "credential_not_configured",
      officialUrl: "https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici",
    },
  },
  {
    name: "coverage overdue after two cadences is delayed",
    input: { system: imgw, health: overdue((imgw.cadenceMinutes || 30) * 2 + 1), fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "delayed",
      lastSuccess: overdue((imgw.cadenceMinutes || 30) * 2 + 1).lastSuccess, sourceUpdatedAt: overdue((imgw.cadenceMinutes || 30) * 2 + 1).sourceUpdatedAt,
      nextExpectedUpdate: overdue((imgw.cadenceMinutes || 30) * 2 + 1).nextExpectedUpdate, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "coverage at the overdue boundary stays current",
    input: { system: imgw, health: overdue((imgw.cadenceMinutes || 30) * 2), fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "ok",
      lastSuccess: overdue((imgw.cadenceMinutes || 30) * 2).lastSuccess, sourceUpdatedAt: overdue((imgw.cadenceMinutes || 30) * 2).sourceUpdatedAt,
      nextExpectedUpdate: overdue((imgw.cadenceMinutes || 30) * 2).nextExpectedUpdate, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "coverage delayed status and consecutive failures force delayed",
    input: { system: imgw, health: health({ status: "ok", consecutiveFailures: 2 }),
      fallbackStatus: "ok", effectiveStatus: "ok", now },
    expected: {
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "delayed",
      ...freshness, limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    },
  },
  {
    name: "unauthorized credential-gated emits null freshness and keeps the system limitation",
    input: { system: vigilance, fallbackStatus: "failed", effectiveStatus: "failed", now },
    expected: {
      id: "meteofrance-vigilance", name: "Météo-France Vigilance API", role: "fallback", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "source_contract_incomplete",
      officialUrl: "https://www.data.gouv.fr/dataservices/api-bulletin-vigilance",
    },
  },
  {
    name: "disabled active coverage with a null limitation uses credential_not_configured",
    input: { system: atAlert, health: health({ status: "not_monitored", lastSuccess: null, nextExpectedUpdate: null }),
      fallbackStatus: "failed", effectiveStatus: "failed", now },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: "2026-09-08T11:50:00.000Z", nextExpectedUpdate: null,
      limitationCode: "credential_not_configured", officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "missing health on coverage uses the delayed-adjusted fallback status",
    input: { system: atAlert, fallbackStatus: "delayed", effectiveStatus: "delayed", now },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "delayed",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "missing health uses publicProviderPartitionState as fallback only",
    input: { system: atAlert, fallbackStatus: "failed", effectiveStatus: "failed", now },
    expected: {
      id: "at-alert", name: "AT-Alert", role: "coverage", status: "failed",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: null, officialUrl: "https://warnung.at-alert.at/",
    },
  },
  {
    name: "credential-gated coverage becomes authorized only when health is present and monitored",
    input: { system: skCrisis, health: health({ status: "partial" }), fallbackStatus: "failed", effectiveStatus: "failed", now },
    expected: {
      id: "sk-crisis-rest", name: "Crisis-management REST service", role: "coverage", status: "partial",
      ...freshness, limitationCode: null,
      officialUrl: "https://portal.minv.sk/wps/esispz-api/docs/index.html",
    },
  },
  {
    name: "fallback failed transport stays ok only while effective.status is ok",
    input: { system: edr, health: health({ status: "failed" }), fallbackStatus: "failed", effectiveStatus: "ok", now },
    expected: {
      id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery", role: "fallback", status: "ok",
      ...freshness, limitationCode: null, officialUrl: "https://www.meteoalarm.org/",
    },
  },
  {
    name: "fallback failed transport stays failed when effective.status is not ok",
    input: { system: edr, health: health({ status: "failed" }), fallbackStatus: "ok", effectiveStatus: "failed", now },
    expected: {
      id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery", role: "fallback", status: "failed",
      ...freshness, limitationCode: null, officialUrl: "https://www.meteoalarm.org/",
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

  it("always emits lastSuccess and nextExpectedUpdate, including null when unknown", () => {
    const result = deriveTransportState({
      system: imgw, health: health(), fallbackStatus: "ok", effectiveStatus: "ok", now,
    });
    const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "id", "name", "role", "status", "lastSuccess", "sourceUpdatedAt", "nextExpectedUpdate", "limitationCode", "officialUrl",
    ]);
    expect(parsed.lastSuccess).toBe(now.toISOString());
    expect(parsed.nextExpectedUpdate).toBe("2026-09-08T12:10:00.000Z");

    const unknown = JSON.parse(JSON.stringify(deriveTransportState({
      system: atAlert, fallbackStatus: "failed", effectiveStatus: "failed", now,
    }))) as Record<string, unknown>;
    expect(Object.hasOwn(unknown, "lastSuccess")).toBe(true);
    expect(Object.hasOwn(unknown, "nextExpectedUpdate")).toBe(true);
    expect(unknown.lastSuccess).toBeNull();
    expect(unknown.nextExpectedUpdate).toBeNull();
  });
});

describe("published transport JSON", () => {
  it("emits freshness keys and limitation defaults on every core transport after stringify", () => {
    const snapshot = projectCoreSnapshot(createEmptyState(now), now);
    const frozen = JSON.stringify(snapshot);
    const transports = snapshotTransports(JSON.parse(frozen));
    expect(transports.length).toBeGreaterThan(0);
    for (const { transport } of transports) {
      expect(Object.hasOwn(transport, "lastSuccess")).toBe(true);
      expect(Object.hasOwn(transport, "nextExpectedUpdate")).toBe(true);
      expect(Object.hasOwn(transport, "sourceUpdatedAt")).toBe(true);
    }
    const imgwJson = transports.find(({ country, transport }) => country === "PL" && transport.id === "imgw-hydrology")!.transport;
    expect(JSON.stringify(imgwJson)).toBe(JSON.stringify({
      id: "imgw-hydrology", name: "IMGW hydrology warnings", role: "coverage", status: "failed",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: null, officialUrl: "https://hydro.imgw.pl/",
    }));
    expect(frozen.includes('"id":"imgw-hydrology","name":"IMGW hydrology warnings","role":"coverage","status":"failed","lastSuccess":null')).toBe(true);
  });

  it("emits freshness keys on every catalog-3 country transport", () => {
    const snapshot = buildCatalog3Snapshot(createEmptyState(now), now);
    const frozen = JSON.stringify(snapshot);
    const transports = snapshotTransports(JSON.parse(frozen));
    expect(transports.length).toBeGreaterThan(0);
    for (const { transport } of transports) {
      expect(Object.hasOwn(transport, "lastSuccess")).toBe(true);
      expect(Object.hasOwn(transport, "nextExpectedUpdate")).toBe(true);
    }
    const edrJson = transports.find(({ country, transport }) => country === "AD" && transport.id === "meteoalarm-edr")!.transport;
    expect(JSON.stringify(edrJson)).toBe(JSON.stringify({
      id: "meteoalarm-edr", name: "MeteoAlarm authenticated EDR recovery", role: "fallback", status: "disabled",
      lastSuccess: null, sourceUpdatedAt: null, nextExpectedUpdate: null,
      limitationCode: "credential_not_configured", officialUrl: "https://www.meteoalarm.org/",
    }));
    expect(frozen.includes('"id":"imgw-hydrology","name":"IMGW hydrology warnings","role":"coverage","status":"failed","lastSuccess":null')).toBe(true);
  });
});
