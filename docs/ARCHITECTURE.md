# Architecture

TravelCanary has two runtime trust domains: a writer-only collector and a read-only web application. They share immutable public publication storage, not private state.

## State and collection

Private state V16 is Catalog 3-only. It retains source evidence, receipts, quotas, provider state, collection revision, state revision, a monotonically increasing ingestion fence, and the current global writer lease. V1–V15 parsers are frozen migration readers. The first V16 write preserves an immutable V15 backup; active code never writes an older schema or selects Catalog 2.

One random-owner global lease serializes the six collector cadences. Acquisition increments the fence through state CAS. Before publication, the writer revalidates lease owner, fence, state revision, and collection revision. Expired or replaced owners cannot publish.

## Atomic publication

Both filesystem and Vercel Blob backends use:

```text
catalogs/3/
├── objects/sha256/<content-sha>.json
├── generations/<manifest-sha>/manifest.json
└── publication/latest.json
```

The collector reads one committed state revision, builds Snapshot V11 plus all 45 Conditions V3 files, canonically serializes them, writes missing immutable objects, writes the immutable manifest, revalidates its lease and revisions, and CAS-replaces `latest.json` last. A failed object, manifest, validation, or pointer write cannot expose a partial generation.

Maintenance retains the current generation, the most recent preceding valid generation, and generations younger than 48 hours. Historical Catalog 2 Blob objects are neither updated nor used as rollback state.

## Read path

`/api/v1/data` redirects to the server-selected pointer. Preview and Development always redirect to checked-in demo publication, even if production-looking variables are present. Production redirects to `TRAVELCANARY_PUBLICATION_URL`; local mode redirects to the closed `/live/` object route.

The browser reads the pointer, validates the manifest digest, loads Snapshot V11, and loads only the selected country’s Conditions V3 object. Local serving accepts only exact pointer, manifest, and content-addressed object keys and rejects traversal, encoded separators, backslashes, symlinks, hardlinks, non-regular files, oversized data, and digest mismatches.

## Process isolation

Self-hosted data roots are separate, real, non-nested directories:

```text
private/   collector read/write
public/    collector read/write; web read-only
cache/     collector read/write; disposable
```

The web process does not open SQLite, run migrations, mount `private/`, or receive source credentials. Docker and systemd run non-root, restrict writes, drop capabilities, and use separate temporary storage. `/api/healthz` is constant dependency-free liveness.

## Hosted execution

Vercel retains six fast, slow, daily, satellite, conditions, and maintenance schedules. Routes return 404 outside Production before reading secrets. In Production they require a constant-time bearer check against a `CRON_SECRET` of at least 32 bytes. `HEAD` authenticates without work; `GET` performs bounded work. Busy writers return a sanitized successful result. Completed responses separate execution status from bounded source outcomes: aggregate counts and allowlisted degraded source IDs are exposed, while logs/responses never include raw exceptions, provider prose, payloads, or secret values.

## Health

`/api/v1/health` keeps schema version 1 and its coverage counters while adding publication metadata. It returns 503 for an invalid pointer/manifest/digest, missing object, wrong membership or identity, a snapshot older than 120 minutes, conditions older than 75 minutes, or a conditions count other than 45. Fetch rejection, timeout, or a non-OK non-404 publication response is `publication_unreachable`; parse, schema, digest, or identity failure is `publication_invalid`. Unavailable 503 responses send `Cache-Control: no-store`. Provider failures, delayed collector heartbeat, and retained last-good evidence return HTTP 200 with `status: "degraded"` while the generation remains safe to serve. Risk and freshness remain separate: active hazards determine severity; absent an active hazard, only a delayed life-safety path produces `UNKNOWN`. Other delays remain `NORMAL` with delayed coverage. Non-blocking context such as CEMS remains diagnostic only.

The production verifier is stricter: wrong producer SHA, membership or coverage regression, unauthorized runtime transport activity, delayed required life-safety monitoring, publication mismatch, unavailable health, or failed liveness blocks release. Reviewed non-life-safety and conditions-source degradation remains a warning when the complete publication is fresh.
