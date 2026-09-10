# TravelCanary

[TravelCanary](https://travelcanary.org/) is an MIT-licensed, self-hostable map of current, source-backed hazards for 679 destinations across 45 European countries. It answers whether a major hazard could affect a place now or within the next 24 hours; it is not a general safety score.

This repository is the canonical public application. It retains the Vercel adapters used by the hosted service and is gaining a localhost-first SQLite runtime for independent operators. The public release was seeded from the clean tracked tree of `travelcanary-risk` commit `e780697f957de8a072b70c4fe771345bd1315b8d`; see [public provenance](PUBLIC_PROVENANCE.md).

## Run locally

```bash
npm install
npm run dev
```

The developer server uses clearly labeled deterministic demo data and requires no credentials. Open <http://localhost:3000>.

For a durable live instance, use the guided Docker Compose or native Node 24/systemd setup in [Self-hosting](docs/SELF_HOSTING.md). Both bind to `127.0.0.1` by default and initialize directly on catalog 3 with every destination marked `UNKNOWN` while collection warms up.

Omarchy users can add this repository as a shell plugin after starting a local instance. The service-backed bar widget polls only the bounded loopback summary API and opens selected destinations in the existing app; see [Omarchy](docs/OMARCHY.md).

Destination-selected **Local conditions** are separate from alert risk and monitoring coverage. Forecasts, modeled air quality, airport/IPMA weather observations, IPMA earthquake context, Rijkswaterstaat, ARSO and Irish OPW water observations, and reviewed infrastructure context are precomputed into bounded country files; visitors never call their providers. Infrastructure includes Finnish Digitraffic, Swedish Krisinformation, Dutch NDW, German Autobahn, and national PSE electricity-use advisories. Cyprus EAC and Malta Enemalta parsers are implemented but runtime-gated after their official surfaces failed the deadline and response-size gates respectively. Weather and modeled AQ are eligible at all 503 destinations; 131 of 152 coastal destinations have reviewed offshore marine cells and the other 21 are permanent product exclusions. Infrastructure never changes alerts, map markers, or coverage.

With the default catalog 2, the responsive browser opens desktop on the 496-destination core-Europe extent; **Show all 503 destinations** includes the seven Atlantic-island destinations. Mobile uses dedicated Map and Alerts views, full-screen destination search, and a two-height briefing sheet. Shareable state uses `destination`, `view`, and `filter` query parameters. The generated web manifest allows Add to Home Screen / standalone installation on iOS and Android. Installation does not add offline data: there is deliberately no service worker, background refresh, push permission, or cached cold launch.

The collector requires exact-true `LOCAL_CONDITIONS_ENABLED`; reviewed restricted sources additionally require explicit operator acceptance and noncommercial operation. No advertising/subscriptions without a new license review. See the [public data policy](docs/DATA_POLICY.md), [source decisions and unfinished gates](docs/KEYLESS_SOURCE_REVIEW.md), and [operations](docs/OPERATIONS.md). The compatible runtime writes private state V14. Reviewed catalog 3 contains 679 destinations in 45 countries and uses Snapshot V11 and Conditions V3 under versioned paths. Existing Vercel production coverage is not expanded merely by deploying this code.

Generate local fixtures with `npm run conditions:demo`, validate mappings with `npm run conditions:check`, and run the bounded read-only source check with `NONCOMMERCIAL_DATA_ENABLED=true npm run smoke:conditions`. Missing, expired, and nearly expired forecasts run first; one batch-level failure may receive a quota-reserved split retry, while failed locations remain due on the next hourly pass. `EXPECTED_COMMIT_SHA=<deployed-commit> npm run conditions:warm` performs one resumable authenticated Production pass, verifies convergence, and prints exactly one safe next action when explicitly run with securely provisioned cron credentials.

## Checks

```bash
scripts/verify-fast
scripts/verify
```

`check:deploy` is the Vercel compile gate: it runs `check:fast` before `next build` until a required GitHub `check:fast` check can be enforced. GitHub Actions automatically runs `npm run check:fast` on pull requests and `main`; it does not build catalogs or install browsers. Full verification is exact-SHA `scripts/verify` on the designated Apple Silicon Mac. Do not configure a self-hosted runner. See [operations](docs/OPERATIONS.md#6-verification).

`perf:assets` checks the production route and MapLibre worker against the 600 KB map-readiness budget, verifies monitoring-detail and local-conditions code and Newsreader stay deferred until selection, and enforces a 650 KB selected-experience budget. `perf:bench` verifies indexed risk matching against a naïve reference and prints comparative timings.

After a Production deployment, `EXPECTED_COMMIT_SHA=<deployed-commit> EXPECTED_LOCAL_CONDITIONS=true npm run verify:production` performs the read-only public release gate. It discovers the client catalog release and validates live mode, release identity, matching Snapshot V10/catalog 2 or Snapshot V11/catalog 3 integrity, the reviewed conditions switches and country files, transport authorization and health, freshness, steady-state provider enablement, and snapshot size. Weather, modeled-AQ, and coastal-marine completeness are reported independently; absent and expired products are separated with bounded country-grouped examples. A blocked report exits nonzero; scoped or non-blocking source problems are emitted as stable warnings.

Playwright uses port 3000 by default and refuses to reuse an existing server. Set `PLAYWRIGHT_PORT` when that port is already occupied, for example `PLAYWRIGHT_PORT=3002 npm run test:e2e`. Type checking generates the ignored Next-managed declarations before running TypeScript.

## Production

The hosted adapter uses Vercel Cron Jobs and two Vercel Blob stores. Every source can run keylessly; an optional free NASA FIRMS map key supplements the keyless EFFIS active-fire transport. Public operator guidance deliberately excludes the private hosted service's cutover, credentials, project settings, and incident runbooks.

Enabled ingestion covers MeteoAlarm with failure-only FMI, Met Éireann, IPMA, AEMET, and DHMZ direct recovery followed by conditional IFRC recovery; EEA air quality at 498 reviewed destinations with five explicit island exclusions; USGS and EMSC; Copernicus sources; GDACS discovery; NASA EONET context; European flood and avalanche sources; and ten enabled national partitions, including exact-zone Italian flood bulletins. GDELT is implemented but remains disabled in Production pending live reliability checks and verified article publication timestamps; undated PointData HTML links are discarded. Every one of the 28 reviewed countries has explicit per-system gates in national manifest V3. `NATIONAL_ALERTS_DISABLED_COUNTRIES` provides per-country rollback. Context and fallback evidence never establish monitoring coverage.

FR-Alert data is reused under France's Licence Ouverte / Open Licence 2.0. CAP-LU alert data is redistributed under CC BY 4.0; source links and authority names remain attached to every published alert.

- [Product specification](PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Cost model](docs/COST_MODEL.md)
- [Source fixture guide](docs/SOURCE_FIXTURES.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Contributing](CONTRIBUTING.md)
- [Public data policy](docs/DATA_POLICY.md)

## License

First-party TravelCanary code is available under the [MIT License](LICENSE). Bundled and fetched third-party data, names, marks, and assets remain subject to their original terms; review [Third-party notices](THIRD_PARTY_NOTICES.md) and the generated [source inventory](data/source-inventory.json) before operating a collector.

The [September warning expansion](docs/WARNING_EXPANSION.md) adds LVĢMC hydrological warnings and AEMET/DHMZ recovery, with source contracts, measured cost, coverage deltas and rollback instructions.

The [September coverage follow-up](docs/COVERAGE_EXPANSION.md) adds six reviewed Irish gauge mappings, fresh-coverage sample reports and explicit source-contract blockers.
