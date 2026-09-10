# Europe expansion release ledger

## Scope and current state

The implemented catalog contains 679 destinations in 45 countries: all original
503 IDs plus the reviewed 176 additions. Production is still on the original
28-country release at `8910e91261bf8f9ec8bc0841c2020d605b5506b1` as last verified
on 2026-09-09. No expanded production activation or 24-hour observation is claimed.

| Country group | Destinations | Marine mappings | FCDO destinations | Country PR |
| --- | ---: | ---: | ---: | --- |
| UK, Norway, Iceland | 62 | 17 | 32 | #20 |
| Western Balkans | 56 | 4 | 56 | #21 |
| Microstates | 12 | 0 | 11 | #22 |
| Belarus, Moldova, Türkiye | 46 | 9 | 46 | #23 |
| Total additions | 176 | 30 | 145 | |

## What is implemented

- **Catalog expansion:** all 17 countries, frozen IDs, native/Latin aliases,
  reviewed coordinates/timezones, preserved microstate geometry and agreed
  territory exclusions. The public country count means catalog presence.
- **Monitoring expansion:** reviewed USGS earthquake scope for all 176 additions,
  supplementary EMSC evidence, FCDO whole-country context for 145 destinations
  and SLF avalanche monitoring only for Malbun. Weather and modeled air quality
  cover all additions; marine forecasts use 30 reviewed cells. Forecast and
  advisory roles remain distinct from warning coverage.
- **Remaining gaps:** 459 category assessments cover all 20 hazards and seven
  conditions categories for each country. The dossier contains four approved
  source groups, 22 blocked candidates, six excluded routes and 19 official-link
  dispositions. Blocked sources retain exact gates; links do not activate them.
  Regional advice, aviation notices, hydrology measurements and bulletin archives
  are not relabeled as local warnings.

The exact source and geography decisions are in
`data/review-inputs/europe-expansion-sources.json`, the per-country assessment
documents and the frozen catalog/marine mapping artifacts. Country rollout
documents record jurisdiction-specific limits and evidence requirements.

## Local evidence

At country implementation commit `672db9c`, `scripts/verify-fast` passed 1,250 unit
tests. The 52 expanded-catalog browser cases passed without retries on desktop
Chromium and mobile WebKit, including eastern Türkiye, all four UK nations,
Shetland, Lofoten, official links, selection, URL history, first drag and manual
camera persistence. Independent country semantic/security reviews passed.

The expanded build measured 598,164 map-ready and 644,532 selected Brotli bytes,
within the unchanged 600,000/650,000 limits. The catalog is 147,057 bytes within
150,000. Geometry is separately measured at 1,006,113 raw / 125,132 Brotli bytes.
The real seven-day scheduler simulation peaks at 6,115 weighted calls per rolling
day, retains the 400/minute, 2,000/hour and 8,000/day limits, stages the cold start
and finds no persistent country/product starvation after warm-up. This is measured
simulation evidence, not a production quota observation.

The final `scripts/verify` run, independent release review and automatic GitHub `check:fast` are
mandatory. Their terminal results and immutable commit/run links are recorded in
WORK-75 and the final release PR; a started run is not a passing check. The
foundation's exact head `e41eae732bc60bede1a8ebf3c3024b7ab2e24a26` already passed
both CI jobs in run 34290000212. Legacy regressions, transition/CAS failure tests,
all country acceptance and both build budgets must pass on the final release.

## Production authorization and sequence

The phased draft PRs preserve independent review boundaries. Prepare one final
release PR against current main for the complete patched tree; do not deploy
intermediate stack commits. This avoids temporarily introducing superseded
dependency versions. Keep client catalog2 as the first deployment's explicit
configuration. The same tree supports the later catalog3 build.

Obtain operator authorization before uploading or deploying source, merging a
release, or accessing production credentials. Provision only the credentials
needed by the selected operation; do not download the full environment or print
secret values. Record authorization and outstanding operational gates in the
private project tracker.

Follow `publication.md`: effective old-runtime scheduling pause and drain before
the first V14 write; compatible catalog2 deployment and verified rollback target;
verified catalog3 rollback deployment; second pause/drain; forward CAS activation retaining state/quota; staggered
collection; complete dual publication; verified catalog3 client switch before
legacy retirement. Prepare the tested catalog3 client before activation.

There are two independent clocks. `dualStartedAt` begins only after complete
dual-file acknowledgment and controls the immutable 24-hour compatibility period.
Each country's observation starts when its approved runtime paths are verified
operational after warm-up. It must continue for at least 24 hours and can finish
after the client switch. Pending files can satisfy publication membership but
cannot satisfy monitoring readiness. Do not wait for country observation to finish
before starting a client deployment at the retirement deadline.

## Required deployed evidence

For each group, record actual values for all of the following; blanks remain
outstanding and are never inferred from local tests or from another country's feed:

| Evidence | Required record |
| --- | --- |
| Deployment | URL, exact commit, catalog release, configuration and effective pause/drain evidence |
| Publication | Snapshot exact membership, 45 matching conditions partitions, source timestamps and producer agreement |
| Compatibility | Both snapshot families and 45+28 conditions outputs, acknowledgment time and immutable retirement deadline |
| Runtime sources | Bounded approved-source checks, receipt scope, attribution, geographic matches, nonempty lifecycle fixtures and verified empty semantics |
| Country observation | Operational-readiness time, start/end at least 24 hours apart, repeated publication/expiry samples and any recovery |
| Quota and storage | Actual rolling-day/minute/hour use, reservations, country/product starvation checks and measured wire/state/cache limits |
| Results | Separate fresh, expired, missing, unsupported and healthy-empty counts; any source disabled and its reason |
| Rollback | Compatible deployment identity, retained collection revision/evidence/quota, independent source-disable verification |

Only after these gates pass may the associated country and final release tickets
move to done. Source candidates legitimately blocked or excluded retain their
documented dispositions; the release report must not claim universal hazard
coverage. Do not restore an old private-state backup over newer events or quota.
