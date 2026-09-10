# WORK-53 independent shared-provider semantic review

Verdict: proceed with narrowly scoped shared-provider eligibility; retain explicit activation gates. This is an eligibility review, not approval to activate the expansion before catalog, schema, and source gates pass.

## Geography verified

Read-only Python review of `data/review-inputs/europe-expansion-catalog.json` found exactly 176 candidate destinations. Their radius footprints fit the current requested envelopes for EMSC [-30,25,55,75], EFFIS fire danger [-25,25,50,72], EFFIS active fire [-25,25,45,72], EDO [-25,22,51,72], and EONET's intended [-36,27,45,72] envelope. Bounds were calculated using longitude radius r/(111.32*cos(latitude)) and latitude radius r/110.574. This establishes request-bound compatibility, not valid raster pixels or complete event detection.

EFFIS fire danger currently samples only resort/island/park/mountain/coastal types: **30 eligible, 146 excluded** under that existing policy. Counts: AD2, AL2, BA2, GB7, IS2, LI1, ME2, MK2, NO5, RS3, TR2.

The 30 IDs are: ad-pas-de-la-casa, ad-soldeu, al-theth, al-valbona-valley, ba-bjelasnica, ba-jahorina, gb-cairngorms-national-park, gb-eryri-national-park, gb-isle-of-skye, gb-lake-district-national-park, gb-orkney-islands, gb-pembrokeshire-coast-national-park, gb-shetland-islands, is-vatnajokull, is-ingvellir, li-malbun, me-durmitor-national-park, me-lovcen-national-park, mk-galicica-national-park, mk-mavrovo-national-park, no-flam, no-geilo, no-geiranger, no-jotunheimen-national-park, no-lofoten, rs-kopaonik-national-park, rs-tara-mountains, rs-zlatibor, tr-goreme, tr-pamukkale.

## Provider findings and final decisions

The final `sourceReviews` decisions in
`data/review-inputs/europe-expansion-sources.json` govern implementation. This
report retains earlier geographic eligibility findings; geographic fit alone is
not implementation approval. Only USGS/EMSC, approved Open-Meteo products, the
15 verified FCDO mappings and SLF Malbun currently have implementation approval.
Other products below retain their exact unresolved matrix gates.


### USGS — activate existing earthquake eligibility for all 176

Global feed and geometry matching do not depend on national source mappings. Preserve magnitude >=4.5, proximity fallback, ShakeMap intensity matching, source timestamps, deletion handling and six-hour lifecycle. This is reported-earthquake monitoring, not complete detection of small earthquakes. Existing USGS tests cover geometry, stale summaries, deletion, partial products and URL restrictions. Add candidate-coordinate matching cases, especially Iceland and eastern Turkey.

Official contract: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
Code: `src/lib/ingestion/adapters/usgs.ts`; tests: `tests/unit/usgs.test.ts`.

### EMSC — activate existing fallback eligibility for all 176

All candidate footprints fit the requested envelope. Preserve preliminary ELEVATED context, 100/250 km matching, six-hour expiry and `satisfiesCoverage:false`. The exact FDSN service explicitly licenses its data CC BY 4.0; broader restrictive website terms do not negate that explicit service licence. Add direct fallback fixtures for new destinations, 204 responses and the 200-record boundary. Do not claim complete monitoring from a capped response.

Official service and licence: https://www.seismicportal.eu/fdsn-wsevent.html
Code: `src/lib/ingestion/adapters/emsc.ts`.

### EFFIS fire danger — geographic eligibility for 30; 146 outside current policy

A fresh raster must supply a valid intersecting sample before monitoring is reported. Do not broaden the outdoor-type filter to cities incidentally. Preserve forecast terminology, FWI >=38 and unavailable-sample handling. Existing tests cover thresholds, no-data and geometry but do not prove valid pixels at all 30 new destinations.

Forecast semantics: https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/fire-danger-forecast
Reuse licence: https://forest-fire.emergency.copernicus.eu/about-effis/data-license
Code: `src/lib/ingestion/adapters/effis.ts`; tests: `tests/unit/effis.test.ts`.

### EFFIS active fire — geographic eligibility for all 176; transport evidence still required

The anonymous EFFIS transport is distinct from FIRMS and already operates without FIRMS_MAP_KEY. Preserve acquisition-time validation, 12-hour expiry, confidence rules, 50 candidate confirmations, bounded perimeter requests and partial-result reporting. Absent satellite detections never establish wildfire-warning coverage. Existing tests cover keyless operation, confidence, stale observations and perimeter lifecycle. Exclude new FIRMS registration/key acquisition under the user's constraint.

Detection limitations: https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/active-fire-detection
Reuse licence: https://forest-fire.emergency.copernicus.eu/about-effis/data-license
Code: `src/lib/ingestion/adapters/firms.ts`; tests: `tests/unit/firms.test.ts`.

### CEMS Rapid Mapping — blocked for new-country activation

The separately identified capped-page replacement defect was fixed in
`70f9164a43f8129e602f3ef967e4ce92710b297d`: capped/incomplete pages remain partial,
unexpired evidence is retained, and explicit closed/sensitive withdrawals still
apply. This fix does not resolve new-country naming or geographic eligibility.


