# Operations and Launch Runbook

The [September warning expansion](WARNING_EXPANSION.md) documents individual LVĢMC/AEMET/DHMZ activation and rollback, the `smoke:warning-expansion` gate, before/after coverage counts and snapshot-size warning. Use `NATIONAL_ALERTS_DISABLED_TRANSPORTS` for individual rollback and preserve unrelated existing denylist entries.

## 1. Create Vercel resources

1. Create one Vercel Pro project connected to this repository.
2. Create a private Blob store for ingestion state and a public Blob store for snapshots, in the same European region where possible.
3. Connect the private token as `PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN`.
4. Connect the public token as `PUBLIC_SNAPSHOT_BLOB_READ_WRITE_TOKEN`.
5. Generate at least 32 random bytes for `CRON_SECRET`; store it only in Vercel's Production environment.
6. Optionally create a free NASA FIRMS map key and store it as the Production-only, server-side `FIRMS_MAP_KEY`; keyless EFFIS remains the primary active-fire transport when it is absent.
7. Set `NEXT_PUBLIC_DATA_MODE=live` in Production. Leave previews in `demo` unless they have isolated stores.
8. Start with compatible V14 code and the default catalog-2 client/publisher (Snapshot V10, Conditions V2). Catalog 3 uses Snapshot V11 and Conditions V3 and requires the separate [drained activation and publication procedure](europe-expansion/publication.md). Leave optional switches unset during initial cutover verification.
9. After cutover verification, set `GFM_ENABLED`, `GLOFAS_TARGETING_ENABLED`, `EFFIS_PERIMETERS_ENABLED`, `IFRC_FALLBACK_ENABLED`, and `CONTEXT_FEEDS_ENABLED` to exact `true`. Keep `GDELT_ENABLED=false` until repeated bounded live checks establish reliable service and trustworthy article publication timestamps. Undated PointData HTML links are discarded; a successful response alone does not pass this gate. A disabled GDELT transport is an explicit context-only warning in production verification.
10. Add `travelcanary.org` as the Production custom domain, configure the required DNS record, and wait for Vercel to confirm the domain and TLS certificate before launch.

Never place a Blob token, cron secret, or source credential in a `NEXT_PUBLIC_` variable. `AIRNOW_API_KEY` is not part of the application contract: EEA is the authoritative European AQI source, while AirNow has sparse European coverage and uses a different index.

## 2. Initialize storage

Provision only the two required Blob token variables in a secure local session without printing them, then run:

```bash
npm run storage:init
```

The command never overwrites live data. It creates private ingestion-state schema V14 with collection catalog 2 and public Snapshot V10/catalog 2, verifies an already complete setup, and can safely resume after a partial bootstrap. Runtime readers migrate valid private V1–V13 data in memory. This bootstrap command rejects existing catalog-3 collection before repair; it is not an activation or rollback tool. Copy the printed public URL into `NEXT_PUBLIC_SNAPSHOT_URL`, redeploy, and verify that the page shows “Updates unavailable” until successful source runs populate health.

## 3. Verify cron routes

