import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("@/lib/public-health");
});

describe("production health cache", () => {
  it("caches unavailable results for 5 seconds and sends Cache-Control no-store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    const checkPublicHealth = vi.fn()
      .mockResolvedValueOnce({ available: false, status: "degraded" })
      .mockResolvedValueOnce({ available: true, status: "ok" });
    vi.doMock("@/lib/public-health", () => ({
      checkPublicHealth,
      checkPublicationHealth: vi.fn(),
      unavailablePublicationHealth: vi.fn(),
    }));
    const route = await import("../../src/app/api/v1/health/route");
    const first = await route.GET(new Request("https://travelcanary.test/api/v1/health"));
    expect(first.status).toBe(503);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    vi.setSystemTime(new Date("2026-09-19T12:00:04.000Z"));
    await route.GET(new Request("https://travelcanary.test/api/v1/health"));
    expect(checkPublicHealth).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-19T12:00:06.000Z"));
    const recovered = await route.GET(new Request("https://travelcanary.test/api/v1/health"));
    expect(checkPublicHealth).toHaveBeenCalledTimes(2);
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=60, must-revalidate");
  });
});