`src/lib/ingestion/adapters/cems.ts:13` hard-codes the original 28 country names. New-country-only activations are discarded before geometry matching. Record exact service names, including Kosovo/Türkiye variants, then add representative fixtures. An AOI is an area requested for analysis, not necessarily hazardous or affected land. Preserve mapping-activation wording rather than treating AOIs as official local warnings. Preserve sensitive/closed filtering, source-update +24h expiry and bounded detail fanout.

Official AOI definition: https://mapping.emergency.copernicus.eu/about/rapid-mapping-manual/product-overview/
Official API catalogue: https://data.jrc.ec.europa.eu/service/9d439213-2598-5d04-b6b3-f2882e4b0fb6
Tests: `tests/unit/cems.test.ts` cover AOI matching, partial geometry, closed/sensitive records and bounded fanout; they do not establish new-country names.

### GDACS — geographic discovery eligibility for all 176; no public warning coverage

The worldwide endpoint filters candidates against catalog geometry and produces no public events. Preserve that boundary. Upstream default pagination is limited; a successful request is not a complete worldwide incident inventory. Keep bounded discovery and document omissions. Add new-coordinate candidates to existing parser/lifecycle tests.

Official API: https://www.gdacs.org/gdacsapi/swagger/index.html
Pagination contract: https://gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf
Code: `src/lib/ingestion/adapters/gdacs.ts`.

### GFM — blocked pending exact anonymous raster and temporal contract verification

Do not reject GFM merely because the GloFAS website requires login: official GFM documentation explicitly describes freely accessible WMS-T. The current adapter uses three raster layers, a 2.56 km local window and at most 12 selected targets; it sets sourceUpdatedAt to checkedAt. Verify exact layer availability, acquisition/product timestamps, exclusion/likelihood interpretation and local footprint availability before expansion. Preserve the environment gate and `satisfiesCoverage:false`; no blanket flood coverage.

Official GFM product/access presentation: https://global-flood.emergency.copernicus.eu/media/events/8/seewald_michaela_globalflood25_the-global-flood-monitoring.pdf
Code: `src/lib/ingestion/adapters/satellite.ts`.

### EONET — original query mismatch fixed; expansion evidence still gated

The original adapter used `bbox=-36,27,45,72`. Official V3 documentation specifies minimum longitude, maximum latitude, maximum longitude, minimum latitude. The documented European query is `bbox=-36,72,45,27`.

This is an existing contract mismatch, not a defect introduced by catalog expansion. Commit `70f9164a43f8129e602f3ef967e4ce92710b297d` corrected the order and added a URL-level regression; the remaining final matrix gates still apply. All 176 are geographically eligible for the intended envelope after correction. Preserve 72-hour geometry dates, point buffers/polygon matching, open-event filtering and `satisfiesCoverage:false`. The new regression exercises query coordinate order. EONET closure dates are not guaranteed to represent absolute event ending times.

Official exact contract: https://eonet.gsfc.nasa.gov/docs/v3
Tests: `tests/unit/context-feeds.test.ts`.

### EDO — geographic context eligibility for all 176; valid-cell verification still required

Preserve the exact 1824x1200 raster grid, class-3-only events, product-date validation and 25-day expiry. A centroid sample represents regional agricultural/ecosystem context, especially for urban microstates and mountainous/glaciated locations. No-data must not become no-drought. Existing exact-grid/staleness tests are useful; fresh sampling should record class/no-data outcomes at new coordinates. The official dataset explicitly permits anonymous access and CC BY 4.0 reuse.

Official dataset, semantics and access conditions: https://data.jrc.ec.europa.eu/dataset/afa8a5ee-5473-439a-b062-ffdaedc38b2d
Code: `src/lib/ingestion/adapters/edo.ts`; tests: `tests/unit/context-feeds.test.ts`.

### FCDO — activate 15 verified country mappings covering 145 destinations; exclude GB30 and block VA1

Use the primary agent's verified 15 HTTP-200 page probes. Preserve whole-country statuses only, current page validation, actual publication timestamps and two-hour checked validity. Regional Turkey/Kosovo advice must not become nationwide events. GB has no foreign-travel advice; VA's 404 does not justify substituting Italy silently. Schedule explicit supported mappings so excluded countries cannot become misleading checked successes or /undefined requests. Add 15-slug, GB/VA exclusion and regional-only fixtures.

Official schema: https://docs.publishing.service.gov.uk/content-schemas/travel_advice.html
Reuse policy: https://www.gov.uk/help/reuse-govuk-content
Code: `src/lib/ingestion/adapters/fcdo.ts`; tests: `tests/unit/context-feeds.test.ts`.

## Recommended boundary

Extend per-destination/provider eligibility, preserve existing roles and lifecycles, and collect each shared upstream feed once for both catalog projections. Do not build national-source adapters around these global feeds, promote modeled/context feeds into warning coverage, or increase request caps merely because the catalog grows.

## Validation and limitations

Performed read-only adapter/registry/test inspection, Python count and radius-envelope checks for all 176 candidates, and primary-source documentation/licence review. No tests were executed; no repository files were modified.

Bounded probes of both EONET URL orders were attempted. Local urllib requests failed because DNS was unavailable; the web tool could not open either API URL. Therefore no observed response difference is claimed. This is a documented parameter-order mismatch, not live empty-response proof.

Fresh raster sampling, new-country CEMS names, GFM temporal evidence and EONET live-response behavior remain unresolved gates. Existing tests establish parser behavior; they do not prove complete regional data availability. FCDO 15-page success/VA404/GB non-applicability evidence was supplied by the primary agent and was not independently re-probed in this pass.
