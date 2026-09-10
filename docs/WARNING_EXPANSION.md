# Free official warning expansion — 2026-09-07

The release adds LVĢMC hydrological warnings and failure-only AEMET/DHMZ recovery. All three are keyless and server-only. MeteoAlarm remains primary; IFRC remains the next recovery option if direct recovery fails. The catalog remains 503 EU + Switzerland destinations, with a 24-hour horizon, Snapshot V10, private state V12 and existing event/provider types. No additional cron job, visitor-triggered request, paid data, account or outreach is introduced.

## Configured coverage before and after

These are configured monitoring relationships, not incident-detection rates.

| Measure | Before | After | Change |
| --- | ---: | ---: | ---: |
| Catalog destinations | 503 | 503 | 0 |
| Active national-warning countries | 9 | 10 | Latvia |
| Destinations eligible for direct national weather recovery | 49 | 86 | Spain 30 + Croatia 7 |
| Active direct national weather fallback transports | 3 | 5 | AEMET + DHMZ |
| Latvian destination–flood pairs with LVĢMC evidence | 0 | 7 | +7 authoritative source relationships |
| Flood: monitored / partial | 30 / 473 | 30 / 473 | No completeness promotion |
| Active wildfire: partial | 503 | 503 | Unchanged |
| Applicable volcano: not monitored | 118 | 118 | Unchanged |
| Security and nuclear: not monitored / partial | 468 / 35 | 468 / 35 | Unchanged for each hazard |
| Global provider IDs / public schema versions added | — | 0 | Existing transport health reused |

The seven Latvian relationships add an authority to destinations already partially monitored for flood. They are not seven newly complete monitoring pairs. Subsequent mapping review added zero activated destination–hazard pairs.

## Activated source contracts

### Latvia: `lvgmc-flood`

