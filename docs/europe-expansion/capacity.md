# Expanded catalog capacity and marine scope

This is verified preparation, not a deployed expansion. Reproduce with
`node --import tsx scripts/measure-europe-conditions.ts` and the unit suites
`europe-expansion-capacity`, `europe-populated-capacity`, and `catalog3-marine-mapping`.

The real scheduler uses 679 weather targets, 679 air-quality targets and 161
marine targets (131 unchanged existing mappings plus 30 additions). Weather
refreshes every five hours; air quality and marine every eight. Expiry remains
six/twelve/twelve hours. A seven-day hourly simulation, including request-phase
reservations, peaked at 6,115 weighted calls per rolling day. The cold start
completed in five hours; ongoing gaps were five/eight/eight hours with zero
missing or expired eligible records after warm-up. Separate tests exercise
minute/hour limits, three-hour failures and an exhausted rolling-day reservation.
These are deterministic scheduler results, not live quota measurements.

The populated fixture retains non-forecast public records captured from all 28
existing country files, with URL, bytes, hash, timestamp and producer provenance.
For this synthetic capacity scenario only, those records are made current;
all existing approved airport/IPMA station mappings are populated, every forecast
uses 25 values from the largest retained product sample, and enabled source health
is populated. This is representative simultaneous activity, not a theoretical
maximum or a claim that every captured source was healthy. In particular the
captured Luxembourg file was older than the usual publication cycle; release
verification must investigate and report its freshness separately.

| Resource | Measured bytes | Existing limit |
| --- | ---: | ---: |
| V3 conditions | 1,483,530 | 1,572,864 |
| Legacy compatibility conditions | 1,221,588 | 1,572,864 per namespace |
| Optional conditions cache | 1,484,758 | 2,097,152 |
| Private state (conditions scenario) | 1,530,412 | 5,000,000 |

V3 wire serialization omits only arrays that the frozen reader already defaults
to empty. Decoded data, nonempty records, values and timestamps are preserved.
V2 output remains unchanged. Fixed per-country V3 ceilings in
`data/catalog-releases/3-conditions-budgets.json` sum to 1,566,976 bytes, bounding
any mix of old and new generations after partial publication. Writers reject
oversized candidates before requests; reads enforce actual wire bytes. Do not
reallocate these ceilings in place: that could invalidate the mixed-generation
bound. An unusually dense source period can exceed a ceiling; publication must
fail visibly, retaining prior evidence with normal expiry rather than dropping
records or manufacturing freshness. Production observation remains required.

A complete conditions generation is 45 files normally and 73 during the 24-hour
compatibility window. Normal conditional HEAD/GET/PUT paths require 135 or 219
blob operations respectively; three attempts bound this at 405 or 657 operations
per invocation. Cold namespace creation normally uses HEAD/PUT. The measured dual
conditions generation transfers 2,705,118 payload bytes before read traffic and
retries. Snapshot latest/previous writes, private state, lease/reservation writes,
metadata responses and publication frequency are additional costs. Compatibility
uses the same collected evidence and makes no duplicate upstream forecast calls.

## Marine decision

`data/marine-condition-mapping-v3.json` covers every one of the 63 new coastal
destinations: 30 approved and 33 unsupported. It supersedes the earlier 49-cell
candidate list. Repeated model responses and independent geography review deferred
19 otherwise nearby candidates because of land intersection or positive elevation;
other responses were absent or unsuitable. Exact per-destination gates and
representative payload hashes are retained in the mapping artifact. The reviewed
Natural Earth admin0 input SHA-256 is
`239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255`.

The [Open-Meteo marine contract](https://open-meteo.com/en/docs/marine-weather-api)
provides a preferred sea-cell selection and model grid centers. That is not an
authoritative sea mask. Approved output remains **nearby offshore forecast**
context within 25 km, with Open-Meteo and DWD/model-provider attribution. It does
not describe navigation, beach, harbor or ferry-operating safety. All 33 rejected
new coastal mappings make zero scheduled marine requests. Existing mappings are
unchanged. Country monitoring claims remain governed by the separate hazard matrix.

## Release dependency gate

The 2026-09-08 audit database update made the pinned Next.js16.3.2 fail the
required high/critical audit gate. WORK-81 pins Next.js and its matching ESLint
configuration to16.3.3, the first patched16.3 version in the
[maintainer advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36).
The reported exploit affects Windows-hosted servers; this is not evidence of an
exploit against the Vercel deployment. Audit thresholds are unchanged. The two
moderate Vitest development-dependency findings remain outside this patch's scope.
