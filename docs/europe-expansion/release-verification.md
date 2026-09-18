# Catalog 3 release verification

The production release is accepted only when the exact public and wrapper commits are recorded and all deterministic gates pass:

- the pointer and immutable manifest validate and agree on producer, revisions, and fence;
- Snapshot V11 contains exactly the reviewed 679 destinations;
- exactly 45 fresh Conditions V3 objects contain their exact country memberships;
- the coverage contract matches the committed floors;
- `/api/healthz` returns HTTP 200 and `/api/v1/health` reports an available generation;
- `verify:production` has no blockers; and
- all six bounded production schedules complete without an unauthorized writer.

Provider degradation may produce HTTP 200 with `status: degraded` when the complete publication remains safe to serve. Invalid pointers, manifests, digests, membership, producer identity, freshness, or required objects return HTTP 503. No Met Office or MeteoAlarm credential is a release prerequisite.

Before the V15-to-V16 migration, stop old writers, rotate the private/public Blob credentials and cron secret, and preserve the immutable V15 backup. Publish and verify a complete Catalog 3 generation before deploying the new web reader. After migration, rollback may repoint the pointer to the preceding valid Catalog 3 manifest or deploy a V16-compatible read-only web release. Never restore V15, restart an obsolete collector, or resume Catalog 2 publication.

Record the immutable public SHA, wrapper SHA, deployment ID, manifest digest, migration result, schedule outcomes, health result, verifier report, and any reviewed source degradation in the private Pad workspace.