- Authority/access/reuse: [LVĢMC's official CKAN dataset](https://data.gov.lv/dati/dataset/hidrometeorologiskie-bridinajumi), explicitly CC0. Attribution is retained as “LVĢMC · processed by TravelCanary”.
- Reader: `package_show` before/after and paginated `datastore_search`, with the four committed resource UUIDs in `national-civil-alerts-lv.ts`. Warning records, polygon vertices, warning–municipality joins and municipality dictionary must form a consistent read. Changing resource modification times, estimated/changing totals, missing pages, orphan joins and unknown municipality identities fail safely.
- Scope: only `Water level`, Yellow/Orange/Red → Elevated/High/Severe. Other weather categories remain outside this release. Five exact municipality IDs restrict city matching; broad regional destinations use official warning polygons. Separate warning IDs/areas, including Riga warnings, remain distinct. Polygon vertices are ordered by `NPK`; missing/duplicate sequence entries and unclosed rings invalidate the warning.
- Time: warning validity is local `Europe/Riga`, including winter/summer offsets. Ambiguous fall-back and nonexistent spring-forward times fail safely. CKAN modification metadata is UTC. Upcoming warnings must start within 24 hours; expired warnings are excluded.
- Lifecycle: complete, consistent current tables replace this transport's current state; missing warnings are withdrawn. Incomplete active warning geometry/validity produces partial health with no destination declared completely checked. Failed/partial reads preserve valid retained alerts. Existing official expiry still applies.
- Limits: 8-second national transport deadline, 4 MiB aggregate inside the unchanged 24 MiB national-run ceiling; at most 40,000 vertices, 500 warnings, 5,000 joins and 100 municipalities. Current read uses 11 requests; maximum normal pagination uses 13, excluding bounded redirects. No retry fan-out.

### Spain: `aemet-cap`

- Authority/access: [AEMET's Atom/CAP service documentation](https://www.aemet.es/gl/rss_info/avisos/esp). The first Atom entry advertises the complete current CAP `.tar.gz` state. No OpenData token is used.
- Reuse: [AEMET reuse notice](https://www.aemet.es/es/nota_legal); retain authority, issue time and official link. Display copy explicitly identifies TravelCanary processing and does not imply endorsement.
- Reader: one Atom index plus its strictly allowlisted current-state archive. In-memory gzip/tar decoding accepts only bounded regular XML files; rejects unsafe names, links, extended entries, duplicate filenames, checksum errors, truncation and oversized decompression. It never extracts files to disk.
- Scope/lifecycle: parse every distinct CAP area, exact polygon intersections, Actual/Public messages only, reviewed weather codes and severity. Preserve authority identifiers, issue time, explicit offsets (including Canary Islands), validity, updates and cancellation references. Warning IDs include the authority area, so distinct areas matching the same destinations remain separate. Duplicate languages merge deterministically; contradictory severities for the same area fail. Current-state replacement stays transport-local; explicit updates/cancellations retire the same authority warning across primary, IFRC and direct delivery in either direction. Unrelated retained warnings survive.
- Limits: 8 seconds including parsing, 512 KiB index + 1 MiB compressed archive, 8 MiB decompressed, 512 KiB/file, 1,000 files and 500 normalized events. Index must be no older than 24 hours. A malformed or incomplete archive is failure, never healthy empty. The existing MeteoAlarm 64 MiB shared transfer ceiling also applies.

### Croatia: `dhmz-cap`

- Authority/access/reuse: [DHMZ XML service](https://www.meteo.hr/proizvodi.php?param=xml_korisnici&section=podaci), reusable with DHMZ attribution. The real linked filename is `cap_hr_tomorrow.xml`; the displayed `cap_hr_tmorrow.xml` is a documentation typo.
- Reader: today and tomorrow must both parse successfully. Parse all distinct areas in every language; do not select only the first English `info`. Actual/Public CAP sender, references, severity, validity and lifecycle use the shared strict CAP contract above. Each daily document must be no older than 24 hours; a fresh tomorrow file cannot hide a stale today file.
- Geography: `data/dhmz-warning-mapping.json` records 14 official land/sea region mappings, reviewed aliases, source URLs and SHA-256s. Intersections were computed from the official WGS84 shapefiles with polygon holes retained. Sea regions apply only to catalog coastal destinations. Translated names join to a reviewed area through the same CAP EMMA_ID; conflicting geography and wholly unknown active regions fail instead of disappearing. Catalog regional footprints remain approximations; the broad Dalmatian Coast destination intersects several land and sea regions by design.
- Limits: two requests, 512 KiB each, 8 seconds, 500 normalized events, inside the shared MeteoAlarm byte ceiling. Requires a failed Croatian MeteoAlarm feed and adds no completeness credit.

## Measured activation gates

The 2026-09-07 bounded live run used actual implementations and the full catalog:

| Transport | Requests | Response bytes | Elapsed ms | Events within 24h |
| --- | ---: | ---: | ---: | ---: |
| LVĢMC | 11 | 2,988,483 | 4,854 | 1 |
| AEMET | 2 | 244,053 | 490 | 19 |
| DHMZ | 2 | 18,480 | 66 | 6 |

No retries or byte overflow occurred. These developer-network measurements are point samples, not production latency guarantees. AEMET and DHMZ are normally uncalled while their primary feeds are healthy. Attribution, real geometry, lifecycle fixtures and bounded live reads passed before enabling these three manifest entries.

The isolated projection of these 26 events against an otherwise empty local state increased Snapshot V10 from 261,801 to 305,753 bytes (+43,952). That crosses the existing 300 KB warning threshold while remaining below the unchanged 500 KB hard limit. It is not a production estimate: primary/direct duplicates and production health differ. Keep this warning visible and measure the merged production snapshot after rollout. Demo snapshots retain the stricter 300 KB check.

Run `npm run smoke:warning-expansion` to repeat the bounded, read-only source and snapshot checks. Output includes per-source request, byte, time and record counts, explicit failure status and snapshot warning/hard limits. It does not publish or access storage credentials.

## Subsequent candidates and precise activation blockers

No speculative adapters are implemented for these entries. Machine-readable blockers and re-review triggers are retained in national manifest V3.

| Priority | Candidate | Activation blocker / next evidence |
| --- | --- | --- |
| 1 | [BBK/NINA location-based RSS](https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warn-App-NINA/warn-app-nina_node.html) | BBK advertises RSS, but a reusable reader contract for the RSS content and underlying issuers, official district IDs/geography, structured severity and cancellation/withdrawal semantics has not passed review. Do not treat unofficial app API documentation as permission. Require representative current/update/cancel RSS fixtures and district matching before implementing. |
| 2 | [BE-Alert](https://www.be-alert.be/fr/conditions-generales-dutilisation) | Website terms permit noncommercial reproduction with attribution; their applicability to the CAP gateway and each issuing authority is unverified. Need explicit applicable reuse basis plus a supported bounded gateway, issuer mapping and lifecycle fixtures. The blocker is not a blanket prohibition on noncommercial reproduction. |
| 3 | Existing flood / avalanche mappings | See exact review below. No geometric match for Reims; no unmapped AT/CH flood destination remains. Sixteen additional EAWS geometry candidates need current bulletin ID/edition and seasonal applicability verification before activation. |
| 4 | [Italian DPC volcanic warnings/restrictions](https://rischi.protezionecivile.gov.it/it/vulcanico/vulcani-italia/stromboli/) | No single reviewed current structured restriction/evacuation contract with exact affected zones, validity and withdrawal has passed. DPC activity levels are contextual; yellow status alone is not an imminent eruption or closure. Need official local restriction orders with explicit geometry and lifecycle; do not infer them from activity levels. |
| 5 | [DWD direct CAP](https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_EVENT_STAT/) | The official complete-state ZIP route is identified, but bounded ZIP handling, exact warning-region joins and representative update/cancel/archive fixtures remain unimplemented and unverified. AEMET's tar reader is not a ZIP reader. This is a later resilience addition. |
| 6 | [Météo-France Vigilance](https://www.data.gouv.fr/dataservices/api-bulletin-vigilance) | Free registered API needs an approved account/token and current quota/renewal contract. No account is created; no credentials are present or requested. Verify departmental/coastal geometry, lifecycle and quotas before implementing server-only access. |
| Deferred | [Direct SMHI warnings](https://www.smhi.se/download/18.55d446f91937861d43dbc6/1734468036504/Villkor%20f%C3%B6r%20konsekvensbaserade%20v%C3%A4dervarningar%20och%20meddelanden%20%28G%C3%A4ller%20fr%C3%A5n%20oktober%202021%29.pdf) | Special terms require unchanged information and delivery within five minutes, never exceeding ten. The ten-minute collection cycle cannot meet that margin. Requires a separately budgeted collection/publication path and unchanged presentation before reconsideration. |

### Existing mapping review

The read-only 2026-09-07 review intersected official geography with the existing catalog matching areas:

- Vigicrues: the current 337-feature river-section file (2,245,257 bytes) leaves Reims unmatched. The other 29 French destinations are already mapped. Do not borrow a nearby river section without a supported spatial relationship.
- eHYD: the current 300-station response (152,292 bytes) was inspected; all nine Austrian destinations already have committed mappings. No added destination pair. Measurements remain distinct from official warning stages.
- FOEN: the existing WMS warning raster evaluates all 11 Swiss destinations directly; there is no missing static destination mapping to expand.
- EAWS: the complete official geometry (751 features, 16,412,449 bytes) was read once for offline review, with a 32 MiB review limit. Production geometry and collection budgets were not increased. Sixteen unmapped destination intersections are recorded, with exact region IDs and source checksum, in `data/review-inputs/eaws-expansion-review.json`. They are candidates only: validate current bulletin region IDs/geometry editions and seasonal/altitude applicability before granting monitoring. Swiss destinations remain handled by SLF. No extrapolated radius or nearest-region match was added.

## Rollout and rollback

The repository enables the three individually reviewed transports. Production is not changed by local implementation or smoke checks.

1. Run `npm run check:deploy`, release checks and `npm run smoke:warning-expansion`. If any source gate fails, leave that transport denylisted and record the actual blocker; do not widen budgets automatically.
2. For staged deployment, set `NATIONAL_ALERTS_DISABLED_TRANSPORTS=lvgmc-flood,aemet-cap,dhmz-cap` initially, then remove one ID at a time after its live gate passes. Preserve any other existing denylist entries. Direct recovery health should be exposed even when the primary is healthy, without an upstream fallback request.
3. Allow the existing fast collector to publish; run `npm run verify:production` against the deployed release and inspect per-transport health, retained alerts, snapshot bytes and execution diagnostics. Running the updated verifier against the old deployment correctly reports the three newly approved transports as missing.
4. Roll back one source by adding its ID to the denylist. `NATIONAL_ALERTS_DISABLED_COUNTRIES` also disables direct recovery for that country. Disabled transports make no calls and remove their own retained events on the next collection. A failure or partial refresh instead retains valid existing warnings and reports unavailable health; it never asserts an all-clear.

No automated production publication, token creation, account signup or authority contact is part of this change. Review the new source contracts by 2026-12-06, or immediately after a feed, geography or reuse change.

## Initial implementation validation record

- `check:deploy`: lint, TypeScript, generated data/coverage/source/conditions validation, all 639 unit tests and production build passed. Demo Snapshot V10: 157,094 bytes raw / 8,295 gzip; catalog: 503 destinations / 110,778 public bytes.
- `check:release`: dependency audit found zero vulnerabilities; build, asset budgets and benchmarks passed. Browser suite: 145 passed, 37 platform-specific skips. Map-ready assets: 597,758 Brotli bytes / 600,000 limit; selected experience: 637,416 / 650,000.
- Final source-only live smoke: all three healthy, 15 requests, 3,251,016 response bytes, no retries/overflow; LV 4,935 ms, ES 508 ms, HR 170 ms. The isolated snapshot-size warning remains as described above.
- Public production verifier: still running release `50dba21d24a46fa807be28e997343df89c9659a7`, with a 255,152-byte snapshot. It correctly blocks the new local contract because all three new transports are absent and Latvia's national partition is disabled there. Existing warnings remain: overdue BG/ES/LT conditions, incomplete DE Autobahn/NL NDW, delayed EEA/EDO/GDACS, disabled GDELT and one destination with delayed required updates. This is pending rollout, not a passed production activation.
- Rollback is exercised locally for the Latvian coverage transport and direct weather recovery, including failed-primary retention, healthy-primary replacement and cancellation across transports. Production rollback has not been executed.

## Working-tree review follow-up

The change review fixed three defects: distinct official areas sharing destination matches could collide; direct CAP cancellations did not retire the same retained primary warning; and the newest DHMZ file could mask a stale sibling. Regression fixtures cover each case, including cancellation in both directions and preservation of unrelated alerts. Architecture and source-fixture documentation were reconciled. The ordinary review uses `npm run check:fast`; release/browser and live-source results above belong to the initial implementation, not a repeated release or deployment gate.

Review validation passed on Node 24: `npm run check:fast` (643 tests in 44 files, lint, typecheck and generated-data checks). `git diff --check` passed. No release gate, live upstream smoke, production publication or production rollback was repeated for this ordinary working-tree review.
