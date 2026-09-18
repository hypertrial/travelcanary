import { describe, expect, it } from "vitest";
import { getPublicDataConfig } from "@/lib/config";

describe("server-controlled public data configuration", () => {
  it("uses the checked-in Catalog 3 demo outside production even when production variables leak in", () => {
    expect(getPublicDataConfig({ TRAVELCANARY_PUBLICATION_URL: "https://store.public.blob.vercel-storage.com/catalogs/3/publication/latest.json" }))
      .toEqual({ mode: "demo", snapshotUrl: "/api/v1/data", catalogVersion: 3 });
  });

  it("fails closed in production without a publication pointer", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production" })).toEqual({ mode: "unavailable", snapshotUrl: null, catalogVersion: 3 });
  });

  it("selects the server endpoint when production has a publication pointer", () => {
    expect(getPublicDataConfig({ VERCEL_ENV: "production",
      TRAVELCANARY_PUBLICATION_URL: "https://store.public.blob.vercel-storage.com/catalogs/3/publication/latest.json" }))
      .toEqual({ mode: "live", snapshotUrl: "/api/v1/data", catalogVersion: 3 });
  });

  it("uses the server endpoint for self-hosted instances and ignores retired build selectors", () => {
    expect(getPublicDataConfig({ TRAVELCANARY_RUNTIME: "local", NEXT_PUBLIC_CATALOG_VERSION: "2", NEXT_PUBLIC_DATA_MODE: "demo" }))
      .toEqual({ mode: "live", snapshotUrl: "/api/v1/data", catalogVersion: 3 });
  });
});
