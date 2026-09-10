import { AsyncLocalStorage } from "node:async_hooks";
import type { MutableSourceDiagnostics } from "./types";

const diagnosticsStorage = new AsyncLocalStorage<MutableSourceDiagnostics>();
const byteBudgetStorage = new AsyncLocalStorage<{ remaining: number }>();

export function withFetchDiagnostics<T>(diagnostics: MutableSourceDiagnostics, action: () => Promise<T>): Promise<T> {
  return diagnosticsStorage.run(diagnostics, action);
}

export function withFetchByteBudget<T>(byteBudget: { remaining: number }, action: () => Promise<T>): Promise<T> {
  return byteBudgetStorage.run(byteBudget, action);
}

function recordResponseBytes(bytes: number, category?: string) {
  const diagnostics = diagnosticsStorage.getStore();
  if (!diagnostics) return;
  diagnostics.responseBytes += bytes;
  const key = category?.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  if (!key) return;
  if (!(key in diagnostics.responseBytesByCategory) && Object.keys(diagnostics.responseBytesByCategory).length >= 16) return;
  diagnostics.responseBytesByCategory[key] = (diagnostics.responseBytesByCategory[key] || 0) + bytes;
}

function recordOverflow(code: string) {
  const diagnostics = diagnosticsStorage.getStore();
  if (!diagnostics || diagnostics.overflowCodes.includes(code) || diagnostics.overflowCodes.length >= 16) return;
  diagnostics.overflowCodes.push(code);
}

export function isAllowlistedHttpsUrl(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && hosts.includes(url.hostname);
  } catch {
    return false;
  }
}

export async function fetchAllowlisted(
  fetchImpl: typeof fetch,
  initialUrl: string,
  hosts: readonly string[],
  attempts = 3,
  options: RequestInit & { maxBytes?: number; byteBudget?: { remaining: number }; timeoutMs?: number; diagnosticsCategory?: string } = {},
): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isAllowlistedHttpsUrl(url, hosts)) throw new Error("URL is not allowlisted");
    const { maxBytes, byteBudget, timeoutMs = 5_000, diagnosticsCategory, ...init } = options;
    const response = await fetchWithRetry(fetchImpl, url, { ...init, redirect: "manual" }, attempts, maxBytes, byteBudget, timeoutMs, diagnosticsCategory);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect has no location");
    url = new URL(location, url).toString();
  }
  throw new Error("Redirect limit exceeded");
}

export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  attempts = 3,
  maxBytes = 25 * 1024 * 1024,
  byteBudget?: { remaining: number },
  timeoutMs = 5_000,
  diagnosticsCategory?: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    let reservedBytes = 0;
    let consumedBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Upstream request timed out"));
      }, timeoutMs);
    });
    try {
      const budgets = [...new Set([byteBudget, byteBudgetStorage.getStore()].filter((budget): budget is { remaining: number } => Boolean(budget)))];
      const responseLimit = budgets.length ? Math.min(maxBytes, ...budgets.map(({ remaining }) => remaining)) : maxBytes;
      if (responseLimit < 1) {
        recordOverflow("upstream_byte_budget_exhausted");
        throw new Error("Upstream byte budget exhausted");
      }
      if (budgets.length) {
        reservedBytes = responseLimit;
        for (const budget of budgets) budget.remaining -= reservedBytes;
      }
      const diagnostics = diagnosticsStorage.getStore();
      if (diagnostics) {
        diagnostics.requests += 1;
        if (attempt > 0) diagnostics.retries += 1;
      }
      const response = await Promise.race([
        fetchImpl(url, {
          ...init,
          redirect: init.redirect ?? "follow",
          signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
          headers: { "User-Agent": "TravelCanary/0.1 (+https://github.com/hypertrial/travelcanary)", ...init.headers },
        }),
        timedOut,
      ]);
      const manualRedirect = init.redirect === "manual" && response.status >= 300 && response.status < 400;
      if (!response.ok && !manualRedirect) {
        controller.abort();
        throw new Error(`Upstream returned HTTP ${response.status}`);
      }
      if (manualRedirect) return response;
      const body = response.body
        ? await Promise.race([readBytesWithLimit(response, responseLimit, (count) => {
          consumedBytes = Math.min(reservedBytes, consumedBytes + count);
          recordResponseBytes(count, diagnosticsCategory);
        }), timedOut])
        : null;
      const buffered = new Response(body?.byteLength ? body.buffer as ArrayBuffer : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      return buffered;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 1_000));
    } finally {
      clearTimeout(timeout);
      for (const budget of [...new Set([byteBudget, byteBudgetStorage.getStore()].filter((item): item is { remaining: number } => Boolean(item)))]) {
        budget.remaining += reservedBytes - consumedBytes;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upstream request failed");
}

export async function readBytesWithLimit(response: Response, maxBytes: number, consumeBytes?: (count: number) => void): Promise<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    recordOverflow("upstream_response_limit");
    throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    consumeBytes?.(value.byteLength);
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      recordOverflow("upstream_response_limit");
      await reader.cancel();
      throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function readJsonWithLimit(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBytesWithLimit(response, maxBytes)));
}

export async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