Invoke each deployed route using the production secret:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/fast
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/slow
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/daily
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/satellite
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/maintenance
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/conditions
```

Check that responses contain only source status, bounded diagnostics, snapshot bytes, `snapshotSizeWarning`, and aggregate retained-event, incident, evidence, clustered-duplicate, and overflow counts. Conditions responses additionally contain published, unchanged and failed country counts, at most eight country/code failure records, and an omitted-failure count. Each newer conditions generation is published even when its records are otherwise identical so `generatedAt` remains the hourly publication heartbeat; ordinary catalog-2 `unchanged` means storage already contains that generation or a newer one. Operational catalog-3 publication, including its dual-family outputs, requires the identical candidate: newer or same-time differing content fails as `concurrent_update`. The snapshot warning begins at 300 KB and publication still hard-fails at 500 KB. Diagnostics must never contain URLs, publisher text, payloads, destination IDs, credentials, or raw upstream/Blob errors. Confirm `latest.json` contains all sanitized partitions and clustered evidence arrays, but no candidates, raw errors, fingerprints, headlines/snippets from GDELT, or private overflow details.

Upstream source work is aborted after 45 seconds, leaving 15 seconds for state reconciliation and publication within the route's 60-second limit. A deadline should appear as a failed or partial source result while the last unexpired evidence remains visible; repeated total durations near 60 seconds require investigation.

The fast run must report EMSC, GDACS, Vigicrues, and national alerts separately. Ten national partitions are active: AT, CZ, DE, ES, FR, IT, LU, LV, PL, and SE. Italy is partial flood coverage from exact committed Civil Protection zones; its normal path is exactly one path-scoped commit query, one commit detail, and one fixed-host raw bulletin request. Finland, Ireland, Portugal, Spain, and Croatia call FMI, Met Éireann, IPMA, AEMET, or DHMZ only when their matching MeteoAlarm partition fails; any recovery remains partial. IFRC remains the next failure-only fallback. Transport diagnostics must reconcile totals, roles, due/skipped work, blockers, healthy-empty outcomes, requests, bytes, and affected destinations. Gated systems make zero requests.

Before the first V14 write, drain every older writer and publisher, including active requests and the conditions lease, using a control effective on that old runtime. After migration verify the immutable `ingestion-state-vN-backup.json` for the actual previous wire version N (for example V12 or V13); fresh V14 bootstraps have no prior-state backup. Existing backups stay immutable. Follow the [publication runbook](europe-expansion/publication.md) before any collection/client activation. Set only reviewed steady-state switches, redeploy the same SHA, and invoke the routes above. Confirm source work below 45 seconds, total runtime below 60 seconds, exact release membership (503 or 679 destinations), no raw publisher text, no unexplained overflow, and no coverage established by context, infrastructure, or fallback transports. Roll back one national country with `NATIONAL_ALERTS_DISABLED_COUNTRIES=IT` (or the affected uppercase codes); this denylist cannot activate gated systems.

## 4. Source and catalog approval

- Preserve all 503 legacy entries in `data/locations.json`; review the exact catalog-3 roster, mappings and all 459 category assessments in `data/review-inputs/europe-expansion-*.json` before activation. Legacy catalog review includes the three Azores island-group destinations, names, timezones, geometry, and provenance.
- Confirm MeteoAlarm provider-code and normalized area-label matching with current fixtures from every country; Atom feeds do not use one consistent geocode scheme.
- Run `npm run coverage:check`. The committed coverage matrix must match `data/meteoalarm-capabilities.json`, the provider registry, and reviewed location overrides. The validator must report zero fallback-only MeteoAlarm destinations.
- Review all curated coastal classifications and one-to-three EEA sample points. A destination must have a reviewed on-land point when its centroid can fall over water. The three Azores and two Canary destinations remain explicitly not monitored for official AQI; runtime requests and freshness health exclude them until a reviewed observation-time contract and representative mappings are approved.
- Review national manifest V3. Every system needs current evidence, next review, role, runtime target, independent gates, limits, and a blocker/contact route when inactive. Readiness is derived; context, fallback, incomplete, credential-gated, and evidence-gated transports cannot establish coverage. Re-run the Italian mapping generator from the reviewed official Topology and review all exact intersections.
- Slovakia remains intentionally inert even if `NATIONAL_ALERT_SK_ENABLED=true` and `SK_CRISIS_API_KEY` are set. After the authority-issued credential, reuse terms, representative fixtures, geometry, lifecycle, and live smoke are approved, merge the typed adapter and change the manifest status to `active`; only then provision both values in Production. The Azores transport similarly requires recorded reuse approval and a typed parser before its manifest gate may be changed.
- Review `data/vigicrues-section-mapping.json`, `data/ehyd-station-mapping.json`, `data/imgw-hydrology-mapping.json`, `data/chmi-hydrology-mapping.json`, `data/hazard-applicability.json`, `data/gdelt-publishers.json`, and `data/avalanche-report-region-mapping.json`. IMGW/CHMI mappings may contain at most three stations per destination; CHMI bulletin coverage must contain all catalog destinations intersected against the complete official RÚIAN ORP layer. Reconfirm GVP/ORP source versions, publisher parent ownership, and GDELT link-only use. Regenerate reviewed artifacts offline; ingestion must never fetch their source datasets.
- Recheck the IMGW public-data terms at the manifest URL and preserve both the `IMGW-PIB` source attribution and the visible `processed by TravelCanary` notice on normalized measurements and bulletins. The 2026-08-29 review found public reuse and attribution/processed-data marking requirements; commercial deployment owners must also confirm whether the intended use falls within IMGW's high-value-data exception or requires a separate agreement.
- Run `npm run sources:check`; `data/source-inventory.json` must match the provider registry and all 28 national-warning partitions.
- Recheck each enabled source's license and automated-access terms, including EMSC, CAP-LU, and eHYD CC BY 4.0, FR-Alert Licence Ouverte 2.0, AT-Alert/RTR official-warning publication, GDACS discovery-only use, and NASA FIRMS acknowledgement and transaction limits.
- FR-Alert currently omits its Sectigo OV R36 intermediate certificate. The adapter first uses normal `fetch` and retries only `UNABLE_TO_VERIFY_LEAF_SIGNATURE` with that public intermediate added to Node's normal root set; hostname and root verification remain enabled. Remove the fallback after the official server consistently presents a complete chain, and replace the intermediate before its March 2036 expiry if it is still needed.
- Run `npm run smoke:sources` without Blob tokens; this reads live sources but writes nothing. Each JSON line identifies provider mode, health scope, coverage role, bounded partition problems, unavailable counts, duration, requests, retries, response bytes, outcome codes, and overflow codes. Readiness-gated national partitions remain visible but do not fail the command when every enabled partition is healthy. Use `npm run smoke:sources -- SOURCE_ID` for a focused check.
- Confirm EEA timestamps and the five explicit island exclusions; EFFIS full-raster selection, current perimeters, and hotspot fallback; IMGW/CHMI freshness and structured degrees; IFRC origin filtering; GloFAS target-only behavior; and GDELT three-owner, rights-safe output. Confirm every exact-true switch makes no optional request when unset and permission-gated sources remain absent.

The source-controlled catalog is generated only during a reviewed catalog update. `npm run data:generate` requires GeoNames `cities15000.txt`, `admin1CodesASCII.txt`, and `admin2Codes.txt`, plus the approved Eurostat NUTS GeoJSON. Their paths default to `/tmp/travelcanary-cities15000.txt`, `/tmp/travelcanary-admin1.txt`, `/tmp/travelcanary-admin2.txt`, and `/tmp/travelcanary-nuts.geojson`; override them with `GEONAMES_PATH`, `GEONAMES_ADMIN1_PATH`, `GEONAMES_ADMIN2_PATH`, and `NUTS_PATH`. Regenerate the demo snapshot and run `npm run data:validate` after every catalog update.

The public coverage tint is generated separately with `npm run countries:generate` from [Natural Earth 1:50m Admin-0 Countries](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries-2/) converted to GeoJSON. The path defaults to `/tmp/travelcanary-ne-admin0.geojson`; override it with `NATURAL_EARTH_PATH`. The committed `public/covered-countries.geojson` is the runtime asset.

Optional Open-Meteo refresh cadence is five hours for weather and eight hours for modeled air quality and marine, consistently across both catalogs. Expiry remains six/twelve/twelve hours; failed or expiry-driven work can run earlier within the same reserved quota limits. Catalog 3 adds 30 reviewed marine mappings to the existing 131.

## 5. Spend controls

1. In Team Settings → Spend Management, configure the lowest practical alert threshold.
2. Enable automatic production pausing before intentional on-demand spend.
3. Confirm the team has only one deploying seat and no paid add-ons.
4. Review Usage after 24 hours, seven days, and each billing cycle.
5. Compare measured function, Blob, edge-request, and transfer usage with `docs/COST_MODEL.md`.

Spend controls are checked periodically and cannot mathematically guarantee an exact invoice. Keep the documented operating headroom.

## 6. Release verification

### Conditions rollout

Deploy with `LOCAL_CONDITIONS_ENABLED` unset/false; the alert app stays functional. Then enable exact-true `LOCAL_CONDITIONS_ENABLED=true` and, for the agreed noncommercial operation, `NONCOMMERCIAL_DATA_ENABLED=true`. The browser page is static: changing these switches requires rebuilding/deploying. `CONDITIONS_DISABLED_SOURCES` and `NATIONAL_ALERTS_DISABLED_TRANSPORTS` are validated comma-separated ID denylists; they cannot enable gated sources. See the generated source inventory and [source review](KEYLESS_SOURCE_REVIEW.md).

1. Invoke conditions after the required drain/cutover and verify private state V14 plus the immutable backup for the previous wire version. Confirm release-2 writes use `conditions/v2/` and release-3 writes use `catalogs/3/conditions/v3/`; the compatibility window publishes both families from the same collection. Legacy V1 files are not overwritten.
2. Supply `CRON_SECRET` securely and run `EXPECTED_COMMIT_SHA=<deployed-commit> npm run conditions:warm`. Each call performs exactly one resumable pass, one strict public verification, and prints exactly one next action. Resolve schema/release/authorization blockers first; after partial publication or a SHA mismatch, wait at least 105 seconds before rerunning; for recoverable product/source deficits, wait for the next hourly pass; investigate a named source only after its cadence and 75-minute publication grace have elapsed. No action is needed for expected expiry cleanup or an intentionally disabled GDELT warning. A partial publication exits nonzero after completing the other country writes. Server-side lease, quotas and due cohorts remain authoritative. Never loop automatically or reset leases, attempts, cooldowns, or reservations.
3. Run `NONCOMMERCIAL_DATA_ENABLED=true npm run smoke:conditions`. It is read-only and exercises the existing conditions sources plus Krisinformation, both bounded NDW snapshots, one representative Autobahn road, and PSE. It makes no Production writes. EAC remains gated until all five official pages complete within eight seconds; Enemalta remains gated until its complete planned list fits 512 KiB or gains a supported bounded query. Do not enable either based on parser fixtures alone or repeatedly smoke quota-limited services.
4. Invoke all six routes and run the verifier below with `EXPECTED_LOCAL_CONDITIONS=true`. Enabled conditions metadata triggers the release-matched checks: 28 Conditions V2 files with an exact 503-ID union, or 45 Conditions V3 files with an exact 679-ID union, plus size/schema/producer SHA, required infrastructure health, authorized source IDs, infrastructure/system record counts, and source-scoped failures. Producer mismatches remain one aggregate blocker with at most eight country examples. Ordinary source outages are warnings; missing/malformed files, unauthorized health or records, V1 payloads, and missing enabled infrastructure health are blockers.

IPMA weather warnings are a Portugal-only fallback: they are called only after Portugal's MeteoAlarm partition fails, and successful recovery remains `partial`. The response must be under 512 KiB, carry a current `Last-Modified` header, contain only documented warning classes, and match the committed district/island map. Disable the manifest system if its contract changes. IPMA station and seismic conditions share the existing `CONDITIONS_DISABLED_SOURCES` controls (`ipma-observations`, `ipma-seismic`) and require both conditions switches because the reviewed use is noncommercial. Before Production activation, an operator must notify `webmaster@ipma.pt` of the service and purpose as requested by the API page and record the notification date; the application must not send this message automatically.

ARSO hydrology uses `CONDITIONS_DISABLED_SOURCES=arso-hydro` for isolated rollback. The worker makes one hourly 256 KiB request to the documented bulk XML endpoint, checks schema version, authority, station identity, coordinates, water body, fixed-CET timestamp and freshness, and replaces only ARSO river records. A healthy response with no current mapped measurements clears only ARSO records; a failure retains their unexpired records. Never interpret its first-reference crossing as an official flood warning or monitoring coverage.
5. Inspect private cron `sourceDurationMs`, `durationMs`, `privateStateBytes`, `cacheBytes`, weighted calls, requests/bytes, source health and overflow. Require source <45 s, route <60 s, state <5 MB, optional cache ≤2 MiB, catalog-2 files ≤128 KiB each / ≤1.5 MiB total. Catalog-3 files must meet the immutable per-country allocations in `data/catalog-releases/3-conditions-budgets.json` (each no greater than 128 KiB) and the same 1.5 MiB family total. Alert snapshot stays <500 KB.
6. Check the five Azores/Canary destinations individually. Review availability and usage after 24 hours and seven days; no automatic monitor is created by these instructions.

Disable only the affected source on anomaly. `LOCAL_CONDITIONS_ENABLED=false` plus redeployment disables optional collection and browser conditions requests without disabling alerts. Monetization requires disabling noncommercial paths and completing a fresh license review.

### Executable public verification

Production releases use a one-time public verification gate. After deploying and invoking each authenticated cron route once, run:

```bash
EXPECTED_COMMIT_SHA=<40-character-deployed-commit> EXPECTED_LOCAL_CONDITIONS=true npm run verify:production
```

The command is read-only. It discovers the page's catalog release and requires matching Snapshot V10/catalog 2 with exactly 503 IDs or Snapshot V11/catalog 3 with exactly 679 IDs, checks immutable public limits and freshness, verifies every approved transport is exposed and no gated transport reports active, and reports stable bounded metrics. In `bySource`, `available` remains the backward-compatible count of destinations with current records; health separately counts `ok`, `partial`, `failed`, and `healthyEmpty`. Healthy-empty means a completed `ok` source published no current record and is not an availability failure. Treat a conditions product warning as a scoped collection deficit: failed forecast locations are automatically due on the next conditions pass while successful peers keep their normal cadence. Conditions files older than the 75-minute publication grace emit one bounded `conditions_publication_overdue` warning; a partial or failed source whose last completed check is also beyond that grace emits `conditions_source_health_persistent` with bounded source names. `expired` means a forecast product elapsed; `absent` means no record was published. Infrastructure records expired after generation are `pendingExpiryCleanup` without warning while the file is at most 75 minutes old, then `overdueExpiredRecords` with a bounded warning. A record expired at generation is a publication-integrity blocker. `blocked` exits nonzero; `warning` exits successfully for understood scoped or non-blocking source problems.

Conditions-route diagnostics use only `timeout`, `http_error`, `response_too_large`, `parse_failed`, `contract_mismatch`, `quota_exhausted`, `deadline_exhausted`, and `unknown_failure`. Forecast totals report attempted, matched, failed, split-retried, recovered, and skipped locations with at most eight affected country codes. Infrastructure totals report attempted, succeeded, failed, and skipped targets with at most eight safe public identifiers and an omitted count. They never expose provider URLs, destination IDs, credentials, payload prose, or raw exceptions.

Use `--origin https://DEPLOYED_DOMAIN` for another Production domain or `--snapshot-url https://.../latest.json` only when diagnosing a pre-marker deployment. `EXPECTED_COMMIT_SHA` also accepts an unambiguous 7–40 character prefix. Never pass a Blob token or cron secret to this command.

