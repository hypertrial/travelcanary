import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalRuntime = process.env.TRAVELCANARY_RUNTIME;
const originalDataDirectory = process.env.TRAVELCANARY_DATA_DIR;
const directory = mkdtempSync(join(tmpdir(), "travelcanary-api-"));

beforeAll(() => {
  process.env.TRAVELCANARY_RUNTIME = "local";
  process.env.TRAVELCANARY_DATA_DIR = directory;
});
afterAll(() => {
  if (originalRuntime === undefined) delete process.env.TRAVELCANARY_RUNTIME; else process.env.TRAVELCANARY_RUNTIME = originalRuntime;
  if (originalDataDirectory === undefined) delete process.env.TRAVELCANARY_DATA_DIR; else process.env.TRAVELCANARY_DATA_DIR = originalDataDirectory;
});

describe("local public APIs", () => {
  it("serves only exact public live keys with ETags", async () => {
    const { GET } = await import("../../src/app/live/[...path]/route");
    const context = { params: Promise.resolve({ path: ["catalogs", "3", "latest.json"] }) };
    const first = await GET(new Request("http://127.0.0.1/live/catalogs/3/latest.json"), context);
    expect(first.status).toBe(200);
    expect((await first.json()).catalogVersion).toBe(3);
    const etag = first.headers.get("etag")!;
    expect((await GET(new Request("http://127.0.0.1/live/catalogs/3/latest.json", { headers: { "if-none-match": etag } }), context)).status).toBe(304);
    expect((await GET(new Request("http://127.0.0.1/live/private"), { params: Promise.resolve({ path: ["ingestion", "state.json"] }) })).status).toBe(404);
    expect((await GET(new Request("http://127.0.0.1/live/traversal"), { params: Promise.resolve({ path: ["..", "ingestion", "state.json"] }) })).status).toBe(404);
  });

  it("returns bounded health and plugin summaries without private diagnostics", async () => {
    const health = await (await import("../../src/app/api/v1/health/route")).GET();
    expect([200, 503]).toContain(health.status);
    const healthBody = await health.json();
    expect(JSON.stringify(healthBody)).not.toContain("travelcanary.db");
    const summary = await (await import("../../src/app/api/v1/plugin/summary/route")).GET();
    const body = await summary.json();
    expect(summary.status).toBe(200);
    expect(body.destinations.length).toBeLessThanOrEqual(10);
    expect(body.counts.UNKNOWN).toBe(679);
    expect(body.restrictedSources.active).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/ingestion|acceptedManifestDigest|lastError/);
  });
});
