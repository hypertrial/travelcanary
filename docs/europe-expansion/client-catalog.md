# Catalog release 3 client and geography

Catalog release 2 remains the build default. `NEXT_PUBLIC_CATALOG_VERSION=3` selects the reviewed 679-destination catalog and its matching snapshot, conditions and display geometry namespace. Live builds require the exact trusted `/catalogs/3/latest.json` URL. Invalid releases or mismatched namespaces fail closed. Switching the public client is a rollout step, not authorization to collect new transports.

The new catalog retains every original destination ID and adds 176 destinations across 17 countries. Country counts describe destinations in the catalog; they do not claim complete hazard monitoring. Country identities and search aliases live in `data/country-identities.json`; GB, XK and Türkiye have explicit upstream identities and user-facing aliases. Unsupported hazards remain monitoring gaps. Official country links are clearly labeled as additional information and do not grant source coverage.

## Geography

`data/catalog-releases/3-geography.json` pins the full Natural Earth input hash and the committed 45-country subset hash. Generation is offline and deterministic. `npm run catalog:check` verifies exact catalog membership, geometry and demo artifacts. The generator accepts only the pinned input or the reviewed subset for release 3.

The reviewed component envelope retains the Azores, UK domestic islands, mainland/coastal Norway and all Türkiye. Norway has a separate component filter excluding Svalbard and Jan Mayen. Kosovo and Serbia remain distinct. Vatican City, Monaco and San Marino retain original coordinate precision. Geometry is display tint; it does not assign warning jurisdiction. The original release-2 country order and geometry algorithm are frozen separately, and its public file is unchanged.

The map fetches `/catalogs/3/covered-countries.geojson` for release 3. Changing the catalog refreshes its GeoJSON source without recreating the map or moving the camera. Aborted prior requests cannot replace newer geometry. Search, deep links and location states use the matching catalog. Reading a valid older snapshot leaves new destinations UNKNOWN and explicitly update pending.

## Reproducible demo and checks

`node --import tsx scripts/generate-demo-v3.ts` creates a versioned demo snapshot and 45 conditions files. It preserves the existing 503 demo risk results and represents all additions as update pending. Existing condition records are retimed only in these synthetic demo files, preserving relative age and expiry; all files share one deterministic generation and no production SHA. The legacy demo and production state are untouched.

`scripts/verify-fast` includes catalog and demo reproducibility. `scripts/verify` builds catalog 2 and catalog 3 to isolated output directories, checks asset budgets against one owned production server per catalog, and runs the Playwright suite with Darwin snapshots. Browser-independent cases run once on desktop Chromium; mobile WebKit keeps mobile-specific behavior plus a representative smoke set. GitHub Actions runs only `check:fast`. `verify:production` discovers the release from page metadata and validates exact snapshot/catalog/country membership and wire budgets, while reporting unavailable, expired and unsupported data separately. Legacy nested snapshot paths remain supported.

Client-foundation measurements at `e41eae7` (historical; rerun budgets for the release commit): public catalog 147,057 raw bytes (150,000 limit); map-ready code/styles/workers 598,163 Brotli bytes (600,000 limit), selected experience 644,036 (650,000 limit). Display geometry is separately reported at 1,006,113 raw / 125,132 Brotli bytes. These data transfers are separate from the existing code/style/font/worker budget. Both catalog builds pass these unchanged limits. Full local verification passed 1,206 unit tests, 180 legacy browser tests and 40 catalog-3 browser tests, with 46 planned legacy skips and no retries. Independent architecture and semantic reviews passed; exact-commit CI and deployment remain release gates.

## Rollout status

This implementation is a gated client foundation. No expanded client, collection or publication is deployed by these source changes. Deployment must follow `publication.md`, with compatible producers first, drained forward-only state activation, verified versioned outputs and the documented 24-hour compatibility window. Country completion additionally requires approved integrations, explicit gap presentation and production observation evidence.