### Browser, camera, and install verification

Verify the UI with the selected catalog's matching snapshot and conditions contracts, including conservative older-snapshot pending states for new destinations. Test both releases before cutover. Confirm `/manifest.webmanifest` returns `application/manifest+json`, `id`/`scope`/`start_url` are `/`, display is `standalone`, all declared regular and maskable icons load at their declared dimensions, and the page exposes the Apple touch icon and standalone metadata. Confirm `navigator.serviceWorker.getRegistrations()` is empty; adding offline caching, push, background sync, or notification permission is outside the release contract.

At 1440×900 verify the 368-pixel rail, core-Europe opening frame, release-matched all-destinations action, clusters, Home control, and third-column briefing. At 1280×720 verify the bounded details overlay and right-only camera padding. At 390×844, 320×700, and 844×390 verify Map/Alerts tabs, full-screen search, filter sheet, normal 44dvh and alert 52dvh peek sheets, 92dvh expansion, safe areas, focus restoration, and no horizontal overflow. Two zoom-in steps must not move core Europe behind desktop chrome; a zoom round trip and closing an outer-destination briefing must restore the prior camera without warnings.

Install once with current iOS Safari (Share → Add to Home Screen → Add) and Android Chrome (menu → Install app or Add to Home screen). Verify standalone safe areas and the absence of browser-oriented guidance. Toggle runtime offline after a successful load: the offline banner must appear, loaded timestamps remain visible, and conditions failures stay local. A cold offline launch is deliberately unsupported. Roll back the UI normally if routing, camera, focus, or install presentation regresses; no snapshot or state rollback is involved.

