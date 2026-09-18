# TravelCanary

[TravelCanary](https://travelcanary.org/) is an MIT-licensed map of current, source-backed hazards for 679 destinations in 45 European countries. This public repository is the complete application: UI, APIs, collector, storage adapters, generated demo data, Docker deployment, Linux service templates, and Vercel configuration.

TravelCanary answers whether a major hazard could affect a place now or within the next 24 hours. It does not assign general safety scores, and forecasts, advice, observations, satellite detections, and discovery feeds never create warning-coverage credit.

## Quick start

Development requires Node 24.19 and npm 11:

```bash
npm ci
npm run dev
```

The development server always uses checked-in demo data and needs no credentials. Open <http://localhost:3000>.

For a persistent self-hosted instance:

```bash
docker compose up --build -d web collector
```

The same image supports `web`, `collector`, and `collector-once` roles. Native Linux system-service templates use separate web and collector identities; see [Self-hosting](docs/SELF_HOSTING.md).

## Runtime model

Catalog 3 is the sole runtime catalog: Snapshot V11 contains exactly 679 destinations and each public generation contains exactly 45 Conditions V3 country files. The collector writes private V16 state and publishes immutable, content-addressed public objects. One compare-and-swap pointer makes a complete generation visible atomically. The web process receives only read-only public storage and never opens private SQLite or receives provider credentials.

Runtime storage is separated into:

- `private/`: collector-only SQLite/private state
- `public/`: collector-write, web-read-only publication objects
- `cache/`: collector-only disposable cache

`GET /api/healthz` is dependency-free liveness. `GET /api/v1/health` returns 503 only when the current public generation cannot safely serve data; reviewed provider degradation returns HTTP 200 with `status: "degraded"`.

## Deploy to Vercel

Import this repository directly into a Vercel Pro project; no wrapper repository or build-time catalog selector is required. Keep Fluid Compute enabled and leave Preview without production storage variables so it remains demo-only. Production requires:

- `CRON_SECRET` — at least 32 random bytes
- `PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN`
- `PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN`
- `TRAVELCANARY_PUBLICATION_URL` — the public Blob `catalogs/3/publication/latest.json` URL

The six schedules in `vercel.json` are inert outside Vercel Production. Initialize storage once with `npm run storage:init`, then invoke the six bounded routes or let Vercel Cron run them. No Met Office or MeteoAlarm credential is required. See [Operations](docs/OPERATIONS.md).

## Verification

```bash
scripts/verify-fast
scripts/verify
EXPECTED_COMMIT_SHA=<40-char-sha> EXPECTED_CATALOG_VERSION=3 npm run verify:production
```

The production verifier discovers `/api/v1/data`, validates the pointer, manifest, all object digests, exact membership, producer SHA, freshness, coverage floors, public health, and liveness. A blocked report exits nonzero.

## Policy and license

Review the [public data policy](docs/DATA_POLICY.md), [source inventory](data/source-inventory.json), and [third-party notices](THIRD_PARTY_NOTICES.md) before operating a collector. Restricted noncommercial sources require explicit local operator acceptance. Optional credentialed integrations remain dormant and request-free when unconfigured.

First-party code is available under the [MIT License](LICENSE). Third-party data, names, marks, and assets retain their original terms.
