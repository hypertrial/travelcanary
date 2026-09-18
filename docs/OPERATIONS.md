# Operations

## Vercel deployment

Import the public repository directly into a Vercel Pro project and keep Fluid Compute enabled. The repository root is the Vercel Root Directory. `vercel.json` owns all six schedules.

Production-only sensitive variables are:

```text
CRON_SECRET
PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN
PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN
TRAVELCANARY_PUBLICATION_URL
```

`CRON_SECRET` must contain at least 32 random bytes. Preview and Development must receive none of these values; code still forces those environments to checked-in demo publication if production-looking values are accidentally injected. No Met Office or MeteoAlarm credential is required.

Initialize empty stores once from a secure operator environment:

```bash
npm run storage:init
```

The command creates V16 state, acquires the global lease, publishes one complete Catalog 3 generation, and prints only safe identifiers.

## Collection

Vercel schedules these authenticated Production-only routes:

```text
/api/cron/fast
/api/cron/slow
/api/cron/daily
/api/cron/satellite
/api/cron/conditions
/api/cron/maintenance
```

To invoke one manually, pass the secret in an authorization header, never a command argument. `HEAD` verifies authentication without work. `GET` performs bounded work. A busy response is successful and makes no writes.

Do not delete leases, cursors, state, or quotas to force a run. Wait for lease expiry or diagnose the bounded failure. `INGESTION_PAUSED=true` pauses hosted writes during recovery.

## Health and verification

## 3. Verify cron routes

Verify authenticated `HEAD` and one bounded `GET` for each configured route:

```text
/api/cron/fast
/api/cron/slow
/api/cron/daily
/api/cron/satellite
/api/cron/conditions
/api/cron/maintenance
```

Keep `GDELT_ENABLED=false` unless its separately reviewed reliability gate is completed.

```bash
curl --fail https://YOUR_DOMAIN/api/healthz
curl --fail https://YOUR_DOMAIN/api/v1/health
EXPECTED_COMMIT_SHA=<40-char-sha> EXPECTED_CATALOG_VERSION=3 \
  PRODUCTION_ORIGIN=https://YOUR_DOMAIN npm run verify:production
```

Liveness is constant and dependency-free. Data health validates the current pointer, manifest, object digests, 679-member snapshot, exactly 45 fresh conditions objects, release identity, and coverage contract. It returns HTTP 200 with a degraded status for reviewed upstream failure while last-good publication remains valid; integrity or freshness failure returns 503.

Before release, run `scripts/verify-fast`, then commit and run `scripts/verify` from a clean checkout at the exact candidate SHA. Require a green demo-only Vercel Preview. GitHub Actions availability is not a runtime dependency.

## Recovery

Pause ingestion before changing publication state. A web rollback may CAS `latest.json` to the preceding valid Catalog 3 manifest and deploy only a V16-compatible read-only web version. Collector failures require a forward fix. Never restore V15, reactivate an older writer, reverse collection revision, or resume Catalog 2 publication.

Maintenance retains the current generation, one preceding valid generation, and all generations younger than 48 hours.
