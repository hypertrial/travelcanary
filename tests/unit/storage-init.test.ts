import { describe, expect, it } from "vitest";
import type { get, put } from "@vercel/blob";
import { IngestionStateV16Schema } from "@/lib/domain/catalog-state";
import { readCurrentPublication } from "@/lib/publication-store";
import { initializeStorage } from "../../scripts/init-storage";
import { MemoryPublicationStore } from "../helpers/publication";

function memoryBlob() {
  const values = new Map<string, { body: string; etag: number }>(); let revision = 0;
  const getBlob = (async (pathname: string) => {
    const value = values.get(pathname); if (!value) return null;
    return { statusCode: 200 as const, stream: new Blob([value.body]).stream(), headers: new Headers(),
      blob: { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname,
        contentDisposition: "inline", cacheControl: "60", uploadedAt: new Date(), etag: String(value.etag),
        contentType: "application/json", size: value.body.length } };
  }) as typeof get;
  const putBlob = (async (pathname: string, body: unknown, options?: { ifMatch?: string; allowOverwrite?: boolean }) => {
    const current = values.get(pathname);
    if (options?.ifMatch && String(current?.etag) !== options.ifMatch) throw new Error("precondition failed");
    if (options?.allowOverwrite === false && current) throw new Error("precondition failed");
    const value = typeof body === "string" ? body : await new Response(body as BodyInit).text(); revision += 1;
    values.set(pathname, { body: value, etag: revision });
    return { url: `https://blob.example/${pathname}`, downloadUrl: `https://blob.example/${pathname}`, pathname,
      contentType: "application/json", contentDisposition: "inline", etag: String(revision) };
  }) as typeof put;
  return { values, getBlob, putBlob };
}

describe("storage initialization", () => {
  it("initializes V16 private state and a complete atomic Catalog 3 publication idempotently", async () => {
    const privateBlob = memoryBlob(); const publicationStore = new MemoryPublicationStore();
    const options = { privateAuth: "private-token-sentinel", publicAuth: "public-token-sentinel", now: new Date("2026-09-18T06:00:00Z"),
      getBlob: privateBlob.getBlob, putBlob: privateBlob.putBlob, publicationStore };
    const first = await initializeStorage(options);
    expect(first).toEqual({ initialized: true, publicationUrl: expect.stringMatching(/^memory:\/\/publication\//),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(first)).not.toContain(options.privateAuth);
    expect(JSON.stringify(first)).not.toContain(options.publicAuth);
    expect(IngestionStateV16Schema.parse(JSON.parse(privateBlob.values.get("ingestion-state.json")!.body))).toMatchObject({
      schemaVersion: 16, collection: { catalogVersion: 3 }, ingestionLease: null,
    });
    const current = await readCurrentPublication(publicationStore);
    expect(current?.manifest).toMatchObject({ catalogVersion: 3, complete: true, conditions: expect.any(Array) });
    expect(current?.manifest.conditions).toHaveLength(45);

    const second = await initializeStorage(options);
    expect(second.initialized).toBe(false);
    expect((await readCurrentPublication(publicationStore))?.manifest.conditions).toHaveLength(45);
  });
});
