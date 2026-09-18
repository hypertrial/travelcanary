import { describe, expect, it } from "vitest";
import { initializeRelease, releaseRoutes } from "../../scripts/initialize-release";

const secret = "a-secret-with-at-least-thirty-two-bytes";
const env = { CRON_SECRET: secret, PRODUCTION_ORIGIN: "https://travelcanary.example" };

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

describe("release initialization", () => {
  it("requires the cron secret from the environment", async () => {
    await expect(initializeRelease({ env: { PRODUCTION_ORIGIN: env.PRODUCTION_ORIGIN }, fetch: async () => response({ status: "ok" }) }))
      .rejects.toThrow("cron_secret_missing");
  });

  it("authenticates HEAD before GET for the fixed route order and emits only safe aggregates", async () => {
    const calls: Array<{ path: string; method: string }> = []; const written: unknown[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); const method = init?.method || "GET";
      calls.push({ path: url.pathname, method });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      return method === "HEAD" ? new Response(null) : response({ status: "ok", locations: 679,
        publication: { published: 45, manifestSha256: "secret-manifest" }, error: "secret-upstream-detail" });
    };
    const results = await initializeRelease({ env, fetch: fetchImpl as typeof fetch, write: (result) => written.push(result) });
    expect(calls).toEqual(releaseRoutes.flatMap((route) => [
      { path: `/api/cron/${route}`, method: "HEAD" }, { path: `/api/cron/${route}`, method: "GET" },
    ]));
    expect(results).toHaveLength(6);
    expect(written[0]).toEqual({ route: "fast", headStatus: 200, getStatus: 200, status: "ok",
      counters: { locations: 679, "publication.published": 45 } });
    expect(JSON.stringify(written)).not.toContain("secret-manifest");
    expect(JSON.stringify(written)).not.toContain("secret-upstream-detail");
    expect(JSON.stringify(written)).not.toContain(secret);
  });

  it("stops on busy, authorization failure, non-2xx, or malformed output", async () => {
    for (const next of [response({ status: "busy" }), response({ status: "ok" }, 401), response({ nope: "ok" })]) {
      let requests = 0;
      await expect(initializeRelease({ env, fetch: (async (_input, init) => {
        requests += 1; return init?.method === "HEAD" ? new Response(null) : next.clone();
      }) as typeof fetch })).rejects.toThrow();
      expect(requests).toBe(2);
    }
    let headRequests = 0;
    await expect(initializeRelease({ env, fetch: (async () => { headRequests += 1; return new Response(null, { status: 401 }); }) as typeof fetch }))
      .rejects.toThrow("head_incomplete");
    expect(headRequests).toBe(1);
  });

  it("aborts a route at the configured deadline", async () => {
    const fetchImpl = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    await expect(initializeRelease({ env, fetch: fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({ name: "AbortError" });
  });
});
