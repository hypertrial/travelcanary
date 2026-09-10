import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, withFetchByteBudget, withFetchDiagnostics } from "@/lib/ingestion/fetch";
import { createSourceDiagnostics } from "@/lib/ingestion/types";

describe("ingestion fetch", () => {
  afterEach(() => vi.useRealTimers());

  it("times out while a response body is still pending", async () => {
    vi.useFakeTimers();
    const request = fetchWithRetry(
      async () => new Response(new ReadableStream({ start() {} })),
      "https://example.test/feed",
      {},
      1,
    );
    const rejection = expect(request).rejects.toThrow("Upstream request timed out");

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
  });

  it("retries an attempt timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => fetchMock.mock.calls.length === 1
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }))
      : new Response("ok"));
    const request = fetchWithRetry(fetchMock as typeof fetch, "https://example.test/feed", {}, 2);

    await vi.advanceTimersByTimeAsync(5_250);
    await expect((await request).text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a failed body transfer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("body failed")); } }))
      : new Response("ok"));
    const request = fetchWithRetry(fetchMock as typeof fetch, "https://example.test/feed", {}, 2);

    await vi.runAllTimersAsync();
    await expect((await request).text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a caller-aborted request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const request = fetchWithRetry(fetchMock as typeof fetch, "https://example.test/feed", { signal: controller.signal });

    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares a hard response-byte budget across requests", async () => {
    const budget = { remaining: 10 };
    const fetchMock = (async () => new Response("123456")) as typeof fetch;

    await expect(fetchWithRetry(fetchMock, "https://example.test/feed", {}, 1, 10, budget)).resolves.toBeInstanceOf(Response);
    expect(budget.remaining).toBe(4);
    await expect(fetchWithRetry(fetchMock, "https://example.test/feed", {}, 1, 10, budget)).rejects.toThrow(/exceeds 4 bytes/);
    expect(budget.remaining).toBe(0);
  });

  it("does not oversubscribe a shared byte budget across concurrent requests", async () => {
    const budget = { remaining: 10 };
    const fetchMock = (async () => new Response("123456")) as typeof fetch;

    const first = fetchWithRetry(fetchMock, "https://example.test/first", {}, 1, 10, budget);
    const second = fetchWithRetry(fetchMock, "https://example.test/second", {}, 1, 10, budget);

    await expect(second).rejects.toThrow("Upstream byte budget exhausted");
    await expect(first).resolves.toBeInstanceOf(Response);
    expect(budget.remaining).toBe(4);
  });

  it("enforces a run-wide byte budget together with a narrower transport budget", async () => {
    const run = { remaining: 10 };
    const transport = { remaining: 8 };
    const fetchMock = (async () => new Response("123456")) as typeof fetch;
    await withFetchByteBudget(run, async () => {
      await fetchWithRetry(fetchMock, "https://example.test/first", {}, 1, 8, transport);
      await expect(fetchWithRetry(fetchMock, "https://example.test/second", {}, 1, 8, transport)).rejects.toThrow(/exceeds 2 bytes/);
    });
    expect(run.remaining).toBe(2);
    expect(transport.remaining).toBe(0);
  });

  it("records bounded request, retry, byte, and category diagnostics", async () => {
    vi.useFakeTimers();
    const diagnostics = createSourceDiagnostics();
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? new Response("retry", { status: 503 })
      : new Response("ok"));
    const request = withFetchDiagnostics(diagnostics, () => fetchWithRetry(
      fetchMock as typeof fetch, "https://example.test/feed", {}, 2, 100, undefined, 5_000, "fixture",
    ));
    await vi.advanceTimersByTimeAsync(250);
    await expect((await request).text()).resolves.toBe("ok");
    expect(diagnostics).toMatchObject({
      requests: 2, retries: 1, responseBytes: 2, responseBytesByCategory: { fixture: 2 },
    });
  });
});
