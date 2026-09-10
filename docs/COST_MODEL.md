# 30-Day Cost Model

Reviewed 2026-09-01. Recalculate against current Vercel pricing before launch and quarterly thereafter.

The Pro platform fee is $20/month and currently includes one deploying seat, $20 infrastructure credit, 1 TB Fast Data Transfer, and 10 million Edge Requests. Cron jobs themselves are included but invoke billable Vercel Functions. Public Blob delivery and operations have separate metering and draw from included usage/credit. See [Vercel Pro](https://vercel.com/docs/plans/pro-plan), [Cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), and [Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing).

## Traffic assumptions

| Item | Monthly estimate |
| --- | ---: |
| Map visits | 100,000 |
| Fast cron runs | 4,320 |
| Slow cron runs | 720 |
| Satellite cron runs | 360 |
| Daily cron runs | 30 |
| Maintenance runs | 30 |
| Conditions runs | 720 |
| Total scheduled function invocations | 6,180 |
| Snapshot downloads, including open-page refreshes | 120,000 |
| Public snapshot warning / hard limit | 300 KB / 500 KB |
| Public catalog size | 111 KB measured, 150 KB budget |
| Compressed application and MapLibre worker assets through map readiness | 600 KB budget |
| Compressed assets after destination selection | 650 KB budget |
| Major per-adapter upstream budgets | National run 24 MB / Italy 3 MB / EAWS 9 MB / GFM 9 MB / EDO 3 MB / EFFIS perimeters 4 MB / IMGW 3 MB |
| Maximum MeteoAlarm transfer per fast run | 64 MB |

The production asset check launches the built route, captures the assets actually requested at map readiness and after destination selection, and applies local Brotli compression. The 2026-09-08 search-reliability build measured 597,719 bytes through map readiness: 275,864 bytes for the initial shell and the remaining map assets deferred until after safety-data startup. The initial shell uses the native system UI stack and downloads no font. Critical destination alerts ship with that shell; selection requests detailed monitoring and local-conditions code plus the Newsreader font, producing a 633,798-byte selected experience. The full local or manually dispatched check rejects map readiness above 600,000 bytes, requires monitoring-detail and local-conditions code and Newsreader to remain deferred, and rejects the selected experience above 650,000 bytes; `npm run verify:production` checks the deployed snapshot and release contract.

Installability adds no runtime API request, service worker, cache, background sync, or visitor-time provider request. The static regular/maskable 192/512 icons and Apple touch icon total 353,990 raw bytes (41,673 + 171,381 + 103,820 + 37,116). They are outside the initial JavaScript budgets and are fetched according to browser manifest/install behavior; include them in ordinary CDN transfer monitoring rather than alert or conditions API usage.

The location-specific coverage model bundles generated coverage, volcanic applicability, and Italian warning-zone intersections with the application rather than adding visitor requests. Snapshot V10 retains independently bounded delayed hazards, transport health, and up to five evidence links per incident. Demo and fixture snapshots must stay below 300 KB; Production warns from 300 KB and fails at 500 KB. The current generated demo is 154,911 bytes uncompressed and 7,742 bytes gzip; the 503-destination public catalog is 110,778 bytes.

## Transfer estimate

- Blob snapshot transfer at the 300 KB warning threshold: `120,000 × 300 KB` = 36 GB; the absolute 500 KB envelope is 60 GB.
- Static catalog transfer: `100,000 × 111 KB` = 11.1 GB worst case.
- Coverage-tint GeoJSON: `100,000 × 119 KB` = 11.9 GB worst case.
- Application transfer: `100,000 × 650 KB` = 65 GB worst case if every visit selects a destination.
- Total modeled delivery at the warning threshold is approximately 124 GB, under 13% of the current 1 TB Fast Data Transfer allocation; the 500 KB hard-envelope total is approximately 148 GB.
- OpenFreeMap tiles are delivered by OpenFreeMap, not Vercel.

## Blob and function estimate

- A normal ingestion publication performs seven Blob get/head calls and three advanced writes. Legacy cutover backups add bounded operations only on the first version transition.
- `5,460 × 3` = about 16,380 advanced operations; after a current 10,000-operation allowance, roughly 6,380 operations at $5/million would be about $0.03.
- Optional conditions add the separately bounded storage and write operations detailed below; the older 2 MB total-storage assumption no longer applies.
- Reads are expected to remain below 100,000 origin/simple operations because public responses are cached for 60 seconds.
- At an intentionally conservative 10 seconds of active CPU per cron invocation, all 6,180 scheduled invocations would use 17.2 CPU-hours. Review actual CPU in routine Vercel Usage; upstream wait time is not active CPU under fluid compute. Every route retains a 60-second function limit, with source work aborted after 45 seconds to reserve publication time.
- The complete national run uses at most eight concurrent tasks and a 24 MB ceiling. A normal transport uses one 1 MB aggregate response; Italy caps its bulletin payload at 3 MB. FMI uses a 256 KB RSS index and at most 16 linked 256 KB CAP records; Met Éireann and IPMA each use one 512 KB response. All three run only after their own MeteoAlarm partition fails. IMGW and CHMI retain their existing ceilings. Gated transports and not-due hourly transports make no request. Other source ceilings are unchanged.
- MeteoAlarm is capped at 4 MB per country feed, 512 KB per CAP supplement, and 64 MB across the combined run. Atom lifecycle references avoid redundant CAP requests; the bounded supplement queue is reserved for missing lifecycle references and extreme-wildfire instruction review. If every fast invocation exhausted the combined defensive ceiling it would transfer about 276 GB per 30 days (`4,320 × 64 MB`); this is a failure-envelope calculation, not expected usage. Routine production diagnostics establish normal and high-water response-byte totals.

## Local conditions addition

The additional 720 scheduled runs write at most 28 country files and three private-state versions per normal pass: up to 22,320 advanced Blob writes/month before warm-up/retries. CAS/head/get reads are additional and bounded. The earlier 2 MB average-storage assumption must not be used for the expanded deployment: private state is capped at 5 MB, including ≤2 MiB optional payload; conditions publication is ≤1.5 MiB; two alerts snapshots add ≤1 MB. Immutable backups remain additional storage.

Open-Meteo baseline is `503 × 8 = 4,024` weather, `503 × 4 = 2,012` AQ and `131 × 4 = 524` marine location-weighted calls/day: **6,560/day**. Batching reduces HTTP requests, not quota weight. The shared application ceiling is 400/minute, 2,000/hour, 8,000/rolling day including failed attempts, leaving 1,440/day under the daily cap for failures/warm-up. A batch-level failure may add one non-recursive split: a full 40-location batch consumes 40 additional reserved weighted calls and two requests, so at most 36 such full-batch recoveries fit the daily headroom and other failures/warm-up reduce that number. The retry reservation is committed before network I/O and is never refunded after a failed request or crash. Per-row failures do not amplify requests. Failed mapped-location cadence markers are cleared for the next hourly pass, but their quota reservations are not refunded; 21 permanent marine exclusions are never reserved or retried. HTTP 429 and insufficient request, byte, quota, or deadline headroom suppress the split.

The final 2026-08-31 island smoke measured 6,853 weather bytes, 5,752 AQ bytes and 4,967 marine bytes for five destinations per product. Together with airport, MET Norway and traffic responses: 176,298 bytes in seven requests. Forecast durations were 437/78/84 ms on the developer network, not production estimates. The 2026-09-01 Rijkswaterstaat smoke brought the combined eight-request transfer to 184,804 bytes and returned six current stations from seven reviewed mappings. Its Production ceiling is one 512 KiB request per hourly run, or 720 requests/month and a defensive 360 MiB/month. ARSO adds one hourly bulk request capped at 256 KiB, also 720 requests/month and a defensive 180 MiB/month; the 2026-09-02 review response was approximately 98 KiB, implying about 69 MiB/month before compression/cache effects. Scaling the forecast payloads alone suggests approximately 8.4 MB/day upstream; measure actual full-catalog batches after rollout. The 16 MiB/run defensive ceiling would permit 11.25 GiB/month if every run exhausted it, not expected usage.

The 2026-09-01 expanded smoke used 11 requests and 830,573 bytes. After excluding the broad Algarve region from point-station representation, the documented IPMA latest-observation GeoJSON stayed below its 512 KiB cap and matched 15 of 20 reviewed destinations; the two 512 KiB-capped seismic feeds produced a healthy empty result under the 24-hour/M3 rule. The warning list was 36,912 bytes in a separate read-only smoke and is requested only after Portugal's MeteoAlarm partition fails. These are point measurements, not throughput guarantees.

The 2026-09-03 reliability smoke used 20 requests and 1,145,772 bytes across all checked conditions sources. Galway's corrected offshore cell returned 24 non-null samples for wave height, wave period, and sea temperature at the requested coordinate; the 11-destination Swiss weather batch returned 24 aligned samples per destination. A separate five-island weather request timed out and the representative Autobahn request returned HTTP 502, demonstrating the bounded retry/partial-health paths rather than a higher steady-state baseline. A full 40-location unit-gated split adds exactly 40 persisted weighted calls and two HTTP attempts; there is no recursive retry.

The Conditions V2 all-catalog demonstration is 947,293 bytes across 28 files, largest 60,524 bytes. It includes repeated forecast fixtures, selected observation fixtures, one active road closure, one planned power interruption, sanitized infrastructure health, and one national electricity advisory; these are demonstration values, not live availability measurements. At 100,000 destination selections and one file per selection, the 128 KiB country ceiling adds up to 13.1 GB transfer before cache effects. The four-country browser cache reduces repeats; map-only visits download no conditions.

Infrastructure adds no cron run. The active source envelope is 54 requests per hourly pass (Digitraffic 2, Krisinformation 1, NDW 2, Autobahn up to 48, PSE 1), or 38,880 requests/month if every transport is due and every Autobahn endpoint is requested. A shared 64-request/8-MiB ceiling is stricter than the existing 128-request/16-MiB route budget; exhausting 8 MiB in all 720 monthly runs would be 5.625 GiB upstream, a defensive failure envelope rather than expected use. Cyprus EAC and Malta Enemalta make zero requests while their deadline/size blockers remain. `CONDITIONS_DISABLED_SOURCES` can remove one source without adding scheduled runs or changing alert delivery.

Re-run `perf:assets` for measured release assets; 600,000 map-ready and 650,000 selected application bytes remain hard limits. Country JSON is separately accounted optional data, not omitted from visitor-transfer estimates. Revisit CPU/storage headroom using real Vercel measurements after deployment.

## Headroom decision

The modeled delivery remains below the platform transfer allowance, but optional country-file reads/writes must be measured separately after rollout. Open-Meteo's 6,560/day baseline leaves 34.4% under its published 10,000/day free-service ceiling and 18% under our stricter 8,000/day application cap; warm-up and split retries share that cap. Function CPU is likely to vary because EFFIS decoding and source payload sizes change. Review measured usage against the 30-day model and investigate any platform category projected above 75% of its included allocation or credit.

Spend Management must pause Production at the lowest practical threshold. It is a fail-safe, not an exact invoice cap, because checks occur periodically.

## September 7 official warning expansion

No scheduled invocation, Blob operation, visitor request or hosting limit is added. LVĢMC shares the existing 24 MiB national-run limit: 4 MiB/transport and 8 seconds, at most 13 normal pagination requests. The measured 11-request read used 2,988,483 bytes and 4,854 ms. At 4,320 fast runs/month that point sample implies 47,520 requests and about 12.91 GB of upstream response bodies; the defensive 4 MiB ceiling is 16.875 GiB/month. These are upstream-body totals, not visitor CDN transfer or an invoice estimate. This source contributes roughly 21,000 seconds/month of elapsed wait plus parsing at the measured latency; elapsed network time is not active CPU.

AEMET and DHMZ are failure-only, with two requests each. AEMET caps its index/archive at 1.5 MiB transferred and archive decompression at 8 MiB in memory; DHMZ caps today/tomorrow at 1 MiB combined. Both share the unchanged 64 MiB MeteoAlarm run ceiling. If both primaries failed every run, their separate 2.5 MiB combined ceiling would be 10.55 GiB/month, already inside the shared failure envelope. The measured reads were 244,053 / 18,480 bytes and 490 / 66 ms respectively. Healthy primaries cause zero added direct-source requests.

The source-only snapshot experiment added 43,952 bytes for 26 current/upcoming events, yielding 305,753 bytes against an empty local state's 261,801 bytes. This exceeds the 300 KB warning threshold but remains below the existing 500 KB hard limit. It is not a production snapshot estimate; retain the warning and measure the merged snapshot after each activation. The demo remains under its 300 KB gate. No snapshot, asset, collection deadline or storage budget was increased. Re-run `smoke:warning-expansion` and inspect Vercel execution/CPU and snapshot-byte diagnostics after rollout; a source that fails a hard budget gate stays disabled.

OPW adds one hourly bulk request capped at 1 MiB within the existing 128-request/16 MiB run budget: 720 requests and a defensive 720 MiB per 30 days. The September 8 live response was 731,596 bytes (about 502 MiB/month before cache/compression effects at hourly polling). Coverage reports consume already-published files or explicitly supplied local samples; they add no scheduled source requests or visitor requests.
