# Public operations guide

This repository supports localhost-first SQLite operation and retains generic Vercel Blob adapters for hosted deployments. It does not contain Hypertrial production credentials, project settings, incident records, or production cutover instructions.

## 1. Choose a runtime

For independent operation, follow [Self-hosting](SELF_HOSTING.md). Docker Compose and native Node 24.19.0/systemd both initialize catalog 3 directly, keep one SQLite database on local disk, and bind the web service to `127.0.0.1`.

The hosted adapter requires separate private and public Vercel Blob stores. Keep `PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN`, `PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN`, and `CRON_SECRET` server-side. Never place secrets in `NEXT_PUBLIC_` variables. New hosted deployments must make their own catalog activation and rollback decisions; copying this code does not alter the existing TravelCanary production service.

## 2. Source policy

Review [the data policy](DATA_POLICY.md), [third-party notices](../THIRD_PARTY_NOTICES.md), and `data/source-inventory.json`. Open sources are eligible by default. Restricted local sources require the recorded manifest-digest acceptance. Gated and blocked sources make zero requests.

Keep `GDELT_ENABLED=false` unless a later reviewed change supplies representative live reliability evidence and trustworthy publication timestamps. Do not bypass a source gate, access control, paywall, authentication requirement, response-size limit, or documented request budget.

The SQLite runtime supports one host and one collector. Do not place `travelcanary.db` on NFS, SMB, cloud-synchronized folders, or another network filesystem. Do not run clustered web or collector replicas against it.

## 3. Verify cron routes

Hosted operators may invoke the authenticated routes with their own domain and secret:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/fast
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/slow
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/daily
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/satellite
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/maintenance
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/conditions
```

Local collection does not call these routes. The long-running collector imports the same ingestion functions, serializes all six jobs, and reloads local source policy before each run. It persists successful completion times per cadence so a restart runs missing or due work immediately without repeating recently completed jobs.

## 4. Backups and recovery

Use `bin/travelcanary backup` and `bin/travelcanary restore`. Backups include private ingestion state and must be handled as private data. Restore validates catalog 3, both required snapshots, all 45 conditions files, and required private objects before replacing anything; it preserves the replaced database with a timestamp and restarts services managed by setup.

If collection is unhealthy, check `bin/travelcanary status` and service logs. Do not delete leases, cursors, reservations, or the database to force a refresh. A restart preserves state and an expired collector lease can be acquired by exactly one replacement process.

## 5. Public exposure

Loopback is the default security boundary. LAN exposure is an explicit configuration change. Internet exposure additionally requires a maintained TLS reverse proxy, host firewalling, and the operator's own authentication/access decision. Never expose the SQLite volume, environment file, collector process, or authenticated cron routes without appropriate controls.

## 6. Verification

During development run:

```bash
scripts/verify-fast
```

Before release work, commit the candidate and run `scripts/verify` from a clean checkout at that exact SHA. The full gate validates deterministic generated artifacts, unit and browser behavior, accessibility, assets, and builds. Docker Compose syntax and native unit generation have focused tests; run the documented Linux systemd smoke and a real Docker fresh-install test in their target environments.

The health and plugin-summary APIs intentionally omit paths, SQL details, raw errors, credentials, request targets, and private state. `/live/...` serves only exact allowlisted Snapshot V10/V11 and Conditions V2/V3 object paths.
