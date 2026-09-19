# Operations

## Vercel deployment

Import the public repository directly into a Vercel Pro project and keep Fluid Compute enabled. The repository root is the Vercel Root Directory. `vercel.json` owns all six schedules.

Production-only configuration is:

```text
CRON_SECRET
PRIVATE_INGESTION_STORE_ID
PUBLIC_SNAPSHOT_STORE_ID
TRAVELCANARY_PUBLICATION_URL
LOCAL_CONDITIONS_ENABLED
```

Connect both Blob stores with Vercel OIDC in Production. Vercel supplies the short-lived `VERCEL_OIDC_TOKEN`; do not add static Blob read-write tokens. The store IDs and publication URL are non-secret, while `CRON_SECRET` remains sensitive.

For a direct deployment, Vercel supplies the producer identity through `VERCEL_GIT_COMMIT_SHA`. If the Vercel Root Directory points at this repository inside a deployment wrapper, also set the non-secret `TRAVELCANARY_RELEASE_SHA` to the wrapper's exact 40-character commit SHA. The collector and health verifier use that explicit identity instead of the public submodule SHA.

`CRON_SECRET` must contain at least 32 random bytes. Set `LOCAL_CONDITIONS_ENABLED=true` in Production. Keep `NONCOMMERCIAL_DATA_ENABLED` absent or `false`; this enables exactly ARSO hydrology, AWC METAR, Digitraffic, Krisinformation infrastructure, MET Norway, NDW traffic, OPW hydrology, PSE Energy Compass, and RWS Waterdata. Open-Meteo, IPMA, Autobahn, and every disabled candidate remain inactive. Blob connections, conditions collection, and the optional release override are Production-only; Preview and Development remain on checked-in demo publication. No Met Office or MeteoAlarm credential is required.

Initialize empty stores once from a linked, OIDC-enabled operator environment after `vercel env pull`:

```bash
npm run storage:init
```

The command creates V16 state, acquires the global lease, publishes one complete Catalog 3 generation, and prints only the public publication URL and safe identifiers.

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

To initialize every cadence after a deployment, keep the secret in the environment and run:

```bash
PRODUCTION_ORIGIN=https://YOUR_DOMAIN npm run release:initialize
```

The command authenticates `HEAD` before each sequential `GET`, applies a bounded request deadline, and prints only route status and aggregate counters. Cron responses add successful, partial, failed, and disabled source counts plus a bounded sorted list of source IDs needing attention; they never include upstream prose, payloads, raw exceptions, or secrets. A completed job can still report degraded sources. A busy, paused, unauthorized, malformed, or non-successful response exits nonzero. To invoke one route manually, pass the secret in an authorization header, never a command argument. `HEAD` verifies authentication without work. `GET` performs bounded work.

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

Liveness is constant and dependency-free. Data health validates the current pointer, manifest, object digests, 679-member snapshot, exactly 45 fresh conditions objects, release identity, and coverage contract. It returns HTTP 200 with a degraded status for reviewed upstream failure while last-good publication remains valid; integrity or freshness failure returns 503. The production verifier additionally blocks delayed required life-safety monitoring. Air-quality delays are warnings, and CEMS is context-only: it cannot satisfy monitoring, fail a required transport, or degrade public availability.

Risk and monitoring freshness are independent. Active warning severity determines the risk level. With no active warning, a delayed life-safety check produces `UNKNOWN`; a delayed non-life-safety check leaves the risk `NORMAL` and appears under “Checks delayed.” “Live updates unavailable” is reserved for an invalid or unreachable publication. Permanent capability gaps appear as “Monitoring unavailable,” and failed conditions collection appears as “Local conditions unavailable.”

Use the narrowest kill switch during an upstream incident:

- `INGESTION_DISABLED_SOURCES` disables complete source adapters such as `eea` or `cems`.
- `NATIONAL_ALERTS_DISABLED_TRANSPORTS` disables one reviewed national transport such as `fr-alert` without changing other country collection.
- `NATIONAL_ALERTS_DISABLED_COUNTRIES` disables every national-alert transport for one reviewed country.
- `CONDITIONS_DISABLED_SOURCES` disables individual local-conditions sources. Removing `LOCAL_CONDITIONS_ENABLED` disables all conditions collection while continuing to publish schema-valid country files with explicit limitations.

Do not use kill switches to manufacture healthy release evidence. A disabled required life-safety transport remains release-blocking.

Before release, run `scripts/verify-fast`, then commit and run `scripts/verify` from a clean checkout at the exact candidate SHA. Require a green demo-only Vercel Preview. GitHub Actions availability is not a runtime dependency.

## Recovery

Pause ingestion before changing publication state. A web rollback may CAS `latest.json` to the preceding valid Catalog 3 manifest and deploy only a V16-compatible read-only web version. Collector failures require a forward fix. Never restore V15, reactivate an older writer, reverse collection revision, or resume Catalog 2 publication.

Maintenance retains the current generation, one preceding valid generation, and all generations younger than 48 hours.
