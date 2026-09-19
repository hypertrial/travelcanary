// Lightweight public paths only. Exact historical ID sets stay out of client bundles.
export const catalogV3Paths = {
  catalog: "/catalogs/3/locations.json",
  geography: "/catalogs/3/covered-countries.geojson",
  snapshot: "catalogs/3/latest.json",
  previousSnapshot: "catalogs/3/previous.json",
  conditions: "catalogs/3/conditions/v3/",
  demoSnapshot: "/catalogs/3/demo-snapshot.json",
} as const;
