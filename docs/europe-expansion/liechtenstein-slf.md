# WORK-53 Liechtenstein / SLF independent review

Verdict: reuse the existing `slf-avalanche` source/provider for **li-malbun only** among the three candidate Liechtenstein destinations. Geography and source jurisdiction are supported. No new service identity, credentials or upstream request is needed. Activation still requires the small eligibility change, seasonal presentation checks and regression tests below.

## Authoritative scope, access and reuse

SLF explicitly covers Liechtenstein in its avalanche bulletin: https://www.slf.ch/en/services-and-products/avalanche-bulletin/ . It is mountain avalanche information, not a guarantee about controlled pistes, town safety or resort opening.

https://www.slf.ch/en/services-and-products/slf-data-service/ documents free CAAML and warning-region services and CC BY 4.0. Digital use requires visible attribution and a link to WSL Institute for Snow and Avalanche Research SLF. Requests must not overload the service. Joining its bulletin mailing list is recommended, not required for access; no registration is needed for the reviewed public endpoints. It asks providers to keep safety-relevant content accurate and current and requests a feedback-tool link. No requirement to embed the entire bulletin was identified on that page; the summary should link clearly to the official full bulletin.

Full bulletin/product context: https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/about-the-avalanche-bulletin/products/ . A danger number/icon is only an overview: the full bulletin contains danger descriptions and snowpack/weather information. Preserve the existing unsecured-terrain caveat and direct official bulletin link. Do not present our extracted rating as the complete bulletin.

## Concrete geography and live contract evidence

Candidate `li-malbun` is a resort at [9.60986,47.10139] with a 1 km radius. The official print-region index lists **3311 Liechtenstein**: https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/print-versions-avalanche-bulletin/ . Importantly, the actual CAAML region identifier is **CH-3311**, despite the destination country being LI. Never rewrite that provider identifier to LI-3311.

The documented existing endpoint is https://aws.slf.ch/api/bulletin/caaml/v4/en/geojson . Its API documentation at https://aws.slf.ch/api/bulletin/caaml documents the optional `activeAt` query and an empty FeatureCollection when no bulletin is active.

Bounded anonymous retrievals performed:

- Current endpoint: returned `{"type":"FeatureCollection","features":[]}`; retained at `tests/fixtures/europe-expansion/slf-current.json`. This is no active bulletin, not an observed low avalanche danger rating.
- Historical query using the documented parameter: https://aws.slf.ch/api/bulletin/caaml/v4/en/geojson?activeAt=2026-02-01T12%3A00%3A00Z . Returned 11 features, retained at `tests/fixtures/europe-expansion/slf-winter.json`.
- Winter feature id 8, bulletin `950832d0-b8be-4bd1-a20e-f0c1d2d22e9d`, includes region `{regionID:"CH-3311",name:"Liechtenstein"}`. Publication is 2026-02-01T07:00:00Z; validity 07:00–16:00Z that day; `mainValue:"moderate"`, `validTimePeriod:"all_day"`.
- Using installed Turf booleanIntersects and the same 24-vertex radius-ring formula as `locationPolygon`, the Malbun 1 km footprint intersects this winter feature. This is an actual source-polygon match, not a nearest-region inference. It establishes intersection, not containment of every point in the footprint within a standalone CH-3311 boundary.

Warning-region documentation https://aws.slf.ch/api/warningregion/ links its `swagger-ui-init.js`; inspected that documented script, which specifies the public path `/api/warningregion/warnregionDefinition/current/geojson`. No extra geometry data request was made because the winter bulletin already supplies a matching polygon and CH-3311 identity. A standalone region-boundary containment check can use that documented route if required for a fixed mapping artifact.

## Existing adapter and smallest change

`src/lib/ingestion/adapters/avalanche.ts:87` filters destinations to CH and mountain/resort/park. That is the concrete eligibility exclusion. The remaining matching path already intersects actual bulletin geometry against destination polygons; it does not require `sourceRegionCodes.slf` for matching.

Prefer extending eligibility to explicitly reviewed Malbun alongside existing Swiss targets (or a small reviewed eligibility set). Do not blindly include all LI towns. Keep the existing source ID, single fetch, 2 MiB response bound, cadence, source publication/validity timestamps and severity mapping. The observed winter moderate rating may legitimately produce no event under existing thresholds; a synthetic higher rating at the captured geometry can test severity behavior, clearly labelled synthetic.

## Timing and seasonal gate

Official timing: https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/about-the-avalanche-bulletin/publication-times-and-validity/ . Winter publication is normally 17:00 local, with conditional 08:00 updates and possible exceptional updates. Summer/autumn bulletins are conditional on snow conditions. Expire evidence at source validTime.endTime; neither polling cadence nor season extends validity.

`slfEvents` currently accepts an empty feature list as an ok result and marks all eligible destinations checked. Before claiming year-round coverage for Malbun, verify public wording distinguishes successful no-active-bulletin from a current assessed low rating. A valid unrated seasonal bulletin is a separate case: SLF parsing currently requires a danger rating, whereas the file's `seasonalBulletin` helper is only used by the other avalanche provider. Do not claim that SLF seasonal-format support is already proven by an empty current response. Preserve unavailable behavior for malformed products rather than inventing safe conditions.

## Required checks before activation

1. Captured winter geometry matches Malbun with the LI country code while distant LI city targets remain ineligible.
2. A clearly synthetic >=3 rating over that real geometry emits one correctly attributed Malbun event with unchanged validTime expiry; the real moderate fixture follows existing thresholds.
3. Exact expiry, replacement, malformed/partial response and no-active-bulletin behavior preserve source semantics.
4. Catalog/coverage policy enables only reviewed Malbun for SLF and projects legacy catalog 2 unchanged. Do not map CH-3311 by country-prefix assumptions.
5. Attribution links to SLF and the full bulletin; unsecured terrain and no-resort-opening inference remain visible.

Validation: official documentation review; two bounded unauthenticated data requests; documentation-script inspection; read-only candidate/adapter inspection; numeric Turf intersection check. No production tests or code changes. No activation performed. Standalone warning-region containment, summer unrated payload and final public seasonal wording remain unvalidated.
