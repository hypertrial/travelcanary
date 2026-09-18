# Catalog 3 client and geography

The application always uses Catalog 3: 679 destinations across 45 countries. Runtime selection is server-controlled through `/api/v1/data`; there are no build-time public data-mode or catalog-version variables.

Production redirects to the configured public publication pointer, local mode serves the validated filesystem publication, and Vercel Preview or Development is always bound to the checked-in demo generation. The client reads the pointer, immutable manifest, Snapshot V11, and only the selected country's Conditions V3 object.

`data/catalog-releases/3-geography.json` pins the complete Natural Earth input and committed subset hashes. `npm run catalog:check` verifies exact membership, display geometry, and deterministic demo artifacts. Geography controls display only; it does not grant warning authority or monitoring coverage.

Unsupported hazards remain visible as gaps. Forecasts, advice, satellite detections, and modeled conditions remain context-only and never create warning coverage credit.