The authenticated cron responses remain the private-state verification record. Confirm:

- Every enabled source and country partition is `ok` or has an understood, correctly scoped partial or failed result.
- Failed sources retain unexpired last-valid evidence; cancellation and expiry remove events at the correct scope.
- No destination is shown as normal when required evidence is delayed or unavailable; `coverageGaps` remains permanent while `delayedHazards` names the actually affected hazards and providers.
- GFM reports its environment gate, target count, per-layer bytes, unavailable destinations, and bounded outcome codes without satisfying coverage.
- State remains below 10,000 events, 20,000 fingerprints, and 5 MB; the public snapshot remains below 500 KB.
- Cron diagnostics contain no credentials, raw payloads, sensitive URLs, or destination-level private coverage.

Use routine production diagnostics and Vercel Usage for ongoing anomaly and cost review. A false-normal result, stale-event retention, unexplained overflow, or unbounded growth is an incident and rollback trigger, not a reason to start an elapsed-time release gate.

## 7. Verification authority

GitHub Actions is the automatic lightweight gate: `.github/workflows/ci.yml` job `check-fast` runs `npm run check:fast` on pull requests, pushes to `main`, and manual dispatch. It uses `ubuntu-latest` and Node 24. It does not install Playwright browsers, build catalogs, or upload browser artifacts.

