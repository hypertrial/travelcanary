import { describe, expect, it } from "vitest";
import { getPublicDataConfig } from "@/lib/config";

describe("public data configuration", () => {
  it("uses demo data outside production", () => {
    expect(getPublicDataConfig({})).toEqual({ mode: "demo", snapshotUrl: "/demo-snapshot.json", catalogVersion: 2 });
  });

  it("fails closed in production without a live snapshot", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "demo" })).toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 2 });
  });

  it("accepts a configured live snapshot", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: "https://store.public.blob.vercel-storage.com/latest.json" }).mode).toBe("live");
  });

  it("rejects a live URL outside the public Blob origin", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: "https://example.com/latest.json" })).toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 2 });
  });

  it("rejects a live URL with a caller-controlled query or fragment", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: "https://store.public.blob.vercel-storage.com/latest.json?token=unexpected" })).toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 2 });
  });

  it("rejects a live URL containing credentials", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_DATA_MODE: "live", NEXT_PUBLIC_SNAPSHOT_URL: "https://user:secret@store.public.blob.vercel-storage.com/latest.json" }))
      .toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 2 });
  });
});
