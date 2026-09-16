# Catalog 3 operational publication

The compatible runtime supports collection releases 2 and 3. Merging or deploying
this code alone does not change collection control, the public catalog, or the
client release. This document is the authorized operational contract for the
catalog 3 cutover, not evidence that a deployment has already completed.

## Commit evidence once, then publish

Only the four approved expanded warning/context adapters and reviewed forecast
products receive expanded destinations. Other national transports keep their
legacy scope. Every reservation and evidence merge checks the captured collection
revision. A publication failure after a successful state write must not merge the
source result again or refund issued-request quota.

The shared publisher reads committed state and captures a separate publication
clock after that read. Both snapshot projections and both conditions families use
the same clock and evidence. Accepted check timestamps may advance it only within
five minutes of wall time; genuinely future-dated private checks fail publication.
Actual source timestamps and expiry are preserved. Transition deadlines and
completion use actual wall time, so accepted clock skew cannot shorten the24-hour
compatibility period. A slower collector must not
publish a generation older than a concurrently committed source check.

Normal ingestion publishes snapshots; the conditions worker publishes conditions.
Maintenance repairs both families without upstream collection or quota charges.
All candidates are validated before public writes. Each blob uses bounded reads
and conditional creation/update. Country caps constrain mixed V3 generations.
Cross-file or cross-namespace publication is not atomic; a failure can leave a
mixed generation which the next bounded publication repairs.

## Forward compatibility window

The2→3 state change creates an unacknowledged transition. Until maintenance has
confirmed both snapshots and all45 V3/28 V2 conditions files for one candidate,
both releases keep publishing. A newer or equal-time different stored output is
not confirmation. An `unchanged` snapshot result must be read and compared to the
candidate before acknowledgment. Missing, duplicate or failed country outcomes
cannot acknowledge the transition.

After successful complete dual publication, maintenance CAS-updates only the
transition timestamps, retaining concurrent alerts, fingerprints, conditions,
leases and quota. The24-hour window starts at actual publication completion.
A failed acknowledgment is retried from a fresh state read; an already recorded
deadline is never reset. At the exact deadline, legacy writes stop. Existing
legacy files retain their original evidence times and expire through the frozen
reader's normal rules; retirement never manufactures freshness.

The release initialization invokes maintenance once after the fast, slow, and
conditions collectors. That bounded repair verifies the complete dual generation
and records the immutable 24-hour deadline immediately. The normal daily cadence
is unchanged and can repair any later partial publication.

## Revision-fenced activation and rollback

1. Pass shared/catalog/country implementation gates, independent review,
   exact-SHA `scripts/verify`, and automatic GitHub `check:fast`. Deploy that same
   compatible commit while `NEXT_PUBLIC_CATALOG_VERSION=2`, verify catalog 2, and
   retain the commit as the rollback target. Prepare and verify its catalog 3 build
   before activation; do not deploy an intermediate tree. No warning-source
   credential is required: MeteoAlarm EDR and Met Office remain optional,
   non-contributing, and request-free while unconfigured. Never print secret
   values in release evidence.
2. With the deployed private storage configuration, run
   `node --import tsx scripts/activate-catalog3.ts`. The command atomically
   compare-and-swaps collection 2→3 with a higher revision while retaining evidence
   and quota. Every collector and publication write carries the captured revision,
   so work started before activation is rejected if it attempts to overwrite newer
   catalog 3 state. Repeating the command on catalog 3 is a no-op.
3. Invoke one fast, slow, and conditions initialization, then one maintenance
   repair. Verify the 679-member Snapshot V11, all 45 Conditions V3 files, the
   frozen catalog 2 Snapshot V10 and 28 Conditions V2 files, matching producer and
   release identities, and the recorded 24-hour `dualUntil`. These are bounded,
   deterministic release checks, not an observation or soak gate.
4. Redeploy the same commit immediately with
   `NEXT_PUBLIC_CATALOG_VERSION=3`, then run the production verifier and public
   `/api/v1/health` check. The verifier invocation must set
   `EXPECTED_CATALOG_VERSION=3` (or `--expected-catalog-version 3`) alongside the
   exact release SHA and required local-conditions flag. Completion requires a
   non-blocked verifier report and HTTP 200 health; there is no soak delay. Catalog
   2 publication continues automatically in the
   background until the exact recorded deadline; it does not delay the client
   switch and does not change cron frequency.

If the candidate client or rollback deployment is not ready, do not activate
collection 3. After activation, an anomalous source is disabled independently.
Disabling or exhausting an active required coverage transport intentionally
degrades health and cannot satisfy release completion; the catalog 3 client
displays the gap honestly. Optional Met Office health does not affect this gate.
Do not keep a catalog 2-only production client past
legacy retirement, reset the deadline, or restore state 2 to manufacture more
transition time. Stop release completion and investigate any failed deterministic
gate. See `release-verification.md` for the release ledger.

Revision checks cannot cancel public writes already issued by another process;
public CAS protects each pathname while collection fencing prevents stale state
commits. Rollback uses the 679-capable compatible foundation with collection 3 and
its revision retained. Never restore an older private backup over new alert or
quota state. Operational 3→2 reversal is rejected; explicit catalog
withdrawal would require a separately reviewed procedure.

`INGESTION_DISABLED_SOURCES` accepts a comma-separated allowlist of existing
adapter IDs. Unknown IDs fail before collection. A stopped transport makes zero
requests and records `transport_disabled` through the failure lifecycle, retaining
unexpired prior evidence and making the collection failure visible. Other adapters
continue. Conditions have the existing `CONDITIONS_DISABLED_SOURCES` switches;
registration-gated and unapproved sources remain excluded. Disabling a source is
not evidence that its hazards are absent.

## Verification prerequisites discovered during implementation

WORK-82 updates only the existing js-yaml/sharp dependency families to the
compatible patched versions4.3.2/0.35.4 (including sharp's libvips1.3.3 binaries).
The updated [YAML advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)
and [image-library advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
failed the mandatory high/critical audit gate. Unrelated resolutions are retained;
clean npm11 installation and independent lock review pass. The two moderate
Vitest development findings remain outside this targeted patch.

The historical demo generator also required its country loop to use the frozen
28-country list rather than all45 private-state partitions. The real script is
regression-tested in a temporary directory: it produces valid V10/503/28 output
and leaves the checked-in demo untouched.
