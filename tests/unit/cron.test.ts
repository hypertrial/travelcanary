import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { handleCron } from "@/lib/cron";

const originalSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("cron authentication", () => {
  it("fails closed when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await handleCron(new Request("https://example.test/api/cron/fast"), "fast")).status).toBe(503);
  });

  it("rejects a bearer token that is not an exact match", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("https://example.test/api/cron/fast", { headers: { authorization: "Bearer wrong-secret" } });
    expect((await handleCron(request, "fast")).status).toBe(401);
  });

  it("authenticates the satellite cadence and keeps its staggered two-hour schedule", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("https://example.test/api/cron/satellite", { headers: { authorization: "Bearer wrong-secret" } });
    expect((await handleCron(request, "satellite")).status).toBe(401);
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    expect(vercel.crons).toContainEqual({ path: "/api/cron/satellite", schedule: "37 */2 * * *" });
  });

  it("authenticates and schedules the daily EDO cadence", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("https://example.test/api/cron/daily", { headers: { authorization: "Bearer wrong-secret" } });
    expect((await handleCron(request, "daily")).status).toBe(401);
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    expect(vercel.crons).toContainEqual({ path: "/api/cron/daily", schedule: "47 3 * * *" });
  });
});
