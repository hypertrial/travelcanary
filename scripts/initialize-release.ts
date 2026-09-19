import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const releaseRoutes = ["fast", "slow", "daily", "satellite", "conditions", "maintenance"] as const;
const completeStatuses = new Set(["ok", "partial", "disabled"]);
const counterKeys = ["locations", "countries", "bytes", "privateStateBytes", "cacheBytes", "durationMs", "sourceDurationMs"] as const;
const publicationCounterKeys = ["published", "unchanged", "failed", "omittedFailures"] as const;
const sourceCounterKeys = ["successful", "partial", "failed", "disabled"] as const;

type ReleaseRoute = typeof releaseRoutes[number];
type ReleaseResult = { route: ReleaseRoute; headStatus: number; getStatus: number; status: string; counters: Record<string, number> };

function configuration(env: Record<string, string | undefined>) {
  const secret = env.CRON_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("cron_secret_missing");
  const origin = new URL(env.PRODUCTION_ORIGIN || "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("production_origin_invalid");
  }
  return { secret, origin: origin.origin };
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error", cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

function normalizedBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response_malformed");
  const body = value as Record<string, unknown>;
  if (typeof body.status !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(body.status)) throw new Error("response_malformed");
  const counters: Record<string, number> = {};
  for (const key of counterKeys) if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] >= 0) counters[key] = body[key];
  if (body.publication && typeof body.publication === "object" && !Array.isArray(body.publication)) {
    const publication = body.publication as Record<string, unknown>;
    for (const key of publicationCounterKeys) {
      if (typeof publication[key] === "number" && Number.isFinite(publication[key]) && publication[key] >= 0) counters[`publication.${key}`] = publication[key];
    }
  }
  if (body.sourceSummary && typeof body.sourceSummary === "object" && !Array.isArray(body.sourceSummary)) {
    const summary = body.sourceSummary as Record<string, unknown>;
    for (const key of sourceCounterKeys) {
      if (typeof summary[key] === "number" && Number.isInteger(summary[key]) && summary[key] >= 0) counters[`sources.${key}`] = summary[key];
    }
  }
  return { status: body.status, counters };
}

export async function initializeRelease(options: {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  write?: (result: ReleaseResult) => void;
}) {
  const { origin, secret } = configuration(options.env || process.env);
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs || 315_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 330_000) throw new Error("timeout_invalid");
  const headers = { Authorization: `Bearer ${secret}` };
  const results: ReleaseResult[] = [];
  for (const route of releaseRoutes) {
    const url = `${origin}/api/cron/${route}`;
    const head = await request(fetchImpl, url, { method: "HEAD", headers }, timeoutMs);
    if (!head.ok) throw new Error("head_incomplete");
    const response = await request(fetchImpl, url, { method: "GET", headers }, timeoutMs);
    if (!response.ok) throw new Error("get_incomplete");
    const { status, counters } = normalizedBody(await response.json());
    if (!completeStatuses.has(status)) throw new Error("route_incomplete");
    const result = { route, headStatus: head.status, getStatus: response.status, status, counters };
    results.push(result); options.write?.(result);
  }
  return results;
}

async function main() {
  try {
    await initializeRelease({ write: (result) => console.log(JSON.stringify(result)) });
  } catch {
    console.error(JSON.stringify({ status: "failed", code: "release_initialization_incomplete" }));
    process.exitCode = 1;
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
