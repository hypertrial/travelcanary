# Seventeen-country expansion — implementation record

This is an **in-progress implementation**, not a release announcement. Production
still uses catalog 2 with 503 destinations in 28 countries. No new transport or
destination is activated by the review inputs in this branch.

## Reviewed-input work

`data/review-inputs/europe-expansion-catalog.json` proposes 176 explicit additions,
preserving the existing catalog byte-for-byte. It records GeoNames provenance,
country allocations, coordinates, aliases, timezones and candidate local matching
footprints. Its `candidate` status is intentional: coastal, warning-region and
observation representativeness checks are not finished.

The public projection fits the unchanged 150,000-byte budget. The automated check
uses the actual public schema fields and UTF-8 serialization; future release
metadata and public local-area labels must also fit before activation.

Independent review caught missing Latin spellings for Bodø, Tromsø, Svolvær,
Egilsstaðir and Ísafjörður. These aliases and their previously unpublished IDs are
corrected. Gomel, Grodno and Mogilev have explicit alternative names. San Marino's
candidate matching radii are reduced from 10 km to 1 km. A small radius is not
proof that a neighboring authority's warnings apply.

Island, mountain and park entries describe representative local areas. Their
`scope` and `scopeNote` must be carried into the new public contract and briefing
before activation. They must not be advertised as complete regional coverage.

A preliminary comparison against Natural Earth's 1:10m country polygons found
14 representative points outside their generalized polygons, including coastal
Norwegian/Icelandic cities and Vatican City. This is a review flag, not evidence
to move the GeoNames coordinates. Display geometry and authoritative warning
jurisdiction must be reviewed separately; generalized coastlines cannot establish
source eligibility.

## Source evidence and unresolved gates

`data/review-inputs/europe-expansion-sources.json` accounts for all 20 hazard and
seven conditions categories in every country. All 459 rows now have source
assessments linked to country reports in `docs/europe-expansion/`. Integration
gates remain explicit: an assessed category is not necessarily an approved
transport. `sourceReviews` holds candidate records and exact unresolved gates.
No candidate grants monitored coverage.

Bounded anonymous probes on 8 September 2026 established:

| Route | Result | Meaning and remaining gate |
|---|---|---|
| Nine new MeteoAlarm Atom feeds | All HTTP 200; immutable fixtures captured | Region/polygon matching, subtypes and lifecycle remain unapproved. |
| Iceland MeteoAlarm | Two already-expired warnings | Successful retrieval is not fresh warning evidence. |
| Moldova, North Macedonia, UK MeteoAlarm | Empty Atom feeds | Empty-feed semantics and nonempty lifecycle fixtures still required. |
| Serbia MeteoAlarm | Includes a Kosovo-labelled warning region | Do not map this implicitly into application country `XK`. |
| Belarus registered Atom/CAP | 15 index entries; Alert and referenced Update samples | Exact mappings, event vocabulary and cancellation tests remain required. |
| Iceland road segments and points | JSON, 358,289 and 20,863 bytes | Exact segment geometry, severity allowlist and lifecycle still required. |
| England flood warnings | Three bounded reads timed out | Documented candidate; no successful runtime acceptance yet. |
| FCDO content API | 15 verified new-country paths | Replay existing whole-country semantics; regional advice remains linked. |
| Vatican City FCDO path | HTTP 404 | Do not invent a replacement or inherit Italy's advice. |

The recorded probe hashes and timestamps describe historical samples; they must
never become live freshness claims. Fixtures include source text as untrusted
input. They are test data only.

The Belarus linked Alert and Update bodies are not redistributed here: their
reuse basis remains unresolved independently of the index's public-domain notice.
The dossier retains retrieval metadata and hashes for those two samples.

The following advertised routes are excluded under the approved access policy:

- Andorra's application-gated JSON forecast service.
- SEPA's requested-access Floodline API.
- Natural Resources Wales APIs requiring API-key signup.
- Statens vegvesen's registration-gated DATEX road-disruption route.

