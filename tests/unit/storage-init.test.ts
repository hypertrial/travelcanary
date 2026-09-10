import { describe, expect, it } from "vitest";
import type { get, put } from "@vercel/blob";
import { CollectionChangedError } from "@/lib/domain/catalog-state";
import { initializeStorage } from "../../scripts/init-storage";

function memoryBlob() {
  const values = new Map<string, string>();
  let writes = 0;
  let failLatestOnce = false;
  const getBlob = (async (pathname: string) => {
    const value = values.get(pathname);
    if (value === undefined) return null;
    return {
      statusCode: 200 as const, stream: new Blob([value]).stream(), headers: new Headers(),
      blob: { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname, contentDisposition: "inline", cacheControl: "60", uploadedAt: new Date(), etag: String(writes), contentType: "application/json", size: value.length },
    };
  }) as typeof get;
  const putBlob = (async (pathname: string, body: unknown) => {
    if (pathname === "latest.json" && failLatestOnce) { failLatestOnce = false; throw new Error("temporary public-store failure"); }
    const value = typeof body === "string" ? body : await new Response(body as BodyInit).text();
    values.set(pathname, value); writes += 1;
    return { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname, contentType: "application/json", contentDisposition: "inline", etag: String(writes) };
  }) as typeof put;
  return { values, get writes() { return writes; }, getBlob, putBlob, failNextLatest() { failLatestOnce = true; } };
}

describe("storage initialization", () => {
  it("resumes safely after a partial cross-store failure", async () => {
    const blob = memoryBlob();
    blob.failNextLatest();
    const options = { privateToken: "private", publicToken: "public", now: new Date("2026-08-25T10:00:00Z"), getBlob: blob.getBlob, putBlob: blob.putBlob };

    await expect(initializeStorage(options)).rejects.toThrow("temporary public-store failure");
    expect([...blob.values.keys()]).toEqual(["ingestion-state.json"]);
    await expect(initializeStorage(options)).resolves.toMatchObject({ initialized: true, latestUrl: "https://blob.example/latest.json" });
    expect([...blob.values.keys()].sort()).toEqual(["ingestion-state.json", "latest.json", "previous.json"]);
    expect(JSON.parse(blob.values.get("ingestion-state.json")!)).toMatchObject({
      schemaVersion: 14,
      publicationTransition: null,
      collection: { catalogVersion: 2, revision: 0 },
      sourcePartitions: { meteoalarm: expect.any(Object), eea: expect.any(Object), nationalCivilAlerts: expect.any(Object) },
      partitionTransports: { meteoalarm: expect.any(Object), nationalCivilAlerts: expect.any(Object) },
    });

    const writes = blob.writes;
    await expect(initializeStorage(options)).resolves.toMatchObject({ initialized: false });
    expect(blob.writes).toBe(writes);
  });

  it.each(["complete", "partial"] as const)("rejects catalog3 %s initialization without creating or changing objects", async (mode) => {
    const blob = memoryBlob();
    const options = { privateToken: "private", publicToken: "public", now: new Date("2026-08-25T10:00:00Z"), getBlob: blob.getBlob, putBlob: blob.putBlob };
    await initializeStorage(options);
    const state = JSON.parse(blob.values.get("ingestion-state.json")!);
    state.collection = { catalogVersion: 3, revision: 1 };
    blob.values.set("ingestion-state.json", JSON.stringify(state));
    if (mode === "partial") blob.values.delete("latest.json");
    const before = new Map(blob.values); const writes = blob.writes;
    await expect(initializeStorage(options)).rejects.toBeInstanceOf(CollectionChangedError);
    expect(blob.values).toEqual(before); expect(blob.writes).toBe(writes);
  });

  it("refuses to fill a partial setup that already contains live state", async () => {
    const blob = memoryBlob();
    const options = { privateToken: "private", publicToken: "public", now: new Date("2026-08-25T10:00:00Z"), getBlob: blob.getBlob, putBlob: blob.putBlob };
    await initializeStorage(options);
    const state = JSON.parse(blob.values.get("ingestion-state.json")!);
    state.sources.usgs.lastSuccess = "2026-08-25T10:00:00.000Z";
    blob.values.set("ingestion-state.json", JSON.stringify(state));
    blob.values.delete("latest.json");
    const writes = blob.writes;

    await expect(initializeStorage(options)).rejects.toThrow("non-bootstrap data");
    expect(blob.values.has("latest.json")).toBe(false);
    expect(blob.writes).toBe(writes);
  });
});
