import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { catalogLocationsV3 } from "../src/lib/catalog-data";
import { MeteoAlarmAdapter, meteoAlarmFeedSlugs } from "../src/lib/ingestion/adapters/meteoalarm";
import { fetchMetOffice } from "../src/lib/ingestion/adapters/national-civil-alerts-expanded";

export type CredentialedWarningSmokeMode = "met-office" | "meteoalarm-edr";

export const credentialedWarningSmokeLimits = {
  deadlineMs: 20_000,
  maxRequests: 64,
  maxBytes: 8 * 1024 * 1024,
} as const;

type Counters = { requests: number; networkRequests: number; bytes: number };
type SmokeSummary = Counters & {
  mode: CredentialedWarningSmokeMode;
  status: "passed";
  countries: readonly string[];
  events: number;
  checkedLocations: number;
  primaryFailures?: number;
  recoveries?: number;
  durationMs: number;
};

class SmokeFailure extends Error {
  constructor(readonly code: "invalid_mode" | "credential_not_configured" | "deadline_exceeded" | "request_limit_exceeded" | "byte_limit_exceeded" | "unexpected_request" | "smoke_failed") {
    super(code);
  }
}

function combineSignals(signal: AbortSignal | null | undefined, deadline: AbortSignal) {
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function readBounded(response: Response, counters: Counters) {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > credentialedWarningSmokeLimits.maxBytes - counters.bytes) {
    throw new SmokeFailure("byte_limit_exceeded");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    counters.bytes += value.byteLength;
    if (counters.bytes > credentialedWarningSmokeLimits.maxBytes) {
      await reader.cancel();
      throw new SmokeFailure("byte_limit_exceeded");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function boundedNetworkFetch(fetchImpl: typeof fetch, input: string | URL | Request, init: RequestInit | undefined, deadline: AbortSignal, counters: Counters) {
  counters.requests += 1;
  counters.networkRequests += 1;
  if (counters.requests > credentialedWarningSmokeLimits.maxRequests) throw new SmokeFailure("request_limit_exceeded");
  if (deadline.aborted) throw new SmokeFailure("deadline_exceeded");
  const response = await fetchImpl(input, { ...init, signal: combineSignals(init?.signal, deadline) });
  const body = await readBounded(response, counters);
  return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function syntheticResponse(body: string, counters: Counters) {
  counters.requests += 1;
  if (counters.requests > credentialedWarningSmokeLimits.maxRequests) throw new SmokeFailure("request_limit_exceeded");
  const bytes = Buffer.byteLength(body);
  counters.bytes += bytes;
  if (counters.bytes > credentialedWarningSmokeLimits.maxBytes) throw new SmokeFailure("byte_limit_exceeded");
  return new Response(body, { headers: { "content-type": "application/atom+xml" } });
}

async function runMetOffice(fetchImpl: typeof fetch, now: Date, deadline: AbortSignal, counters: Counters) {
  if (!process.env.MET_OFFICE_API_KEY?.trim() || !process.env.MET_OFFICE_WARNINGS_FEED_URL?.trim()) {
    throw new SmokeFailure("credential_not_configured");
  }
  const configured = new URL(process.env.MET_OFFICE_WARNINGS_FEED_URL);
  const smokeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:" || url.hostname !== configured.hostname || !(url.hostname === "metoffice.gov.uk" || url.hostname.endsWith(".metoffice.gov.uk"))) {
      throw new SmokeFailure("unexpected_request");
    }
    return boundedNetworkFetch(fetchImpl, input, init, deadline, counters);
  };
  const locations = catalogLocationsV3.filter(({ countryCode }) => countryCode === "GB");
  const result = await fetchMetOffice({ now, locations, fetch: smokeFetch, signal: deadline, deadlineAt: Date.now() + credentialedWarningSmokeLimits.deadlineMs });
  if (result.status !== "ok" || result.checkedLocationIds?.length !== locations.length) throw new SmokeFailure("smoke_failed");
  return { countries: ["GB"] as const, events: result.events.length, checkedLocations: result.checkedLocationIds.length };
}

async function runMeteoAlarmEdr(fetchImpl: typeof fetch, now: Date, deadline: AbortSignal, counters: Counters) {
  if (!process.env.METEOALARM_API_TOKEN?.trim()) throw new SmokeFailure("credential_not_configured");
  const primaryFailures = new Set<string>();
  const empty = `<?xml version="1.0"?><feed><updated>${now.toISOString()}</updated></feed>`;
  const smokeFetch: typeof fetch = async (input, init) => {
    if (deadline.aborted) throw new SmokeFailure("deadline_exceeded");
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "feeds.meteoalarm.org") {
      const country = Object.entries(meteoAlarmFeedSlugs).find(([, slug]) => url.pathname.endsWith(`-${slug}`))?.[0];
      if (country === "AD" || country === "IS") {
        counters.requests += 1;
        if (counters.requests > credentialedWarningSmokeLimits.maxRequests) throw new SmokeFailure("request_limit_exceeded");
        primaryFailures.add(country);
        throw new Error("intentional_primary_failure");
      }
      return syntheticResponse(empty, counters);
    }
    if (url.hostname === "api.meteoalarm.org") {
      const country = url.pathname.match(/\/locations\/(AD|IS)$/)?.[1];
      if (!country || !primaryFailures.has(country)) throw new SmokeFailure("unexpected_request");
    } else if (url.hostname !== "storage.meteoalarm.org") {
      throw new SmokeFailure("unexpected_request");
    }
    return boundedNetworkFetch(fetchImpl, input, init, deadline, counters);
  };
  const result = await new MeteoAlarmAdapter().fetch({
    now, locations: catalogLocationsV3, fetch: smokeFetch, signal: deadline,
    deadlineAt: Date.now() + credentialedWarningSmokeLimits.deadlineMs,
  });
  const countries = ["AD", "IS"] as const;
  const partitions = result.partitions as unknown as Record<string, {
    status: string; limitationCode?: string; events: unknown[];
    transports?: Record<string, { status: string }>;
  }>;
  const recovered = countries.filter((country) => {
    const partition = partitions[country];
    const transports = Object.values(partition.transports || {});
    return partition.status === "partial" && partition.limitationCode === "national_authority_fallback"
      && transports.some(({ status }) => status === "failed")
      && partition.transports?.["meteoalarm-edr"]?.status === "ok";
  });
  if (primaryFailures.size !== countries.length || recovered.length !== countries.length) throw new SmokeFailure("smoke_failed");
  return {
    countries, events: countries.reduce((total, country) => total + partitions[country].events.length, 0),
    checkedLocations: catalogLocationsV3.filter(({ countryCode }) => countries.includes(countryCode as "AD" | "IS")).length,
    primaryFailures: primaryFailures.size, recoveries: recovered.length,
  };
}

export async function runCredentialedWarningSmoke(mode: CredentialedWarningSmokeMode, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<SmokeSummary> {
  if (mode !== "met-office" && mode !== "meteoalarm-edr") throw new SmokeFailure("invalid_mode");
  const started = performance.now();
  const counters: Counters = { requests: 0, networkRequests: 0, bytes: 0 };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SmokeFailure("deadline_exceeded");
      controller.abort(error);
      reject(error);
    }, credentialedWarningSmokeLimits.deadlineMs);
  });
  try {
    const action = mode === "met-office"
      ? runMetOffice(fetchImpl, now, controller.signal, counters)
      : runMeteoAlarmEdr(fetchImpl, now, controller.signal, counters);
    const result = await Promise.race([action, deadline]);
    return { mode, status: "passed", ...result, ...counters, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (controller.signal.aborted) throw new SmokeFailure("deadline_exceeded");
    throw error instanceof SmokeFailure ? error : new SmokeFailure("smoke_failed");
  } finally {
    clearTimeout(timer!);
  }
}

export function credentialedWarningSmokeFailure(error: unknown) {
  return { status: "failed" as const, code: error instanceof SmokeFailure ? error.code : "smoke_failed" };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "met-office" && mode !== "meteoalarm-edr") {
    console.log(JSON.stringify({ status: "failed", code: "invalid_mode" }));
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(await runCredentialedWarningSmoke(mode)));
  } catch (error) {
    console.log(JSON.stringify({ mode, ...credentialedWarningSmokeFailure(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
