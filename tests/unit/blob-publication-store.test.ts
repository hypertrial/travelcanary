import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@vercel/blob", () => ({
  BlobPreconditionFailedError: class BlobPreconditionFailedError extends Error {},
  del: vi.fn(),
  get: blob.get,
  list: vi.fn(),
  put: vi.fn(),
}));

import { BlobPublicationStore } from "@/lib/publication-store";

const pointerPath = "catalogs/3/publication/latest.json";

function response(body: string, size = Buffer.byteLength(body)) {
  return {
    statusCode: 200,
    stream: new Response(body).body,
    blob: { size, etag: 'W/"etag"', url: "https://example.test/latest.json", uploadedAt: new Date(0) },
  };
}

describe("Blob publication reads", () => {
  beforeEach(() => blob.get.mockReset());

  it("accepts a non-empty bounded body when Blob temporarily reports size zero", async () => {
    blob.get.mockResolvedValue(response('{"ok":true}', 0));
    await expect(new BlobPublicationStore("token").read(pointerPath, 64)).resolves.toMatchObject({ body: '{"ok":true}', etag: '"etag"' });
  });

  it("enforces the byte limit while streaming when Blob reports size zero", async () => {
    blob.get.mockResolvedValue(response("oversized", 0));
    await expect(new BlobPublicationStore("token").read(pointerPath, 4)).rejects.toThrow("Invalid publication object size");
  });
});
