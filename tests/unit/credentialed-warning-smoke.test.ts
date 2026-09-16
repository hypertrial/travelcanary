import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialedWarningSmokeFailure,
  credentialedWarningSmokeLimits,
  runCredentialedWarningSmoke,
} from "../../scripts/smoke-credentialed-warnings";

const now = new Date("2026-09-16T10:00:00Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("credentialed warning release smokes", () => {
  it("rejects an invalid library mode before reading credentials or making requests", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const error = await runCredentialedWarningSmoke("invalid" as never, fetchMock, now).catch((value) => value);
    expect(credentialedWarningSmokeFailure(error)).toEqual({ status: "failed", code: "invalid_mode" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["met-office" as const, "MET_OFFICE_API_KEY", "MET_OFFICE_WARNINGS_FEED_URL"],
    ["meteoalarm-edr" as const, "METEOALARM_API_TOKEN", null],
  ])("fails %s before any request when credentials are absent", async (mode, key, endpoint) => {
    vi.stubEnv(key, "");
    if (endpoint) vi.stubEnv(endpoint, "");
    const fetchMock = vi.fn<typeof fetch>();
    await expect(runCredentialedWarningSmoke(mode, fetchMock, now)).rejects.toThrow("credential_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs Met Office against only the configured allowlisted host and GB catalog-3 locations", async () => {
    vi.stubEnv("MET_OFFICE_API_KEY", "met-office-secret");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
      return url.endsWith("/feed")
        ? new Response(`<feed><updated>${now.toISOString()}</updated><link rel="related" href="https://warnings.api.metoffice.gov.uk/v1.0/objects/issued/current"/></feed>`)
        : Response.json({ type: "FeatureCollection", features: [] });
    });
    const summary = await runCredentialedWarningSmoke("met-office", fetchMock, now);
    expect(summary).toMatchObject({ status: "passed", countries: ["GB"], checkedLocations: 30, events: 0, requests: 2, networkRequests: 2 });
    expect(calls.every(({ url }) => new URL(url).hostname === "warnings.api.metoffice.gov.uk")).toBe(true);
    expect(calls.every(({ headers }) => headers.get("x-api-key") === "met-office-secret")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("https:");
  });

  it.each([
    "http://warnings.api.metoffice.gov.uk/feed",
    "https://attacker.example/feed",
    "not a URL",
  ])("rejects an unsafe or malformed Met Office endpoint before making a request: %s", async (endpoint) => {
    vi.stubEnv("MET_OFFICE_API_KEY", "met-office-secret");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", endpoint);
    const fetchMock = vi.fn<typeof fetch>();
    const error = await runCredentialedWarningSmoke("met-office", fetchMock, now).catch((value) => value);
    expect(credentialedWarningSmokeFailure(error)).toMatchObject({ status: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(credentialedWarningSmokeFailure(error))).not.toContain("met-office-secret");
    expect(JSON.stringify(credentialedWarningSmokeFailure(error))).not.toContain(endpoint);
  });

  it("forces AD and IS primary failures before real EDR recovery and keeps all other primaries synthetic", async () => {
    vi.stubEnv("METEOALARM_API_TOKEN", "edr-secret");
    vi.stubEnv("IFRC_FALLBACK_ENABLED", "false");
    const networkUrls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input); networkUrls.push(url);
      return new Response(null, { status: 204 });
    });
    const summary = await runCredentialedWarningSmoke("meteoalarm-edr", fetchMock, now);
    expect(summary).toMatchObject({ status: "passed", countries: ["AD", "IS"], primaryFailures: 2, recoveries: 2, networkRequests: 2, events: 0 });
    expect(networkUrls).toHaveLength(2);
    expect(networkUrls.map((url) => new URL(url).hostname)).toEqual(["api.meteoalarm.org", "api.meteoalarm.org"]);
    expect(networkUrls.map((url) => new URL(url).pathname.match(/\/locations\/(AD|IS)$/)?.[1])).toEqual(["AD", "IS"]);
    expect(JSON.stringify(summary)).not.toContain("edr-secret");
  });

  it("fails before the request beyond the command-wide request ceiling", async () => {
    vi.stubEnv("MET_OFFICE_API_KEY", "secret");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    const maxRequests = vi.spyOn(credentialedWarningSmokeLimits, "maxRequests", "get")
      .mockReturnValue(1 as typeof credentialedWarningSmokeLimits.maxRequests);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      `<feed><updated>${now.toISOString()}</updated><link rel="related" href="https://warnings.api.metoffice.gov.uk/v1.0/objects/issued/current"/></feed>`,
    ));
    try {
      const error = await runCredentialedWarningSmoke("met-office", fetchMock, now).catch((value) => value);
      expect(credentialedWarningSmokeFailure(error)).toEqual({ status: "failed", code: "request_limit_exceeded" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      maxRequests.mockRestore();
    }
  });

  it("fails closed at the command-wide byte ceiling without exposing upstream data", async () => {
    vi.stubEnv("MET_OFFICE_API_KEY", "secret-value");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("x", {
      headers: { "content-length": String(credentialedWarningSmokeLimits.maxBytes + 1) },
    }));
    const error = await runCredentialedWarningSmoke("met-office", fetchMock, now).catch((value) => value);
    expect(credentialedWarningSmokeFailure(error)).toEqual({ status: "failed", code: "byte_limit_exceeded" });
    expect(JSON.stringify(credentialedWarningSmokeFailure(error))).not.toContain("secret-value");
  });

  it("enforces the byte ceiling on streamed bodies without a Content-Length header", async () => {
    vi.stubEnv("MET_OFFICE_API_KEY", "secret-value");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    const oversized = new Uint8Array(credentialedWarningSmokeLimits.maxBytes + 1);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    })));
    const error = await runCredentialedWarningSmoke("met-office", fetchMock, now).catch((value) => value);
    expect(credentialedWarningSmokeFailure(error)).toEqual({ status: "failed", code: "byte_limit_exceeded" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts credentials and upstream response details from failures", async () => {
    vi.stubEnv("METEOALARM_API_TOKEN", "edr-super-secret");
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(
      "upstream rejected Bearer edr-super-secret at https://api.meteoalarm.org/private",
    ));
    const error = await runCredentialedWarningSmoke("meteoalarm-edr", fetchMock, now).catch((value) => value);
    const failure = credentialedWarningSmokeFailure(error);
    expect(failure).toEqual({ status: "failed", code: "smoke_failed" });
    expect(JSON.stringify(failure)).not.toContain("edr-super-secret");
    expect(JSON.stringify(failure)).not.toContain("api.meteoalarm.org");
  });

  it("aborts the whole command at the fixed deadline", async () => {
    vi.stubEnv("MET_OFFICE_API_KEY", "secret");
    vi.stubEnv("MET_OFFICE_WARNINGS_FEED_URL", "https://warnings.api.metoffice.gov.uk/feed");
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => (
      realSetTimeout(callback, delay === credentialedWarningSmokeLimits.deadlineMs ? 1 : delay, ...args)
    )) as typeof setTimeout);
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(runCredentialedWarningSmoke("met-office", fetchMock, now)).rejects.toThrow("deadline_exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
