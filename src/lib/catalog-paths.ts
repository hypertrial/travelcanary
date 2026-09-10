// Lightweight public paths only. Exact historical ID sets stay out of client bundles.
export const catalogV2Paths = {
  catalog: "/locations.json",
  geography: "/covered-countries.geojson",
  snapshot: "latest.json",
  previousSnapshot: "previous.json",
  conditions: "conditions/v2/",
  demoSnapshot: "/demo-snapshot.json",
} as const;

function trustedSnapshotUrl(value: string | undefined | null): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:"
      && url.hostname.endsWith(".public.blob.vercel-storage.com")
      && !url.search && !url.hash && !url.username && !url.password
      ? url : null;
  } catch { return null; }
}

export const catalogV3Paths = {
  catalog: "/catalogs/3/locations.json",
  geography: "/catalogs/3/covered-countries.geojson",
  snapshot: "catalogs/3/latest.json",
  previousSnapshot: "catalogs/3/previous.json",
  conditions: "catalogs/3/conditions/v3/",
  demoSnapshot: "/catalogs/3/demo-snapshot.json",
} as const;

export function catalogV2SnapshotUrl(value: string | undefined | null): URL | null {
  const url = trustedSnapshotUrl(value);
  return url && url.pathname.endsWith(`/${catalogV2Paths.snapshot}`)
    && !/\/catalogs\/[^/]+\/latest\.json$/.test(url.pathname) ? url : null;
}

export function catalogV3SnapshotUrl(value: string | undefined | null): URL | null {
  const url = trustedSnapshotUrl(value);
  return url?.pathname === `/${catalogV3Paths.snapshot}` ? url : null;
}
