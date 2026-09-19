import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { handleCron } from "@/lib/cron";
import { CollectionChangedError } from "@/lib/domain/catalog-state";
import * as lease from "@/lib/ingestion-lease";
import * as orchestrator from "@/lib/ingestion/orchestrator";
import { StateLimitError } from "@/lib/ingestion/limits";
import { PublicationRaceError } from "@/lib/operation-failure";
import { ConcurrencyError } from "@/lib/state-store";

const originalSecret = process.env.CRON_SECRET;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalPrivateToken = process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
const originalPublicToken = process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
const originalPrivateStoreId = process.env.PRIVATE_INGESTION_STORE_ID;
const originalPublicStoreId = process.env.PUBLIC_SNAPSHOT_STORE_ID;
const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalPrivateToken === undefined) delete process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
  else process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN = originalPrivateToken;
  if (originalPublicToken === undefined) delete process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
  else process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN = originalPublicToken;
  if (originalPrivateStoreId === undefined) delete process.env.PRIVATE_INGESTION_STORE_ID;
  else process.env.PRIVATE_INGESTION_STORE_ID = originalPrivateStoreId;
  if (originalPublicStoreId === undefined) delete process.env.PUBLIC_SNAPSHOT_STORE_ID;
  else process.env.PUBLIC_SNAPSHOT_STORE_ID = originalPublicStoreId;
  if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cron authentication", () => {
  it("fails closed when no secret is configured", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.CRON_SECRET;
    expect((await handleCron(new Request("https://example.test/api/cron/fast"), "fast")).status).toBe(503);
  });

  it("rejects a bearer token that is not an exact match", async () => {
    process.env.VERCEL_ENV = "production"; process.env.CRON_SECRET = "correct-secret-that-is-at-least-32-bytes";
    const request = new Request("https://example.test/api/cron/fast", { headers: { authorization: "Bearer wrong-secret" } });
    expect((await handleCron(request, "fast")).status).toBe(401);
  });

  it("authenticates the satellite cadence and keeps its staggered two-hour schedule", async () => {
    process.env.VERCEL_ENV = "production"; process.env.CRON_SECRET = "correct-secret-that-is-at-least-32-bytes";
    const request = new Request("https://example.test/api/cron/satellite", { headers: { authorization: "Bearer wrong-secret" } });
    expect((await handleCron(request, "satellite")).status).toBe(401);
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    expect(vercel.crons).toContainEqual({ path: "/api/cron/satellite", schedule: "37 */2 * * *" });
  });

  it("authenticates and schedules the daily EDO cadence", async () => {
    process.env.VERCEL_ENV = "production"; process.env.CRON_SECRET = "correct-secret-that-is-at-least-32-bytes";
    const request = new Request("https://example.test/api/cron/daily", { headers: { authorization: "Bearer wrong-secret" } });
    expect((await handleCron(request, "daily")).status).toBe(401);
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    expect(vercel.crons).toContainEqual({ path: "/api/cron/daily", schedule: "47 3 * * *" });
  });

  it("redacts storage failures from authenticated responses and logs", async () => {
    const sentinel = "https://blob.example/private?token=secret-sentinel";
    process.env.VERCEL_ENV = "production";
    process.env.CRON_SECRET = "correct-secret-that-is-at-least-32-bytes";
    delete process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
    delete process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
    process.env.PRIVATE_INGESTION_STORE_ID = "store_private";
    process.env.PUBLIC_SNAPSHOT_STORE_ID = "store_public";
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(sentinel); }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleCron(new Request("https://example.test/api/cron/fast", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }), "fast");
    const output = JSON.stringify({ body: await response.json(), logs: log.mock.calls });
    expect(response.status).toBe(500);
    expect(output).toContain("operation_failed");
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain("secret-sentinel");
  });

  it.each([
    [new ConcurrencyError("lease lost"), "concurrency"],
    [new CollectionChangedError("collection moved"), "collection_changed"],
    [new PublicationRaceError("Private state changed during publication"), "state_changed_during_publication"],
    [new StateLimitError("Private ingestion state exceeds 5 MB hard limit"), "state_limit"],
    [new Error("secret-sentinel"), "operation_failed"],
  ] as const)("returns and logs classified code %s", async (error, code) => {
    process.env.VERCEL_ENV = "production";
    process.env.CRON_SECRET = "correct-secret-that-is-at-least-32-bytes";
    process.env.PRIVATE_INGESTION_STORE_ID = "store_private";
    process.env.PUBLIC_SNAPSHOT_STORE_ID = "store_public";
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    delete process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
    delete process.env.PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN;
    vi.spyOn(lease, "acquireIngestionLease").mockResolvedValue({
      owner: "vercel-fast", fence: 1, expiresAt: "2099-01-01T00:00:00.000Z", collectionRevision: 1,
    });
    vi.spyOn(lease, "releaseIngestionLease").mockResolvedValue(undefined);
    vi.spyOn(orchestrator, "runIngestion").mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleCron(new Request("https://example.test/api/cron/fast", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }), "fast");
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Ingestion failed", code });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ event: "ingestion_failed", operation: "fast", code });
  });
});
