# Catalog 3 operational publication

The compatible runtime supports collection releases2 and3. Deploying this code
alone does not change collection control, the public catalog or client release.
Activation and country rollout require their remaining Pad gates. This document
is an operational contract, not evidence of a deployed cutover.

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

Maintenance currently runs daily. Therefore an unacknowledged transition can
remain in dual publication longer than24 hours. Observe the actual recorded
window; do not infer completion from elapsed time since deployment. A bounded
manual authenticated maintenance invocation can repair/acknowledge earlier.

## Drained activation and rollback

1. Pass shared/catalog/country implementation gates, independent review,
   exact-SHA `scripts/verify`, and automatic GitHub `check:fast`. Prepare the final patched tree, not intermediate PR commits.
   Before its first schema-writing deployment, disable scheduling using a control
   effective on the old production runtime and drain existing invocations. The old
   runtime does not honor `INGESTION_PAUSED`; setting that flag alone is not a
   first-deployment drain. Confirm no old writer remains before deploying the
   compatible runtime with private collection2 and client catalog2. Verify legacy
   publication and save this compatible code revision as the rollback target.
   Prepare and verify its catalog3 build/deployment before activation; a
   catalog2-only rollback client is insufficient after legacy retirement.
2. Set `INGESTION_PAUSED=true` in the deployed environment. Authenticated cron
   calls then return503 before opening stores or issuing requests. Drain all old
   invocations; a local environment flag alone does not pause deployed workers.
3. Verify the deployed pause, absence of active invocations and absence of a live
   conditions lease. The configured60-second invocation duration is not proof of
   drainage. With matching private
   storage configuration and local `INGESTION_PAUSED=true`, run
   `node --import tsx scripts/activate-catalog3.ts --drained`. It checks the active
   conditions lease and CAS-changes2→3 with a higher revision, retaining all
   evidence/quota. Repeating it on3 does not restart the transition. The flag is
   an operator assertion of the externally verified drain, not an automatic
   guarantee that no warning worker is still running.
4. Resume the deployed schedule. Verify expanded namespaces, exact memberships,
   producer/release agreement and complete dual acknowledgment. Prepare and test
   the catalog3 client before activation so it can be switched after these early
   runtime checks and warm-up, within the recorded compatibility window. Verify
   the actual client switch before `dualUntil`; do not wait until that deadline to
   initiate deployment. The immutable deadline is not extended by a late switch.
5. Observe each country for at least24 hours from its verified operational
   readiness, recording fresh, expired, missing, unsupported and healthy-empty
   separately. This window can finish after client rollout. A complete dual-file
   acknowledgment may contain update-pending forecasts and does not start or
   satisfy country acceptance by itself. Record readiness and observation times
   separately from `dualStartedAt`/`dualUntil`. Countries remain incomplete until
   this evidence passes; the UI continues to expose pending or degraded data.

If the candidate client or rollback deployment is not ready, do not activate
collection3. After activation, an anomalous source is disabled independently and
the compatible catalog3 client displays its gaps. Do not keep a catalog2-only
production client past legacy retirement, reset the deadline, or restore state2
to manufacture additional transition time. Stop release completion and investigate
any failed deployed gate. See `release-verification.md` for the release ledger.

Revision checks cannot cancel public writes already issued by another process;
public CAS protects each pathname, not collection control. A drained monotonic
cutover is required. Rollback uses the679-capable compatible foundation with
collection3 and its revision retained. Never restore an older private backup over
new alert or quota state. Operational3→2 reversal is rejected; explicit catalog
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