The designated Apple Silicon Mac owns catalog builds, asset budgets, the isolated performance benchmark, Darwin visual snapshots, and browser tests. Completion evidence is exact-SHA `scripts/verify` on a clean tree. Local full verification uses Playwright retries `0` and `failOnFlakyTests`. Do not raise screenshot tolerances to accept raster drift. Failed local runs retain Playwright output under ignored directories.

[Vercel's source-controlled `buildCommand`](https://vercel.com/docs/project-configuration/vercel-json#build-command) compiles production. It currently runs `npm run check:deploy` (`check:fast` then `next build`) because repository settings cannot yet mark the GitHub `check:fast` job required. Do not change Vercel to build-only until that required check exists. A passing Vercel preview is not completion evidence.

Before merging or directly releasing, verify the exact commit locally with:

```bash
npm ci --no-audit --no-fund
scripts/verify
```

Record the commit SHA, host/OS/tool versions, command results, test/skip/retry counts, and asset values in Pad. Do not configure a persistent self-hosted runner for pull requests; it would expose the machine to repository code.

## Recovery and rollback

- If one source misbehaves, use its existing exact-true switch or the validated conditions/national transport denylist and redeploy. Leave unrelated transports enabled. Do not rewrite the coverage matrix for a temporary outage or synthesize normal results; review coverage claims separately if permanently retiring a source.
- If publication is invalid, restore `previous.json` to `latest.json` using its current ETag, then investigate with captured data. Never overwrite blindly.
- If cost approaches the limit, reduce non-critical checks and preserve the read-only last-valid map.
- V14 migration preserves accepted alerts, conditions, leases and quota state plus collection control and transition metadata. Roll back only to a compatible V14 runtime, retaining the newest evidence and quota. After catalog-3 activation use its compatible client; an older client must not remain past legacy retirement. Never restore an old private backup over newer evidence or quota charges.
- `state:project-v11` and `state:project-v10` are legacy V12-only projection tools. They reject V13/V14 before writing and are not the current rollback procedure. Use the [catalog-3 publication and rollback contract](europe-expansion/publication.md); never edit collection control manually or reset the immutable transition deadline. Drain publishers as well as collectors: private revision checks are not an atomic cross-store publication fence.
- Rotate `CRON_SECRET` or either Blob token immediately after suspected exposure.

## Launch checklist

- [ ] GitHub `npm run check:fast` and local exact-SHA `scripts/verify` pass on the exact release commit
- [ ] `EXPECTED_COMMIT_SHA=<deployed-commit> EXPECTED_LOCAL_CONDITIONS=true npm run verify:production` reports no blockers and every warning is understood
- [ ] Catalog approved in review
- [ ] Production shows live mode, never demo mode
- [ ] `https://travelcanary.org/` resolves to the Production deployment with a valid TLS certificate
- [ ] All six cron routes are authenticated and scheduled
- [ ] Enabled source licenses rechecked
- [ ] Cost controls enabled
- [ ] Cost model retains at least 25% headroom
- [ ] `npm run perf:assets` remains at or below 600,000 Brotli bytes at map readiness and 650,000 bytes after destination selection
- [ ] Critical destination alerts open without another code download; detailed monitoring/local-conditions code and Newsreader are deferred until destination selection
- [ ] Cron phase timings show bounded source and publication duration
- [ ] Per-source diagnostics reconcile with the release verification and contain no sensitive or high-cardinality values
- [ ] No source reports an unexplained overflow code; exercised limits degrade only the affected source or partition
- [ ] Exact-release cron verification passes
- [ ] Mobile, keyboard, and tile-failure flows manually verified
- [ ] Official-source disclaimer and coverage gaps are visible
- [ ] Existing Snapshot V9 renders conservatively while the V10 publisher is being initialized
- [ ] Budapest and a destination in another country show independent weather health after the fast cron
- [ ] Budapest shows current EEA AQI coverage after the slow cron, with any missing samples scoped to affected destinations
- [ ] The slow cron reports EFFIS/FIRMS `ok` or an explained `partial`; any hotspot evidence is `ELEVATED`, `MEDIUM` confidence, and expires after 12 hours
- [ ] EONET, EDO, FCDO, and Catalonia are visibly “Context only,” never satisfy coverage, and never make global health incomplete
- [ ] Reviewed switches are exact `true`; GDELT stays disabled until its reliability gate passes. GloFAS alone never publishes, any GDELT incident has at least three distinct evidence links, and verified perimeters never exceed `HIGH`
- [ ] Coverage issues are visible by default and “Show all checks” reveals successful categories

## Coverage sampling and incident capture

Save the JSON output from `npm run --silent verify:production -- <existing verifier options>` outside git. Each report includes `metrics.coverageMeasurement` and mapped `metrics.observationAvailability`. Compare 1–366 saved reports with:

```sh
npm run --silent coverage:measure -- history /tmp/report-a.json /tmp/report-b.json
npm run --silent coverage:measure -- capture /tmp/snapshot.json /tmp/reviewed-cases.json
```

Capture cases are a JSON array of `{ "id": "review-case", "headline": "Exact public incident headline", "sourceUpdatedAt": "2026-09-07T08:00:00Z", "hazard": "flood", "evidenceUrl": "https://official.example/individual-incident", "locationIds": ["lv-liepaja"] }`. Review the expected destinations independently from actual output. The URL, publication time and headline must jointly identify the official incident; a generic landing-page URL alone is insufficient. Primary public IDs can change during clustering and are not used. A mismatch exits nonzero. Use the snapshot from the incident's valid observation window; an expired historical case against today's snapshot is not a detection test. Preserve official provenance when creating minimized fixtures. Sample reports are not time-weighted uptime or general incident recall. No new scheduler, database or provider polling is introduced.