Iceland aviation colour codes remain excluded from ground-level volcano warning
scoring. MeteoSwiss explicitly includes Liechtenstein in its warning map, but its
structured transport, exact regions and unaltered-bulletin presentation still need
review. SAIS has six seasonal Scottish mountain regions; absence of a seasonal
hazard category is not an all-clear.

Official evidence is linked in the source dossier, including the
[MeteoAlarm directory](https://feeds.meteoalarm.org/),
[WMO Belarus registration](https://alertingauthority.wmo.int/authorities.php?recId=15),
[Iceland road data contract](https://www.vegagerdin.is/vegagerdin/gagnasafn/faerd-gagnasnid),
[IRCA reuse terms](https://www.vegagerdin.is/vegagerdin/gagnasafn/vefthjonustur/terms-and-conditions),
[NRW API access](https://api-portal.naturalresources.wales/), and
[Norway road access](https://dataut.vegvesen.no/dataservice/trafikkmeldinger-api).

## Capacity evidence

The candidate simulation invokes the existing `forecastBatches`, quota calculation
and cache fitting. Only the catalog, marine workload and proposed cadence are
substituted: 679 weather/AQ destinations and a conservative 307 marine destinations
(all 176 additions plus 131 existing mapped destinations). This does **not** approve
marine coverage for inland destinations.

The hourly simulation models seven days at the actual scheduled minute, 40-point
batches, 400-call run limit, per-product limits, expiry-driven urgency and the
45-second reservation horizon. Separate cases exercise minute/hour/day boundaries,
recovery bursts, next-run rescheduling after an outage and an exhausted initial
rolling-day reservation. Actual split retries, throttling and cooldown are checked
by the existing conditions transport tests, rather than claimed by the scheduling
simulation.

The initial run measured a peak of **6,553 reserved calls**, higher than the plan's
approximately 6,353 scheduled-call estimate. At an hourly boundary, a reservation
can remain charged for the extra 45-second source phase. This leaves 1,447 calls,
about **18.1%**, under the unchanged 8,000 rolling-day limit. Do not describe the
planning estimate as a measured 20% reserve.

The fixture-based cache test does not establish worst-case production capacity.
Still required: populated alert/observation state, country and total conditions
files, snapshot bytes, compatibility-output publication cost, asset budgets,
concurrent producers and measured production quota behaviour.

## Compatibility foundation constraints

Independent architecture review identified these prerequisites:

1. Freeze legacy country/provider schemas transitively. Extending a shared enum
   used by exhaustive `z.record` schemas would invalidate historical payloads.
2. Keep the original `/locations.json` projection available to old clients. New
   clients need a versioned catalog URL, not just a new snapshot URL.
3. Version snapshot and conditions publication paths; do not overwrite an old
   client's path with an incompatible expanded payload.
4. Preserve events, cancellations, leases and quota reservations in the new private
   state version. The historical V2 conditions cache limits allow 600 records; V13 preparation now accepts 679 while production collection remains catalog-2-only.
5. Publish old/new projections from the same collected evidence. Each write needs
   monotonic concurrency protection and repair after a partial publication.
6. Persist the transition start time so restarts cannot extend the 24-hour window.
7. Drain old ingestion jobs at cutover. Roll back to the compatible foundation and
   disable anomalous sources; never restore stale private state over newer records.

## Completion gates

Source investigation has separate acceptance from release activation: complete
all 340 hazard and 119 condition dispositions, freeze the 176-record roster,
retain representative structured fixtures and measure catalog/forecast capacity.
Blocked sources with exact unresolved gates do not prevent completing that
investigation or implementing the independently approved source groups.
Country and final-release tickets still require their integration, capacity,
compatibility, CI and deployed observation gates below.


The source/catalog investigation remains open. Shared production changes follow
its approved inputs; country tickets become ready only when their specific source
decisions and mappings are specified. Required verification includes targeted
checks, both repository verify wrappers, independent review, exact-commit CI and
the documented deployed 24-hour observations for each country group.

The final report must separate catalog additions, verified monitoring additions
and remaining monitoring gaps. This document makes none of those completion claims.

## Checkpoint verification

The initial full wrapper passed lint, types, data checks, 742 unit/integration
tests, audit, build and asset/performance checks. Browser checks returned 177
passes, 46 skips and three failures: one selected-destination typing assertion
and two map-ready waits. An isolated rerun passed the typing test and one visual
check; the remaining visual check still failed its map-ready wait. The browser
completion gate is unresolved. Independent review found no evidence that these
failures originate in the offline inputs; the visual tests depend on live
basemap loading. No assertions or application behavior were changed to hide the
failures.

## Compatibility identity freeze

The first compatibility increment binds historical snapshot/state country, source
and provider identities to immutable release definitions. Current aliases retain
Snapshot V10, state V12 and conditions V2; no output path changes yet.

Publication validation uses the frozen catalog-2 ID list independently of the
active catalog. Historical V1–V9 parsers retain their existing 500-key behavior;
exact membership is enforced at publication, not retrofitted into those parsers.
Tests widen current identity aliases and verify old payloads, migration output,
conditions, and nested rejection boundaries remain unchanged.

The older V8 delayed-hazard conversion now uses frozen eligible-provider lists,
including empty location overrides. Six baseline fingerprints cover all original
500 destinations under different health combinations; the same results survive
changes to active source metadata. The artifact records its source revision and
input hashes. Future condition helpers still need deliberate versioning.
State V13, expanded readers, versioned publication, transition repair, and rollback
tests remain required before activation.

The final verification of this increment passed `scripts/verify-fast` and
`scripts/verify`: 760 unit/integration tests, 180 browser passes and 46 planned
skips, with no browser retries in this run. Audit, build and unchanged asset
budgets also passed. Earlier intermittent search-input and visual failures remain
recorded separately; a passing rerun is not a root-cause fix.

The reviewed-input checkpoint is draft PR #6 at commit
`35958ea0515d77cce19e6dc2a191430733a77cf4`; its manually dispatched CI passed
(run `34253096132`). These results do not satisfy the remaining country-release
verification or production observation gates.

## Frozen expansion membership and legacy publication paths

Catalog release 3 now records the reviewed 679-ID membership separately from the
active catalog. It retains all original 503 IDs and adds the reviewed 176, with
hashes of both inputs. It is explicitly **not activated** and has no runtime import.

Legacy catalog, snapshot and conditions paths share one lightweight definition.
Conditions V2 publication validates country membership against the frozen
catalog-2 artifact, including when the active catalog changes. Nested legacy blob
paths and partial-country repair remain supported. New identities cannot be
published into those old conditions files. This is still a V10/V12/V2 deployment;
the new state migration and dual-output publisher are not implemented yet.

Independent data/security review passed the path and membership changes. Both
verification wrappers passed 788 unit/integration tests. The full wrapper with
the repository's CI settings passed 180 browser tests with 46 planned skips and
no retries. A preceding default-worker run failed one screenshot stability wait;
the unchanged isolated case passed. Its cause remains unverified and no UI fix
or weaker assertion is claimed.

Foundation commit `32cd8587b91da7f1cde49998ffd42e1019ac285d` passed exact-commit CI
(run `34256677333`) in draft PR #7. The subsequent path/membership increment needs
its own exact-commit CI after publication.

## Inactive expanded-state reader and assessment checkpoint

`catalog-state.ts` introduces an independently callable V13 reader. It preserves
accepted V1–V12 state through the existing migration chain, adds unsupported
partitions for the 17 new countries, and carries a collection catalog/revision.
Its 679-location bounds accommodate the expanded catalog while retaining quota,
lease, transport and payload limits. Current production storage still reads and
writes V12; this module is not a production cutover or rollback implementation.
Canonical V13 writes require collection fencing, writer drain, versioned public
contracts and publication repair before activation.

The eight assessment reports cover all 459 country/category combinations. Exact
source records include the separate Scottish observations, Welsh/NI traffic,
UK-AIR observations and regional utility candidates. These remain blocked or
linked information under their documented gates. SLF's retained winter GeoJSON
confirms the Liechtenstein region and Malbun intersection; that is an approved
implementation candidate, not activation for all Liechtenstein destinations.

Fixture paths and hashes in the structured dossier identify evidence retained in
Git. Reports also cite historical `/tmp` probe paths: those are research provenance,
not portable fixtures or runnable test dependencies. Unretained nonempty responses
must be replaced by redistributable fixtures before their integration gate closes.
Belarus linked CAP bodies remain unretained pending reuse verification.

Foundation commit `b862b4735ac09b07d04e0648a5527a4aea5d993b` passed exact-commit
CI run `34259590393`. Source fixes subsequently passed 814 unit/integration tests
and 180 browser tests with 46 planned skips and no retries in the full wrapper.
Those results precede this inactive reader and assessment checkpoint; its own
verification is recorded separately. No country-release or production observation
gate is satisfied by these development checks.

This reader/assessment checkpoint passed `scripts/verify-fast` and
`CI=true scripts/verify`: 845 unit/integration tests, 180 browser passes and
46 planned skips, with no retries. Lint, types, audit, build and unchanged asset
and performance budgets passed. Independent reader and dossier reviews passed;
no production state or source was changed.

## Canonical V13 storage preparation (catalog 2 only)

The next foundation increment switches private runtime reads and writes to V13.
Historical readers remain frozen in `schemas.ts`; runtime consumers import the
canonical type directly from `catalog-state.ts`. Reading old state preserves its
accepted fields and collection defaults. The first conditional V13 write retains
an immutable backup of the old wire format for diagnostics, never for rollback
over newer state.

Source collection, maintenance, conditions and initialization reject catalog 3 in
this increment. They capture catalog/revision before work and reject stale results
on merge or CAS retry. Blob writes validate monotonic control against an independent
copy captured alongside the ETag, because workers may mutate their read data.
Existing public output remains the exact catalog-2 snapshot and conditions files.

Conditions cancellation retains issued-request quota charges and real throttling
cooldown. Cleanup removes only its own lease and matching attempt markers. After a
known control mismatch, queued forecast requests stop and active callbacks drain
before cleanup, so a late HTTP 429 still updates cooldown. Maintenance can repair
publication from committed state without recollecting upstream data.

Deployment gate: drain every old V12 writer and publisher before enabling canonical
V13 writes. A private-state reread before publication is not an atomic cross-store
fence. This increment exposes no activation control; catalog cutover and future
transport cancellation still require publisher drain/repair. It is **not yet the
rollback foundation**: full 679-destination execution, versioned public contracts,
dual-output transition and their rollback tests remain required before activation.

Canonical preparation validation: both wrappers passed 870 unit/integration tests;
the full wrapper passed 180 browser tests with 46 planned skips and no retries,
plus lint, types, audit, build and unchanged budgets. Independent review's
concurrent-cancellation finding was fixed and covered by a ten-batch/eight-active
request regression. Reader checkpoint `ea54fb6ad139e9928a98a339d75c3b16bd933be4`
also passed exact-commit CI run `34264871623`. These are development checks;
production migration, catalog activation and release observations remain pending.


## Compatible public readers (inactive catalog 3)

Private preparation commit `b56764d63062ee99dded970e360827c96ff0c411` passed
exact-commit CI run `34266821999`. The next increment adds explicit Snapshot V11
and Conditions V3 contracts for catalog 3, with exact frozen destination membership
and country partitions. Existing snapshot, conditions and provider identities stay
frozen. New local-area destinations require their reviewed scope description.

The compatible application reader accepts a valid catalog-2 snapshot while loading
catalog 3. It retains the actual snapshot version and existing evidence; missing
new destinations show unknown/update-pending with unavailable freshness. It never
pads old evidence into a purported expanded snapshot. Conditions use the selected
release's own country file; an unavailable new file does not fall back to a neighbor
or another release. Request epochs separate release/origin changes, including
returning to a previous release while an old request is still pending.

Catalog-3 paths are `/catalogs/3/locations.json`, `catalogs/3/latest.json`,
`catalogs/3/previous.json` and `catalogs/3/conditions/v3/<country>.json`.
Their contracts and readers are preparation only: active configuration, public
catalog assets and publication remain catalog 2. No country or source is activated.
Versioned producers, 24-hour compatibility output and full-catalog collection
remain subsequent gates. These reader changes alone are not a rollback release.

Public-reader validation: both wrappers passed 937 unit/integration tests. The
full wrapper passed 180 browser tests with 46 planned skips and no retries,
plus lint, types, audit, build and performance checks. Map-ready assets measured
596,443 bytes and selected assets 641,101 bytes under the unchanged 600/650 KB
limits. The complete public catalog projection with local-area descriptions is
147,057 bytes under 150 KB. Independent review approved after missing-destination
freshness and stale-request regressions were fixed. These results do not constitute
expanded production activation or the required 24-hour observations.


## Versioned storage preparation (unwired)

`BlobCatalog3SnapshotStore` and `publishCatalog3ConditionsFiles` prepare the
catalog-3 namespace. No production collector, bootstrap or maintenance route
uses these APIs yet. They validate their own wire versions and exact membership
before storage writes, with unchanged snapshot and conditions byte limits.
Malformed or wrong-version existing objects fail rather than being overwritten.
Public reads use authoritative ETags and bounded payloads.

The V11 store creates a missing namespace conditionally. Before advancing latest,
it stages the prior valid generation in that namespace's `previous.json` using
monotonic conditional writes. A failed latest write can leave previous equal to
latest; this preserves the last valid generation but is not an atomic predecessor
pair. Equal/older candidates do not rotate previous. Future candidates beyond the
five-minute clock tolerance are rejected; invalid future generations are never
retained as rollback evidence. Callers must reread committed state and rebuild
after a conflict instead of making old evidence appear newly collected.

Legacy V10 publication keeps its existing path and write order. Country publication
reuses the bounded four-worker, three-attempt conditional loop; a failed country
is reported separately and does not suppress successful peers. Stored country
identity must agree with the pathname, including before an unchanged result.
V3 requires all 45 country files from one generation and producer, rejects future
candidate generations beyond five minutes, and repairs schema-valid future stored
files using their ETags. Legacy clock behavior remains unchanged.

The 1.5 MiB check currently bounds the submitted complete generation. Partial
publication can retain files from an older generation; their combined stored size
can exceed either generation's size. This is an explicit activation gate: capacity
and transition orchestration must bound mixed-generation storage as well as each
candidate, including compatibility outputs. The new unwired publisher alone does
not establish that aggregate storage guarantee.

This increment does not implement full-catalog projections or the 24-hour dual
publication transition. That later orchestration needs durable transition metadata
in a state version understood by every supported rollback writer, and a documented
drain of old collectors and publishers. It must build both releases from the same
committed evidence and clock, preserve ordinary expiry and quota state, and repair
partial publication without repeating upstream collection.


Storage preparation validation ran in an isolated worktree with Node 24 and npm
11.6.2. Both wrappers passed 972 unit/integration tests; lint, types, audit, build
and budgets passed. Browser verification reported 179 passes, one screenshot
check passing on retry, and 46 planned skips. The affected unavailable-control-rail
screenshot then passed three repetitions with retries disabled. Its initial
five-second element-stability timeout remains recorded as a test reliability
observation, not a fixed production defect. Assets remained 596,443/641,101 bytes.
Independent storage review passed, including 35 new namespace, CAS, size, stream,
generation and clock regressions. Public-reader commit
`905a41f54ef9657a938e6127a90bc6f31f909fd4` passed exact CI run `34269260548`.


## Inactive catalog and pending projections

Catalog 3's deterministic public artifact is `public/catalogs/3/locations.json`:
679 exact release IDs across 45 countries, 147,057 bytes including the newline.
`catalog:check` checks reproducibility in the normal verification wrapper. Full
private records combine the frozen 503 originals with the reviewed 176 additions;
empty source-region mappings are valid and confer no monitoring eligibility.
The currently configured catalog and all collectors still use release 2.

Pure compatibility projectors produce V10 snapshots and V2 conditions from the
same V13 evidence for either collection release. During collection 3, the three
partitioned provider aggregates are scoped to the original 28 countries using
the existing health aggregation rules. They do not mutate private state, quota
reservations or source health. Guarded production builders still reject collection
3 until transition orchestration is implemented.

The separate pending V11/V3 projections retain the old destinations' evidence and
represent all 176 additions as unknown/update-pending. They withhold even matching
new-destination events and cached conditions. New country partitions are disabled
with null success/update timestamps; pending conditions have no source attribution
or source health. These are preparation projections, not monitoring activation.

The unpublished V11 contract now explicitly accepts `updatePending: true` only
with UNKNOWN, partial coverage, no hazards and no delayed hazards. Legacy V10 is
unchanged. Readers show pending messaging and unavailable destination freshness,
even when the surrounding snapshot was just generated; snapshot staleness does
not turn this absence of monitoring into a delayed-source assertion. Deploy this
compatible reader before any producer emits the pending field. Global provider
health continues to describe collected sources, not universal hazard coverage.

Publication remains unwired. Durable transition metadata, all-country collection,
reviewed eligibility, mixed-generation capacity bounds, rollback orchestration,
source activation and production observation remain required gates.


Pending-projection validation: both wrappers passed 986 unit/integration tests;
full verification passed 180 browser tests, 46 planned skips and no retries.
Lint, types, audit, build and performance gates passed. Assets measured
596,633 bytes map-ready and 641,307 bytes after selection. Fourteen new tests
cover exact catalog serialization, old/new projection parity, pending evidence
isolation, invalid wire combinations, staleness and mutation safety. Independent
contract and trust-boundary review passed. Storage commit
`51d512e080e4928949186e2cbff10c90741df5ac` passed exact CI run `34271728475`.


## Compatible V14 rollback foundation

V14 preserves the frozen V13 state and adds explicit publication transition and
expanded-source receipts. Migration initializes a null transition and no receipts;
it never infers new-country success from old global provider health. Original V13
bytes are backed up before the first V14 write, just as older historical versions
are preserved. Canonical writers and guarded catalog-2 collectors retain all V14
fields. V13 remains a frozen historical reader, not a supported rollback writer
once V14 is published.

Changing catalog direction requires a higher collection revision and an explicit
unacknowledged transition. This includes a controlled 3-to-2 rollback, which keeps
all private evidence and quota controls. Both initial publication timestamps are
null until complete dual output is acknowledged; the acknowledged pair spans
exactly 24 hours and cannot be erased, rewound or extended by ordinary writes.
Immutable captured controls protect against mutation of a caller's read object.
Transition completion and publication orchestration are not wired in this
foundation, and collectors still reject catalog 3.

Only USGS, EMSC, FCDO and SLF have expanded-cohort receipt slots. Their exact new
scopes contain 176, 176, 145 and one destination respectively. Each actual
expanded attempt classifies its entire scope once as checked or unavailable.
Missing receipts mean never collected. Unsuccessful attempts retain prior success
and source-update timestamps; checked destinations require a success at that
attempt. Older or non-identical same-time receipt updates are rejected. Receipt
updates require unchanged catalog 3 and revision, so rollback and legacy-only
collection cannot refresh new-country health. These receipts preserve history;
new source collection, scoped event replacement and UI interpretation remain
operational implementation gates.

Independent review found and resolved failed-refresh history loss and simultaneous
revision/receipt updates. Forty transition and receipt tests pass, alongside the
full 1,026-test unit/integration suite. Both repository wrappers passed, including 180 browser tests, 46 planned skips
and no retries; lint, types, audit, build and budgets passed. Assets remain
596633/641307 bytes. Exact commit cbad46da17b91a9b2e72e390b86cb04b7d14eab1
passed CI34276015665. This state-compatible runtime still refuses catalog 3
collection. Deploy the later operational 679-capable foundation before activation
and use that release for operational rollback; this preparation alone is not a
679-destination availability guarantee.
Drain V13 writers and publishers before any first V14 write; cross-namespace
publication is still non-atomic and requires bounded repair.


## Approved collection implementation

The collector now supplies source-specific destination scopes. USGS and EMSC can
use all 679 locations; FCDO uses the existing 28 countries plus 15 verified new
pages (GB and VA are excluded); SLF adds only Malbun to its existing Swiss
mountain scope. Every other adapter retains its existing locations and country
fanout. Production entry points still require catalog 2: these changes do not
activate new countries or publish new data.

Expanded results must classify their exact collected scope. Invalid or failed
adapter results become unavailable receipts, never successful empty checks.
USGS impact-product failures mark affected destinations unavailable while retaining
prior unexpired evidence. FCDO validates quiet and active pages, timestamps,
whole-country alert status and any supplied page path. A retained live Belarus
field extract verifies the actual response contract. Its `updated_at` is the
content-store record timestamp; the separate `public_updated_at` is retained in
the fixture and is not described as the collection time.

Pure merging supports catalog 3 receipts. Existing source health remains scoped
to the original 503 destinations; independent expanded receipts prevent a new-only
outage from delaying successful old-country checks, or an old-only success from
refreshing uncollected destinations. Failed, partial, disabled and repeated
results preserve evidence outside the actual collected scope. Existing providers
that are not approved for expansion keep their historical merge behavior.

Independent review found and fixed two deletion paths: disabled-source removal
and cancellation prefixes in a partial result with no checked destinations.
Regressions exercise both scopes and replay. Targeted tests also cover all 176
quake coordinates, the 15 FCDO mappings, real and synthetic SLF bulletins, partial
cohort failures, stale receipts, and collector dispatch. Both wrappers passed: 1,087 unit/integration tests, 180 browser tests, 46 planned
skips and no retries. Lint, types, audit, build and existing hard budgets passed.
Exact-commit CI and deployed verification remain outstanding acceptance gates.


## Reviewed expanded coverage projection

The active V11 projection starts every new hazard as not monitored, then grants
only reviewed USGS earthquake capability and Malbun-only SLF avalanche capability.
EMSC remains preliminary context and FCDO remains whole-country advisory context.
All other new national warning partitions remain explicitly disabled. This pure
projection is implemented but is not yet connected to production publication.

V11 providers can carry a small public expanded-coverage receipt: status, check
time, and exact checked/unavailable destination IDs. Only the four approved
providers may carry it. The scope is complete, disjoint and tied to the reviewed
catalog; no private error text or transport diagnostics are published. The field
omits aggregate source-update timestamps because, for example, one FCDO page's
update must not be attributed to another country. Actual incident/advice evidence
retains its own source timestamp. V10 remains frozen.

New destination provider rows use these scoped receipts. Eligible destinations
with no receipt have unavailable checks; ineligible providers remain unmonitored.
A checked member of a partially failed cohort may be current, while an unavailable
member never inherits the cohort's successful check time. Monitoring freshness
uses only applicable USGS/SLF receipts, never FCDO, EMSC fallback or forecasts.
FCDO-first active advice stays visible while monitoring remains unavailable.

The client re-evaluates receipt age at the provider cadence boundary. Stale new
locations delay only their approved hazards, leaving unsupported categories as
coverage gaps. Pending entries remain pending. Expanded summary counts require
current checks and report delayed checks separately. All original 503 destination
states and coverage presentations remain unchanged in regression fixtures.

Initial byte measurement using empty private state: pending V11 is 291,414 bytes;
active V11 with four successful expanded receipts and explicit hazard gaps is
337,198 bytes. Brotli sizes are 8,035 and 9,089 bytes respectively. This is not a
dense-event publication bound or production measurement. The 500 KB hard limit
is unchanged; full-catalog capacity cases remain required before activation.

Coverage validation: both wrappers passed 1,110 unit/integration tests, 180 browser
tests, 46 planned skips and no retries. Independent review passed after cadence,
staleness and missing-receipt summary regressions were fixed. Assets measured
597,474 bytes map-ready and 642,546 bytes after selection; limits remain
600,000/650,000. Collection commit 8b146cf6cbadbe7842b0cfd417b1ad536546b838
passed exact CI34279240963. This coverage commit still requires its own CI and
operational activation gates.
