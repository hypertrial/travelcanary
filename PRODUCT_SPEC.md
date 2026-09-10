# TravelCanary — Europe Location Risk

## Product Specification

- **Status:** MVP implementation specification; launch remains subject to the gates below
- **Audience:** People travelling to an EU country or Switzerland within the next 24 hours
- **Language:** English only
- **Vercel budget:** Base $20 monthly Pro platform fee only; no intentional on-demand spend, excluding taxes and the domain

## Product Promise

Local conditions are a separate destination-selected context product: forecasts, modeled air quality, reviewed nearby offshore forecasts, named-station observations, earthquake context, and official infrastructure incidents. Infrastructure can describe active or next-24-hour planned power, water, telecom, rail, and road disruption plus explicit national electricity-use advisories. It is capped, factual, source-attributed, and never treated as proof that services are operating normally. These products never alter risk scores, map markers, coverage gaps, delayed warning hazards, global alert health, or alert counts. Quiet destinations remain searchable without reassuring green markers. Conditions unavailability is local to the selected panel.

Public alerts remain Snapshot V10/catalog 2 (503 IDs). Conditions V2 uses separate precomputed country files, retrieved only after selection from the approved public Blob origin. `infrastructureIncidents`, `systemConditions`, and sanitized source health are context-only; resolved incidents are omitted and healthy-empty sources do not create an all-clear. Hourly details start collapsed; observation time, forecast retrieval time, individual source links and limitations remain visible. Missing values remain missing. Forecast issue times are not fabricated from API processing duration.

A failed conditions download offers “Retry local conditions” within the destination briefing. Retry affects only that country file, disables duplicate submission while pending, and does not reload alerts or navigate away. Switching destinations resets the briefing's scroll and disclosures so the new risk and action guidance appear first.

TravelCanary operates noncommercially: no advertising, subscription or other use prohibited by selected free services. Any monetization requires disabling noncommercial data paths and a new license review. Source activation outcomes and unfinished gates are recorded in [the source review](docs/KEYLESS_SOURCE_REVIEW.md).

TravelCanary, at `travelcanary.org`, answers one question:

> Is there a major, active, source-backed hazard that could affect this place now or within the next 24 hours?

It presents the answer on a fast, simple map for people who are not hazard experts.

Travel Canary does not guarantee that a place is safe. A normal result means that no major alert was found in the sources and hazard types currently monitored. It does not mean that no danger exists.

## Target User and Use Case

The primary user is travelling to a place in the covered area within 24 hours. They want to know whether to continue normally, pay attention, reconsider part of their plan, or follow emergency instructions.

The MVP must not require an account, location permission, or knowledge of local warning systems. Users find a place using search or by selecting it on the map.

## Geographic Scope

The MVP covers:

- All [27 European Union countries](https://european-union.europa.eu/principles-countries-history/facts-and-figures-european-union_en)
- Switzerland
- 400–600 curated locations

The curated catalog includes:

- Every national capital
- Major cities and regional centers
- High-traffic islands and resort areas
- Major national parks

Catalog version 2 contains 503 destinations. Ponta Delgada, Horta, and Santa Cruz das Flores represent the Azores eastern, central, and western island groups with reviewed timezone, coastal, MeteoAlarm, air-quality, alias, and provenance metadata.
- Major mountain regions
- Major coastal and tourist destinations

The location list is maintained in source control and is not generated from user searches. Each location contains:

```text
id
display name
search aliases
country code
location type
centroid
boundary or matching radius
timezone
source-specific region codes
```

Use an official boundary where one is available. Otherwise use these default matching areas:

- City: 15 km from the city center
- Resort or coastal destination: 25 km
- Island, park, or mountain region: a curated polygon

The final catalog requires product-owner review before launch. Coverage should favor visitor relevance rather than equal location counts per country.

## Public Risk Levels

The UI uses plain-language labels. Internal enum names may appear only in data and code.

| Internal state | Public label | Meaning | Suggested action |
| --- | --- | --- | --- |
| `NORMAL` | No major alert found | No supported hazard active now or expected within 24 hours was found in checked sources nearby | Continue normally and follow local advice |
| `ELEVATED` | Be aware | A limited or developing hazard may affect the place | Read the alert and monitor updates |
| `HIGH` | Consider changing plans | A serious hazard affects part or all of the place | Avoid the affected area if possible |
| `SEVERE` | Emergency conditions | An immediate or extreme hazard is active or expected within the travel window | Follow official instructions |
| `UNKNOWN` | Updates delayed | Current information could not be confirmed | Check official local sources |

`UNKNOWN` is a data-health state, not a risk level. An unavailable required source must never cause a location to become `NORMAL`.

No public numeric score is shown. Internally, levels are ordered as:

```text
NORMAL < ELEVATED < HIGH < SEVERE
```

Determine the location's displayed state in this order:

1. Calculate the highest active or upcoming hazard level.
2. If that level is non-normal, display it even when another source is delayed, and add the applicable data-health warning.
3. If no non-normal hazard is known and the snapshot is critically stale or a required source is delayed, display `UNKNOWN`.
4. Otherwise display `NORMAL`; destination details must still distinguish fully checked, partly checked, and not-checked hazards.

Never replace a known `HIGH` or `SEVERE` hazard with `UNKNOWN`. Data uncertainty supplements known risk rather than hiding it.

Each hazard also has a timing state:

```text
ACTIVE | UPCOMING
```

An `UPCOMING` hazard starts within the next 24 hours. Its headline and public label use future wording such as “Severe conditions expected” rather than implying that the event is already active.

## Supported Hazards

This is the product's hazard taxonomy, not a claim that every category has complete coverage at launch. The versioned country-by-hazard coverage matrix, location overrides, provider registry, and current public provider health jointly determine coverage for a destination. Each applicable traveler-facing category retains one internal presentation state: `available`, `limited`, `delayed`, or `not_monitored`. The browser labels these states “Fully checked,” “Partly checked,” “Update delayed,” and “Not checked.” Non-applicable categories, such as avalanche coverage for a city without an explicit override, are omitted.

Risk result, source freshness, and monitoring coverage are separate. `NORMAL` means no qualifying alert was found in checked sources; it is never a destination-wide safety claim. A known alert remains visible even if broader monitoring is partial or an update is delayed. Static limitations do not change map markers, while genuinely delayed or unavailable required data continues to use the existing `UNKNOWN` behavior.

The compact public snapshot may group the weather family under `severe-weather` when flood, heat/cold, snow/ice, avalanche, and coastal warnings all have the same incomplete status. The detailed coverage matrix remains authoritative; grouping is a display/transfer optimization and must not imply complete subtype coverage.

Volcanic activity is applicable only when the reviewed offline artifact places destination geometry within 200 km of a Smithsonian Global Volcanism Program Holocene volcano, a reviewed civil-protection override applies, or a current published volcano incident affects the destination. Long-range aviation ash disruption is outside this destination-level model. The generated artifact records the source version, review date, contributing volcano identifiers, and minimum distance; generation and validation make no runtime request.

### Natural

- Severe weather
- Flooding
- Extreme heat and cold
- Wildfire activity and fire danger
- Air quality
- Earthquakes
- Snow and ice
- Avalanche
- Coastal hazards

### Human-caused

- Violent civil unrest
- Major security incidents
- Terror attacks
- Armed conflict
- Industrial and chemical emergencies
- Nuclear and radiological emergencies
- Major civil emergencies

### Excluded

- Transport delays, cancellations, and strikes
- Routine or peaceful protests
- Routine or local crime
- Historical crime rankings
- Long-term climate or safety rankings
- Health outbreaks
- Unverified social-media reports
- Events outside the current 24-hour travel window

## Evidence and Publication Rules

Every non-normal Snapshot V10 incident must contain the authoritative primary hazard fields below plus one to five distinct evidence records. Each evidence record carries provider, source name, direct URL, source update/check times, and confidence.

- Hazard type
- Public risk level
- Headline
- Plain-English explanation
- Suggested action
- Affected geometry or radius in the internal normalized event, plus a plain-English affected-area label in the public snapshot
- Start and end time
- Source update time
- Travel Canary check time
- Expiry time
- Source name and direct link
- Confidence: `HIGH` or `MEDIUM`; `LOW` confidence candidates remain internal

Publication is fully automatic. There is no manual moderation queue.

### Official information

An active warning from an approved official authority may publish immediately. Its source severity is mapped through a reviewed, source-specific table.

### News-derived information

GDELT is a discovery source, not an authority. A news-derived event may affect risk only when all of these rules pass:

1. At least three approved, editorially independent publishers report the same hazard.
2. Reports refer to the same hazard type, fall within 25 km, and have structured event times within two hours. If event time is unavailable, publication times may be used and the result remains preliminary.
3. Reports were published within the previous six hours.
4. Duplicate syndication and materially identical wire copy count as one report.
5. No report is framed as historical, hypothetical, planned, routine, resolved, or denied.
6. The event matches an included hazard and is expected to affect the next 24 hours.

Approved publishers are maintained as versioned configuration with their domains and parent ownership groups. Reports from domains under the same parent group count as one publisher. Changes to this list require review and test fixtures. Duplicate detection uses canonical URLs and normalized headline fingerprints, plus description fingerprints when descriptions are available. If the available fields cannot distinguish syndicated copies, the reports do not satisfy corroboration.

A news-only event:

- Has `MEDIUM` confidence
- Is capped at `ELEVATED`
- Uses the wording “Multiple reports indicate…”
- Expires after six hours unless new corroboration arrives
- Can never produce `HIGH` or `SEVERE` without an approved official source

A single report or failed corroboration remains internal and never changes the map.

The MVP uses deterministic rules and fixed English templates. It does not use a paid or generative-AI service to classify, translate, score, or explain events.

GDELT runs hourly behind `GDELT_ENABLED=true`. Publisher text and images are used only transiently for fixed exclusions and fingerprints; they are never persisted or published. A single or uncorroborated report remains a bounded private candidate. Three independently owned reviewed publisher groups are required; once corroborated, the group emits one event per distinct publisher so Snapshot V10 presents one incident with multiple evidence links. The adapter first makes one combined fixed-vocabulary PointData request; only a failed combined request triggers two bounded query shards. One successful shard is partial, three 512 KB responses and 1 MB consumed bytes are hard limits, and GDELT health is non-blocking and never satisfies coverage.

## Initial Source Plan

No paid data API is permitted. “Free to view” is not sufficient: every enabled source must be machine-readable, suitable for scheduled server-side retrieval, and approved for the specific data that Travel Canary republishes. A free registration or token is allowed and must be stored as a server-only Vercel secret.

The access, credential, and licensing facts below were last reviewed on 2026-09-01. Recheck them before enabling an adapter and at least quarterly because provider terms and interfaces can change.

| Source | Use and retrieval | Cost and credentials | Reuse and launch constraint | Target check |
| --- | --- | --- | --- | --- |
| [MeteoAlarm](https://feeds.meteoalarm.org/) | Weather, flood, heat, cold, snow, avalanche, coastal and some fire warnings through all 28 actively maintained country Atom/CAP feeds. Legacy RSS feeds stopped updating on 2026-01-14. The EDR API remains an optional future transport replacement. | The enabled Atom feeds have no usage fee and require no API key. EDR warning-location queries and MQTT require a free token, but the MVP does not use them. | Data is CC BY 4.0. Preserve attribution, CAP severity, issue time, and expiry. Use the published country Atom directory; do not depend on a retired RSS or undocumented aggregate endpoint. Reject a country feed whose update time is missing, more than two hours old, or more than five minutes ahead; retain unexpired evidence for that failed partition. | Every 10 minutes |
| [EFFIS](https://forest-fire.emergency.copernicus.eu/downloads-instructions) | Fire danger plus current `effis.nrt.ba.poly` perimeters around fresh detections. | No usage fee or API key for the public WMS/WFS layers; perimeters require `EFFIS_PERIMETERS_ENABLED=true`. | A valid current perimeter paired with a detection no older than 12 hours may publish `HIGH`; otherwise the existing hotspot remains `ELEVATED`. | Hourly |
| [EFFIS active fire](https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation/) and [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/) | Keyless EFFIS candidate discovery/confirmation merged with optional NOAA-20/NOAA-21 VIIRS and MODIS FIRMS hotspots. | No required credential; an optional free `FIRMS_MAP_KEY` supplements EFFIS. | A hotspot is complementary evidence, not a confirmed perimeter or evacuation area, and is capped at `ELEVATED`. | Hourly |
| [EEA European AQI](https://airindex.eea.europa.eu/AQI/index.html) | Official categories from the keyless AQMobile ImageServer at 498 reviewed destinations. | No usage fee or API key. | Uses official categories 1–6 without recalculating the index. Missing pixels degrade only affected eligible destinations. The three Azores and two Canary destinations are explicitly not monitored until reviewed official observation contracts are approved. | Hourly |
| [USGS Earthquake Feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) | Earthquakes through GeoJSON summary and detail feeds. | No usage fee or API key. | Use the published application feeds and lifecycle policy. Prefer local ShakeMap intensity over magnitude or PAGER alone. Reject a summary whose generated time is more than 30 minutes old or more than five minutes ahead; retain unexpired earthquake evidence when the refresh fails. | Every 10 minutes |
| [Copernicus EMS Rapid Mapping](https://mapping.emergency.copernicus.eu/about/how-to-harvest-cems-mapping-data/emergency-response-data/) | Major emergency discovery and affected areas through the public activation JSON API. | No usage fee or API key for public activations. | Public information is open and free of charge with required Copernicus attribution, although exceptional product restrictions may apply. An activation is context, not automatically a public warning. | Every 10 minutes |
| [EMSC FDSN](https://www.seismicportal.eu/fdsn-wsevent.html) | Preliminary fallback for European earthquakes not matched to USGS evidence. | No usage fee or API key. | CC BY 4.0 with attribution. EMSC is capped at `ELEVATED` and cannot replace or downgrade USGS ShakeMap evidence. | Every 10 minutes |
| [GDACS API](https://www.gdacs.org/Documents/2025/GDACS_API_quickstart_v2.pdf) | Disaster discovery metadata used to route independent official or satellite checks. | No usage fee or API key. | Discovery-only. GDACS never publishes a hazard, changes risk, or satisfies coverage by itself. Store only bounded structured metadata. | Every 10 minutes |
| [Vigicrues](https://www.vigicrues.gouv.fr/territoire/rss) | Official French river-section flood vigilance through bounded RSS; destination intersections are generated offline. | No usage fee or API key. | Open Licence 2.0. Only destinations intersecting official section geometry receive coverage. | Every 10 minutes |
| [FOEN](https://opendata.swiss/en/dataset/hochwasserwarnkarte) | Official Swiss national flood-warning palette sampled from one WMS TIFF. | No usage fee or API key. | Accept only exact documented palette colors, fail closed when the palette cannot be validated, and use a 90-minute rolling expiry so hourly checks do not create a false-normal gap. | Hourly |
| [eHYD / Hydrographie Österreich](https://ehyd.gv.at/) | Official Austrian flood-warning stages from the keyless OGC API Features `pegel_aktuell` collection; destination intersections are generated offline. | No usage fee or API key. | Open Government Data Austria CC BY 4.0. Score only documented `gesamtcode` flood stages (HW1–HW3). Raw centimetres are never scored. Coverage stays limited to mapped Austrian destinations. | Hourly |
| [Copernicus GFM](https://extwiki.eodc.eu/GFM/PUM/DataAccess/WMS-T) and GloFAS | Observed-flood corroboration targeted by GDACS plus the keyless GloFAS days-1–3 summary. | Public services with no API key; gated independently by `GFM_ENABLED` and `GLOFAS_TARGETING_ENABLED`. | GloFAS publishes nothing directly. Current GFM pixels are still required; evidence is `ELEVATED`, non-covering, and bounded to 12 targets/9 MB. | Every two hours when enabled |
| [NASA EONET](https://eonet.gsfc.nasa.gov/docs/v3) | Current wildfire and volcano context within the catalog envelope. | No usage fee or key; gated with the context group. | Valid geometry and a geometry time within 72 hours are required. Evidence is `ELEVATED`, `MEDIUM` confidence, and non-covering. | Hourly when enabled |
| [Copernicus EDO](https://drought.emergency.copernicus.eu/data/wcs-service) | Exact-date `cdiad` agricultural/ecosystem drought raster. | No usage fee or key; gated with the context group. | Only CDI class 3 creates `ELEVATED` context; products older than 25 days fail closed. | Daily when enabled |
| [GOV.UK FCDO travel advice](https://www.gov.uk/foreign-travel-advice) | Whole-country machine-readable travel-advice statuses for the 28 catalog countries. | No usage fee or key; gated with the context group. | Only whole-country avoid-all or avoid-all-but-essential statuses score. Partial-country prose is ignored. | Hourly when enabled |
| [SLF](https://www.slf.ch/en/services-and-products/slf-data-service/) and [Avalanche.report](https://oc.avalanche.report/more/open-data) | Official avalanche bulletins matched by supplied SLF geometry or reviewed EAWS region intersections. | No usage fee or API key. | CC BY 4.0 bulletin data; EAWS region geometry is CC0. A destination is monitored only after a real geometry intersection. | Hourly |
| National public-warning systems | Source-controlled audit for all 27 EU countries and Switzerland; AT, CZ, DE, ES, FR, IT, LU, LV, PL, and SE are active. | Active transports are keyless; approved free credentials may be configured server-side for credential-gated systems. | Every system records a review date and bounded official evidence links. CHMI uses exact generated RÚIAN ORP intersections plus independent station evidence. IMGW retains reviewed partial station/bulletin matching because no stable documented exact warning geometry contract passed review. Measurements cap at `HIGH`; only structured official degrees reach `SEVERE`. Italy contributes partial flood coverage from exact warning zones, not IT-alert. Other national integrations retain explicit gates; FI, IE, PT, ES, and HR provide failure-only weather fallback without additional coverage credit. | Adapter every 10 minutes; individual transport cadence and readiness come from manifest V3 |
| [GDELT GEO 2.0](https://www.gdeltproject.org/) | Fixed-bucket human-event discovery with explicit point geography. | No usage fee or API key; gated by `GDELT_ENABLED`. | Requires three reviewed parent groups; stores only hashes, ownership metadata, and canonical links; fixed copy is capped at `ELEVATED`. | Hourly when enabled |

BBK MoWaS and EURDEP remain absent. National manifest V3 gives every reviewed public-warning system an explicit coverage, fallback, context, credential-gated, evidence-gated, or blocked outcome. Ten national partitions are active: Austria, Czechia, Germany, Spain, France, Italy, Luxembourg, Latvia, Poland, and Sweden. Italy contributes partial flood coverage only. FMI, Met Éireann, IPMA, AEMET, and DHMZ are failure-only MeteoAlarm fallbacks and never add coverage.

[OpenFreeMap](https://openfreemap.org/) is also free and currently requires no account or API key. It is a basemap provider, not a hazard source. Retain required OpenFreeMap/OpenStreetMap attribution and keep search, text results, and location details usable if its donation-funded public service is unavailable.

AirNow is intentionally not used for EU/Swiss scoring. Its core official coverage is the United States, Canada, and Mexico, international observations are sparse, and its US AQI categories are not interchangeable with the European AQI already supplied by EEA.

Before an adapter is enabled in production, it must pass a source-readiness review covering:

- Coverage of the EU and Switzerland
- Authentication, registration approval, and rate limits
- License, attribution, publisher rights, and redistribution rights for every field stored or shown
- Stable event identifiers
- English or structured fields sufficient for English templates
- Geometry quality
- Update cadence
- Cancellation and expiry behavior
- Known false positives and missing-data behavior

If a hazard lacks an approved source, the product must identify it as not currently monitored. It must not imply normal conditions for that hazard.

## Source-to-Risk Mapping

Mappings are versioned configuration reviewed before release. No adapter invents severity from free text when structured severity exists.

### MeteoAlarm

| MeteoAlarm awareness level | Travel Canary level |
| --- | --- |
| Green or no active warning | `NORMAL` |
| Yellow / moderate | `ELEVATED` |
| Orange / severe | `HIGH` |
| Red / extreme | `SEVERE` |

Only an active warning, or a warning that starts within the next 24 hours, whose explicitly identified warning region matches a curated location can change that location. Atom feeds currently mix provider-specific `EMMA_ID`, current NUTS, and legacy NUTS identifiers. The MVP may use reviewed exact identifiers and normalized feed area labels compared with catalog place/administrative labels; conservative label-prefix matching is limited to cities, capitals, and resorts. It never treats a regional warning as country-wide merely because its code is unknown.

Core MeteoAlarm weather coverage is generated from the source-controlled country capability audit. Every catalog destination now has an exact provider/NUTS identifier verified against Eurostat GISCO NUTS 2024 geometry; normalized area labels remain a conservative secondary matcher. Flood, wildfire, avalanche, and coastal coverage stays partial because a weather-warning feed is not complete hazard detection. EFFIS/FIRMS hotspots and perimeters remain corroborating satellite context. Only exact, reviewed national warning codes may produce authoritative wildfire evidence; generic fire categories are ignored. Successful feed parsing or a nonzero event count alone is not sufficient evidence of geographic coverage.

### Air quality

Use the EEA European Air Quality Index without recalculating pollutant thresholds.

| EEA category | Travel Canary level |
| --- | --- |
| Good, fair, or moderate | `NORMAL` |
| Poor | `ELEVATED` |
| Very poor | `HIGH` |
| Extremely poor | `SEVERE` |

Query the official EEA European AQI layer at its documented three-hour reporting lag using one to three curated land sampling points per destination. Use the worst valid official category, publish it with `MEDIUM` confidence, and expire it six hours after the source validity time. A missing sample creates a limitation only for that destination and cannot establish a normal air-quality result.

### Earthquakes

Use [USGS ShakeMap](https://earthquake.usgs.gov/data/shakemap/) intensity at each curated location when available. The USGS describes intensity as the local effect of shaking, whereas PAGER estimates overall event impact. PAGER may raise event confidence and processing priority but does not determine a location's level by itself.

| ShakeMap intensity at the location | Travel Canary level |
| --- | --- |
| Below MMI IV | `NORMAL` |
| MMI IV–V | `ELEVATED` |
| MMI VI–VII | `HIGH` |
| MMI VIII or above | `SEVERE` |

The USGS identifies MMI VI or greater as damaging shaking. Magnitude alone may create only an `ELEVATED` preliminary event. It may not create `HIGH` or `SEVERE` without local ShakeMap intensity or an approved official warning.

A preliminary earthquake is shown only when:

- Magnitude is at least 4.5 and the epicenter is within 100 km, or
- Magnitude is at least 5.5 and the epicenter is within 250 km

Preliminary earthquake events expire after six hours unless an impact product or official update extends them.

### Wildfire

The implemented MVP uses EFFIS fire danger, official warnings/Copernicus context, deduplicated EFFIS/FIRMS thermal hotspots, and optionally verified current EFFIS perimeters. Perimeters require valid polygon geometry, a current time slice, a paired detection no older than 12 hours, and intersection with the destination or its 25 km buffer.

- Very high or extreme fire danger: `ELEVATED` for parks, mountain regions, resort areas, islands, and other outdoor destinations; it does not change a city by itself
- One high-confidence satellite hotspot within 25 km: at most `ELEVATED`
- An active-fire perimeter intersecting the location or within 25 km: `HIGH`
- An approved official wildfire warning affecting the location: use the official severity mapping, capped at `HIGH` unless it includes emergency or evacuation instructions
- An approved official evacuation or emergency warning: `SEVERE`

An isolated satellite hotspot never produces `HIGH` or `SEVERE`.
Active-fire evidence expires 12 hours after acquisition and is published as `MEDIUM` confidence. FIRMS requires high VIIRS confidence or MODIS confidence of at least 80; EFFIS candidates require feature confirmation. One transport failure is partial, while EFFIS alone remains healthy when FIRMS is not configured.

### Copernicus EMS

An open Rapid Mapping activation may create an internal candidate event. It can publish at `ELEVATED` only when its event time, category, and affected area are current and relevant. Higher levels require an approved official warning.

### Human-caused events

News-only events follow the corroboration rules above and are capped at `ELEVATED`. `HIGH` and `SEVERE` require an approved government, police, civil-protection, or emergency-service source.

### Nuclear and radiological events

Radiological measurements alone never change risk. This hazard remains marked as not monitored except where an enabled national public-warning feed supplies an official nuclear alert with reusable geometry, severity, and lifecycle data.

## Time and Expiry Rules

Derive effective event times before evaluating relevance:

- `effectiveStartsAt`: source start time, otherwise the source event or publication time
- `effectiveEndsAt`: source end or expiry time, otherwise `effectiveStartsAt` plus the adapter default

Reject an event when `effectiveEndsAt` is not after `effectiveStartsAt`. An event with no trustworthy start, event, or publication time remains internal. An event is relevant when:

```text
effectiveStartsAt < now + 24 hours
AND
effectiveEndsAt > now
```

Use source-provided start, end, cancellation, and expiry values whenever present.

If a source supplies no expiry, use the adapter default:

| Event type | Default expiry |
| --- | --- |
| News-derived human event | 6 hours |
| Preliminary earthquake | 6 hours |
| Active-fire hotspot | 12 hours |
| Air-quality observation or forecast | 6 hours, never beyond its stated valid time |
| Copernicus activation candidate | 24 hours |

Expiry removes the event automatically. News coverage continuing after an official cancellation does not reactivate the event.

## Geospatial Matching

Normalize all coordinates to WGS84.

Match polygon hazards by geometric intersection with the curated location boundary. Match point hazards by the source-specific impact radius, not by country alone.

One source event may affect multiple locations. One location may contain multiple hazards. Deduplicate events using the source event identifier; where none exists, use a stable fingerprint of source, hazard type, time bucket, and geometry.

Country-wide warnings affect a location only when the source explicitly describes country-wide applicability. A country ISO geocode alone is not country-wide applicability.

## Layperson-First Experience

### Visual direction

The interface keeps the European field-guide style: warm paper and ivory surfaces remain the calm base, while navy and canary gold identify TravelCanary. Risk colors remain reserved for semantic status. The public lockup spells TravelCanary beside the pin-and-canary mark and carries a persistent `ALPHA · PREVIEW` label; the header uses a compressed PNG of that mark, and the favicon and Open Graph image are App Router metadata files. Controls and body copy use the native system UI stack without a font download. Newsreader 600 is the editorial face for destination names, alert headlines, and major empty states; its Latin and Latin Extended subsets are self-hosted by `next/font`, are not preloaded, and are requested only after an editorial heading becomes visible.

Risk is never communicated by color alone. Every level combines a reviewed public label with a symbol. Motion is brief and functional, and all transitions respect reduced-motion preferences.

### Main map

At 1024 pixels and above, the application is a desktop workspace with a persistent independently scrollable control rail and an unobscured map pane. The rail is 344 pixels through the overlay-detail range and 368 pixels at 1360 pixels and above. It uses section hierarchy rather than stacked floating cards: brand, single-line freshness, search, three visible count-aligned map filters, a secondary all-destinations action, and a stable attention footer. Short viewports scroll the whole rail instead of pinning content over controls. At 1360 pixels and above an open 424-pixel destination briefing becomes a third column; between 1024 and 1359 pixels it is a bounded right overlay and only that temporary overlay contributes camera padding. Map controls and attribution belong to the map pane.

Desktop freshness is one atomic visible phrase such as `Live · 5 min ago`, `Delayed · 5 min ago`, or the space-safe `Unavailable`; it never breaks the status and age across lines. Its accessible label remains the complete “Live updates unavailable” sentence. Short labels, filter names, and numeric counts do not wrap. Headings balance and descriptive text wraps naturally; destination names may use two intentional lines in search and attention results without breaking words.

The opening camera fits the reviewed core-Europe bounds `[-12, 34]` to `[35, 72]`, currently 496 destinations. Seven Atlantic-island destinations remain searchable and appear through **Show all 503 destinations**; the UI derives that outer count and highlights active outer alerts. Home returns to core Europe. The map has no pan bounds, keeps `renderWorldCopies` off, and preserves manual navigation across filters, data updates, layout changes, and mobile tabs. Selecting a destination saves center, zoom, and camera mode once; switching destinations retains that return camera and closing details restores it with current layout padding.

Visible alert destinations use native MapLibre GeoJSON clusters through zoom level 6. Clusters show both destination count and strongest contained severity, expand on activation, and never change destination-level filter counts. The selected destination uses a separate unclustered source. Custom 44-pixel zoom controls move by 0.75 levels over 220 ms around the visible map center, stop at zoom 1.8/12, and use zero-duration transitions when reduced motion is requested. Native wheel, double-click, and pinch behavior remains available.

The hosted OpenFreeMap Positron style retains its tiles, glyphs, sprites, and attribution while guarded paint overrides cool uncovered land and warm only an explicit allowlist of existing park, water, road, boundary, and label layers. A same-origin GeoJSON fill tints the 28 covered countries in the field-guide cream; a failed or missing coverage overlay leaves the map available with uniform land. Missing or renamed cosmetic layers are ignored and can never make the map unavailable.

The desktop attention footer separates its total from the strongest traveler action, such as `95 need attention` and `3 may need plan changes`, and opens the same ordered destination groups. Mobile exposes those groups in a full Alerts view. Emergency conditions, Consider changing plans, Be aware, and Updates unavailable retain accessible risk names and destination counts. When a snapshot is missing, the experience explains the outage instead of listing all 503 places; search still opens any briefing. The app menu contains the map key, installation guidance, product limits, and About content.

The default All alerts map shows `ELEVATED` (Be aware), `HIGH`, and `SEVERE` destinations without changing risk scoring or evidence/coverage distinctions. The High & Severe filter shows only the latter two levels; Updates unavailable separately shows `UNKNOWN`. On desktop these are three full-width rows in one quiet group, with labels left and tabular counts right; on mobile they remain in the compact filter sheet. Counts refer to destinations across the full catalog, not incidents or the current viewport, and use the same aged snapshot as the map. Filters are mutually exclusive and keyboard-accessible. Quiet `NORMAL` destinations remain searchable without reassuring green markers. A selected destination always appears regardless of filter, gains a halo and label, and does not change filter counts. Search and Alerts are keyboard-accessible alternatives to clusters and the map canvas. Every state uses an icon or text as well as color.

Empty filters explain their result in checked sources. When High & Severe is empty but elevated destinations exist, show “No High or Severe alerts found in checked sources.” and a “Show N Be aware destinations” action that switches to All alerts. A genuine zero-alert snapshot says “No alerts found in checked sources. Monitoring may be incomplete.” Unavailable destinations have a separate recovery action. Missing/loading data shows unavailable counts (not zero), disables filters, and retains the existing data-health notice. These browser-only filters do not change ingestion, scoring, coverage, provider roles, or serialized snapshots.

The MVP does not request browser geolocation.

Below 768 pixels, a safe-area-aware app bar, one compact search control, one compact filter control, and fixed Map/Alerts navigation replace stacked floating cards. The Alerts navigation badge and heading reflect the active filter, so update-unavailable destinations are not presented as current alerts. The map stays mounted while Alerts is active so its camera survives tab changes. Search opens as a full-height overlay. Normal briefings open at roughly 44dvh; alert briefings use a roughly 52dvh peek so the immediate action remains visible. Both expand to roughly 92dvh, track pointer movement while dragged, snap at the documented thresholds, support explicit controls, and become full height on short landscape screens. The modal map is non-interactive, focus is trapped, and closing restores the originating control. Tile failure routes mobile to the searchable text directory with retry while desktop replaces the map pane in place.

Validated URL state uses `destination=<catalog-id>`, `view=map|alerts`, and `filter=all|high|unavailable`. Defaults are omitted. Destination selection pushes history; tab and filter changes replace the entry; Back/Forward restores state; invalid values are removed after catalog validation. Deep links open the requested view and briefing without modifying risk data.

The App Router manifest installs TravelCanary as a light standalone home-screen web app with regular and maskable icons, an Apple touch icon, navy theme color, warm background, and safe-area viewport behavior. Installation guidance is suppressed in standalone mode and dismissed locally with one versioned flag. There is deliberately no service worker, offline cache, push, background sync, notification permission, geolocation, analytics, account, favorite, or dark mode. Online/offline changes show a banner and retain already loaded timestamps; cold offline launch is unsupported.

### Search

Search runs in the browser over the curated location catalog. It matches display names, English names, common aliases, and country names. Results show the place name, country, and location type.

The field is labeled “Where are you going?” Search normalizes case, whitespace, punctuation, and diacritics. Exact name or alias matches rank first, then prefixes, substrings, country matches, and location-type matches. Results also include the current public status symbol and label. Normal results use a neutral search icon and the visible label “No major alert found”; their accessible description adds “in checked sources.” An empty field shows guidance rather than an arbitrary slice of the catalog.

On compact screens, recovery notices remain visually separate from the search control. Closing a destination sheet selected through search restores focus to the search field so keyboard and assistive-technology users can immediately check another place.

Search never calls an upstream hazard API.

### Location panel

The selected surface is a destination-first travel briefing. Its first screen answers, in order:

1. What is happening?
2. How serious is it?
3. When and where will it matter?
4. What should I do?
5. Where did the information come from?

The selected-place header shows destination, country, location type, public status, timing, and a short trip-impact sentence. Public alert headlines use destination-first language such as “Severe weather is affecting Angers” without changing the stored source evidence. The highest hazard appears first, followed by its suggested action, explanation, affected-area and local-time fact cards, short evidence label, last-checked time, and official source.

One location-specific summary titled “What TravelCanary checks for [place]” follows all hazard cards. It shows source freshness, monitoring counts, and compact chips for current update problems and permanent gaps. Local conditions follow that summary; detailed monitoring sections come afterward so a normal briefing reaches useful conditions without hiding its limitations. The details keep nine compact groups: Weather; Flooding and coastal hazards; Wildfire and fire danger; Earthquakes and volcanic activity; Drought context; Avalanches where applicable; Air quality; Major emergencies; and Security and conflict. Each group exposes the status of every applicable hazard subcheck so a mixed group cannot hide which member is incomplete.

The panel presents source freshness and monitoring coverage as separate summaries. “Update problems” appears only when a normally used coverage transport is late. “Monitoring gaps” immediately shows partly checked and not-checked categories plus one muted, non-counted “National system not connected” row where appropriate. “Fully checked” and “Additional context sources” are collapsed by default. Sanitized transport roles, individual update times, limitations, official links, and source-specific health remain available. Fallback, discovery, and other non-covering sources remain outside coverage counts. Fallback health cannot degrade a healthy authoritative source. Unknown briefings lead with official-source guidance before the same panel.

If map tiles fail, the map stage becomes a text-first fallback containing an explanation and a scrollable, status-labelled destination directory. Search, attention results, and destination details remain usable.

Example:

```text
BUDAPEST, HUNGARY

CONSIDER CHANGING PLANS

Severe thunderstorms may affect Budapest until 21:00.

What to do
Avoid exposed outdoor areas and check local authority advice.

Affected area
Budapest and nearby areas

Starts in 2 hours · Ends at 21:00
Last checked 4 minutes ago
Evidence: Official warning
Source: MeteoAlarm ↗
```

If several hazards are active, show the highest one first and list the rest below it. Do not lead with normal hazard categories when a serious hazard is active.

Show confidence in plain language: `HIGH` confidence becomes “Official warning” or “Confirmed by official source.” `MEDIUM` confidence uses a source-specific label such as “Multiple independent reports” or “Preliminary official information.” Do not show the internal confidence enum without an explanation.

Show event times in the selected destination's local timezone, not the user's device timezone. Include a day label such as “today” or “tomorrow” when an event crosses midnight or starts on a different local date. Deterministic demo data derives these labels from the demo snapshot time so preview examples do not change as fixtures age.

For a normal location, the status badge says:

> No major alert found in checked sources

Follow it once with context rather than restating the status:

> Review source freshness and monitoring gaps for Budapest below.

The coverage panel follows immediately and makes every limitation visible without repeating the result in a second empty-state card. Unknown locations similarly show `Updates unavailable` once, followed by the action “Check official local sources before relying on this result.”

For unknown or incomplete coverage, name the affected source or hazard rather than showing a generic error.

## Explanations and Suggested Actions

Use structured source instructions when they are available in English. Otherwise use short, reviewed English templates by hazard and risk level.

Suggested actions must be calm and specific. They must not:

- Claim that a place is safe
- Replace emergency-service instructions
- Diagnose injuries or provide medical treatment
- Invent evacuation instructions
- Exaggerate a preliminary or news-only event

Every location panel includes a direct link to the original source. The linked source may be in a local language even though the TravelCanary UI is English-only.

## Data Health and Failure Behavior

Each adapter records:

- Last attempt
- Last success
- Last valid source timestamp
- Item count
- Parse or validation error
- Consecutive failures
- Next expected update

On a failed source request:

1. Retry twice with a short bounded delay.
2. Keep the last valid events until their individual expiry.
3. Do not publish a structurally incomplete or invalid snapshot; represent unavailable coverage explicitly instead of omitting it.
4. Mark that hazard's coverage as delayed after two missed expected updates.

For aggregate sources that return a mixture of successful and failed detail records, publish a `partial` operational result: merge newly confirmed events with unexpired prior evidence, count the refresh as incomplete for health tracking, and never replace the source wholesale with the partial subset. CEMS stops scheduling new activation details after 45 seconds so completed evidence can still be validated and published inside the fast route's 60-second limit.

A required source is an enabled authoritative or complementary source expected to cover that location and hazard in the versioned coverage matrix. When a required source is delayed without a healthy equivalent, affected locations cannot be presented as fully normal. Complementary Copernicus EMS Rapid Mapping incompleteness does not delay global snapshot health or unrelated destinations; retained Rapid Mapping events still publish. Fallback failures do not degrade a healthy authoritative source, and discovery or disabled providers never satisfy monitoring. The UI shows which hazard information is delayed.

If the complete published snapshot is more than 30 minutes old, show a global “Updates delayed” banner. If it is more than two hours old, show `UNKNOWN` instead of `NORMAL` for locations without a known non-normal hazard, preserve unexpired known hazards, and direct users to official sources. Treat a snapshot generated more than five minutes in the future the same as a critically stale snapshot so clock-corrupted data cannot appear current or prevent a later valid refresh.

The application always serves the last valid snapshot when ingestion fails.

## Architecture

```text
Free upstream APIs and feeds
        ↓
Vercel Cron Jobs
        ↓
Fetch in parallel with timeouts, bounded retries, per-response limits, adapter-wide transfer budgets, bounded fan-out, and private per-source resource diagnostics
        ↓
Normalize, validate, deduplicate, and match locations
        ↓
Apply deterministic risk mappings and expiry
        ↓
Validate complete snapshot
        ↓
Private ingestion state + public versioned JSON in Vercel Blob
        ↓
CDN-cached Next.js + MapLibre application
```

### Technical stack and engineering constraints

The MVP is one repository containing one Next.js application. Do not create a monorepo, separate backend service, or independently deployed ingestion service.

“Vercel only” applies to infrastructure owned by the product: application hosting, scheduled execution, and persistence all run on Vercel. GitHub is used only for source control and CI. The browser may load free OpenFreeMap tiles, and scheduled jobs may read the approved free upstream hazard sources; no other application backend or managed data service is allowed.

| Layer | Required choice | Purpose |
| --- | --- | --- |
| Application | Current stable Next.js App Router and React | Static-first interface and cron Route Handlers in one Vercel deployment |
| Language | TypeScript with `strict` enabled | Shared, checked contracts across adapters, risk logic, snapshots, and UI |
| Server runtime | Current Vercel-supported Node.js LTS, pinned in `package.json` | XML parsing, geospatial processing, and scheduled ingestion |
| Styling | CSS Modules and CSS custom properties | Small custom interface without a CSS framework or runtime styling library |
| Accessible controls | [React Aria Components](https://react-aria.adobe.com/getting-started) | Search combobox, listbox, buttons, and dialog or mobile panel behavior |
| Map renderer | [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) | Client-side vector map and GeoJSON markers |
| Basemap | [OpenFreeMap](https://openfreemap.org/quick_start/) | Free vector tiles without a paid map account |
| Runtime validation | [Zod](https://zod.dev/) | Validate all upstream inputs and the published snapshot at runtime |
| Geospatial operations | Modular [Turf](https://turfjs.org/docs/7.1.0/api/booleanIntersects) packages | Geometry intersection and distance matching without PostGIS |
| XML parsing | `fast-xml-parser` | Parse MeteoAlarm Atom and CAP documents |
| Scheduling | Vercel Cron Jobs | Run fast, slow, and maintenance ingestion routes |
| Persistence | Vercel Blob through `@vercel/blob` | Store private ingestion state and public snapshots without a database |
| Unit and integration tests | [Vitest](https://nextjs.org/docs/app/guides/testing/vitest) | Test adapters, mappings, expiry, deduplication, and geospatial rules |
| Browser and accessibility tests | [Playwright](https://playwright.dev/docs/browsers) with `@axe-core/playwright` | Test desktop, mobile, keyboard, browser, and automated accessibility behavior |
| Continuous integration | GitHub Actions and Vercel preview deployments | Run a low-cost deterministic gate for code changes and provide a reviewable deployment |

#### Next.js deployment model

Use a normal Next.js deployment on Vercel. Do not set `output: "export"`: fully static export cannot support request-aware cron Route Handlers. The map page and application shell remain statically rendered and CDN-served under the normal deployment.

Only the cron Route Handlers perform dynamic server work. Normal page views must not invoke a Vercel Function, Server Action, or server-rendered data request.

Use the Node.js runtime, not the Edge runtime, for ingestion. The browser handles only:

- Rendering and interacting with the map
- Searching the static location catalog
- Fetching the public snapshot
- Formatting ISO timestamps with the built-in `Intl` APIs
- Refreshing the snapshot on a fixed interval while the page is open

Use React state and derived values. Do not add Redux, Zustand, a client query library, or a date library for the MVP.

#### Required packages

Runtime dependencies should be limited to:

```text
next
react
react-dom
maplibre-gl
react-aria-components
zod
fast-xml-parser
@vercel/blob
@turf/boolean-intersects
@turf/distance
@turf/helpers
geotiff
```

Development dependencies include:

```text
typescript
@types/node
@types/react
@types/react-dom
@types/geojson
eslint
eslint-config-next
vitest
@playwright/test
@axe-core/playwright
```

Use npm and commit `package-lock.json`. Pin dependency versions in the lockfile. Add another runtime dependency only when an enabled source or required user interaction cannot reasonably be implemented with the platform, standard library, or packages above.

The required npm scripts are:

```text
lint: eslint .
typecheck: tsc --noEmit
test: vitest run
test:e2e: playwright test
build: next build
perf:assets: node scripts/check-asset-budget.mjs
perf:bench: node --import tsx scripts/benchmark-risk.ts
```

#### Persistence and publication

Use two Vercel Blob stores because access mode is configured per store:

```text
Private ingestion store
  ingestion-state.json

Public snapshot store
  latest.json
  previous.json
```

Private ingestion state uses schema V12 and retains at most four transport-health records under each MeteoAlarm, national and air-quality country partition, plus bounded source-owned conditions, quotas and a worker lease. Public Snapshot V10/catalog V2 requires exactly 503 configured destinations and exposes only sanitized alert-transport health. Private V1–V11 readers migrate in memory; older public snapshots synthesize the three Azores destinations as update-pending. `coverageGaps` remains permanent, `delayedHazards` remains temporary, and only a late coverage transport may delay its declared hazard at its mapped destinations. Context, conditions, infrastructure and fallback transports never affect monitoring counts.

Publication follows this order:

1. Read the current private state and its Blob ETag.
2. Read the current public `latest.json` and its Blob ETag.
3. Fetch, validate, and normalize the enabled sources.
4. Produce the complete candidate snapshot in memory.
5. Validate the candidate snapshot with Zod.
6. Conditionally write the new private state using its previous ETag; abort publication if the ETag changed.
7. Conditionally write the new public snapshot to `latest.json` using the ETag read in step 2.
8. If that write succeeds and authoritative Blob metadata still has the just-written ETag, conditionally advance `previous.json` to the snapshot read in step 2. Server-side public reads use control-plane metadata plus an ETag-versioned content URL so CDN cache state cannot be mistaken for a concurrent writer. The previous object's own ETag and snapshot time prevent an older overlapping job from replacing a newer rollback snapshot. If the rollback object is missing, recreate it from the prior validated snapshot with a create-only write and reread after a concurrent creation. Skip the previous copy if another job has already replaced `latest.json`, or if the replaced snapshot was more than five minutes ahead of the validated replacement; an implausibly future-dated object must not enter rollback storage.
9. If the `latest.json` write fails, leave `previous.json` untouched and keep the existing `latest.json`; the next scheduled run reconciles state and retries publication.

Use Blob overwrites with `allowOverwrite: true` and conditional writes through `ifMatch` so an older or overlapping job cannot overwrite newer state. Never write directly to the public snapshot before complete validation.

Provision valid empty state and snapshot files when creating the stores so every production write can use an ETag rather than an unguarded first-write path.

Set `latest.json` in the public snapshot store to the shortest Vercel Blob cache duration supported for the chosen plan, currently 60 seconds. The browser checks for a new snapshot using a ten-minute time-bucket query parameter so its cache cannot hide a successful scheduled update indefinitely.

Keep both Blob write tokens, `CRON_SECRET`, and all upstream credentials server-only. Only non-secret public URLs may use the `NEXT_PUBLIC_` prefix.

#### Test and continuous-integration requirements

Unit tests use captured source fixtures. CI must not depend on live upstream APIs.

Required unit and integration coverage includes:

- Source parsing and runtime validation
- Every source-to-risk mapping
- Event cancellation and expiry
- Deferred sources remain visibly `not_monitored` and cannot enter the public snapshot
- Geometry intersection and distance boundaries
- Missing, delayed, malformed, and partially available sources
- Snapshot schema validation
- Conditional-write conflicts between overlapping cron invocations
- An older overlapping publisher cannot regress `previous.json`
- Failed `latest.json` writes leave `previous.json` untouched

Required Playwright flows include:

- Search and map selection
- Normal, elevated, high, severe, and unknown states
- Stale-data and incomplete-coverage messages
- Keyboard-only navigation
- A desktop Chromium viewport
- A mobile WebKit viewport
- Automated axe checks on the initial map, search results, attention tray, map key, location details, and tile-failure directory
- Failed map-tile loading while search, the text alternative, and the location panel remain usable

Every non-draft pull request that changes executable code, configuration, generated data, or tests must pass the automatic GitHub gate:

```text
npm run check:fast
```

Run exact-SHA `scripts/verify` on the designated Apple Silicon Mac before a direct release. Darwin visual baselines are authoritative. Vercel compiles production; keep `check:deploy` until a required GitHub `check:fast` check can be enforced. Routine pull requests do not install browsers.

#### Explicitly excluded from the MVP

Do not introduce:

- PostgreSQL, PostGIS, Prisma, or another database or ORM
- Redis, Vercel KV, or another cache service
- A message queue or workflow engine
- Microservices or a monorepo
- GraphQL or tRPC
- Redux, Zustand, or another global state library
- WebSockets or server-sent events
- Per-visitor server rendering or upstream API calls
- Tailwind CSS, a component theme, or a full design system
- A paid monitoring, analytics, map, API, or AI service
- Generative AI in ingestion, classification, scoring, or explanations
- Self-hosted map tiles

Reconsider a database only if the product later adds user accounts, notifications, editable content, audit history, or long-term event history. Reconsider a queue only if measured ingestion duration or retries no longer fit safely within Vercel Function limits.

### Scheduled jobs

- Fast ingestion: every 10 minutes for MeteoAlarm, USGS, EMSC, Copernicus EMS, GDACS discovery, Vigicrues, and partitioned national alerts. MeteoAlarm and national-alert health/replacement are isolated per country; USGS processes at most three qualifying candidate detail chains concurrently.
- Slow ingestion: hourly for EFFIS fire danger, EEA AQI at its 498 reviewed destinations, EFFIS/FIRMS active fire, FOEN, eHYD, SLF, EAWS bulletins, EONET, and FCDO.
- Satellite ingestion: every two hours at minute 37 for environment-gated GFM only. The route is disabled-without-fetch unless `GFM_ENABLED=true`.
- Daily ingestion: EDO only, disabled-without-fetch unless `CONTEXT_FEEDS_ENABLED=true`.
- Daily maintenance: prune expired events and fingerprints, validate state, and republish the bounded latest/previous snapshots without contacting an upstream source

Vercel cron endpoints require `CRON_SECRET`. They accept no public parameters and perform no user-specific work.

[Vercel does not automatically retry failed cron invocations](https://vercel.com/docs/cron-jobs/manage-cron-jobs), so each ingestion job owns its bounded retries and last-valid-snapshot behavior.

The browser downloads:

- A versioned static location catalog
- One compact current-state snapshot
- Map tiles directly from the configured map provider

No page view invokes ingestion, normalization, geospatial matching, or an upstream hazard source. No WebSockets or per-user API requests are required.

The application shell starts the catalog and snapshot requests before dynamically loading MapLibre. Map module or tile failure keeps the text directory, search, and destination details usable. Production CI captures all requested application, font, and worker assets at two checkpoints: map readiness must remain below 600,000 Brotli-compressed bytes and the selected-destination experience must remain below 650,000 bytes. Newsreader must not be requested before a destination exposes an editorial heading.

The current-state snapshot warns at 300 KB uncompressed and must never exceed the 500 KB hard limit. Demo and fixture snapshots remain below 300 KB. It contains current clustered incidents and at most five links each, not upstream payloads or long-term event history.

## Snapshot Contract

The abridged example below omits other required providers, partitions, transports, and locations; the Zod contract requires every configured provider, all 28 partitions for MeteoAlarm, EEA, and national alerts, and all 503 locations.

```json
{
  "schemaVersion": 10,
  "catalogVersion": 2,
  "generatedAt": "2026-08-25T18:04:00Z",
  "valid": true,
  "dataHealth": "complete",
  "providers": {
    "meteoalarm": {
      "mode": "authoritative",
      "status": "ok",
      "lastSuccess": "2026-08-25T18:03:12Z",
      "sourceUpdatedAt": "2026-08-25T18:00:00Z",
      "nextExpectedUpdate": "2026-08-25T18:13:12Z",
      "limitationCode": null,
      "partitions": {
        "HU": {
          "status": "ok",
          "lastSuccess": "2026-08-25T18:03:12Z",
          "sourceUpdatedAt": "2026-08-25T18:00:00Z",
          "nextExpectedUpdate": "2026-08-25T18:13:12Z",
          "limitationCode": null
        }
      }
    }
  },
  "locations": {
    "hu-budapest": {
      "level": "HIGH",
      "timing": "UPCOMING",
      "coverage": "partial",
      "coverageGaps": ["air-quality", "security", "nuclear"],
      "delayedHazards": [],
      "hazards": [
        {
          "id": "meteoalarm:example-id",
          "providerId": "meteoalarm",
          "type": "severe-weather",
          "level": "HIGH",
          "timing": "UPCOMING",
          "headline": "Severe thunderstorms may affect Budapest.",
          "explanation": "An orange thunderstorm warning covers Budapest this evening.",
          "action": "Avoid exposed outdoor areas and check local authority advice.",
          "affectedArea": {
            "label": "Budapest and nearby areas"
          },
          "startsAt": "2026-08-25T20:00:00Z",
          "endsAt": "2026-08-25T21:00:00Z",
          "sourceUpdatedAt": "2026-08-25T18:00:00Z",
          "checkedAt": "2026-08-25T18:03:12Z",
          "expiresAt": "2026-08-25T21:00:00Z",
          "sourceName": "MeteoAlarm",
          "sourceUrl": "https://example.invalid/official-alert",
          "confidence": "HIGH",
          "evidence": [
            {
              "providerId": "meteoalarm",
              "sourceName": "MeteoAlarm",
              "sourceUrl": "https://example.invalid/official-alert",
              "sourceUpdatedAt": "2026-08-25T18:00:00Z",
              "checkedAt": "2026-08-25T18:03:12Z",
              "confidence": "HIGH"
            }
          ]
        }
      ]
    }
  }
}
```

Allowed contract values are:

- Location `level`: `NORMAL`, `ELEVATED`, `HIGH`, `SEVERE`, or `UNKNOWN`
- Hazard `level`: `ELEVATED`, `HIGH`, or `SEVERE`
- Hazard and `ELEVATED`, `HIGH`, or `SEVERE` location `timing`: `ACTIVE` or `UPCOMING`
- Location `coverage`: `complete`, `partial`, or `delayed`
- Global `dataHealth`: `complete`, `delayed`, or `stale`
- Provider `status`: `ok`, `partial`, `delayed`, `failed`, or `disabled`
- Partition `status`: `ok`, `partial`, `delayed`, `failed`, or `disabled`; all 28 country keys are required for MeteoAlarm, EEA, and national-alert partitions

The snapshot contains every curated location and every enabled or intentionally unmonitored source. `coverageGaps` names permanent partly checked or not-checked hazards that apply to that destination; `delayedHazards` independently names applicable hazards whose expected update is late. Stale snapshot aging adds applicable live hazards to `delayedHazards` without rewriting permanent gaps. Low-confidence candidates, raw publisher text, internal fingerprints, and upstream payloads never appear in the public snapshot.

The build fails if fixtures or generated snapshots do not match the versioned schema.

## Operating Budget

Vercel service charges must remain at the base $20 monthly platform fee, excluding taxes and the domain. All upstream data APIs must remain free, and the product must not intentionally use paid on-demand capacity.

[Vercel Pro currently charges a $20 monthly platform fee](https://vercel.com/docs/plans/pro-plan), includes one deploying seat and monthly infrastructure credit, and switches to on-demand billing after included credit is exhausted. [Spend Management](https://vercel.com/docs/spend-management) checks usage periodically and can pause production only after a configured threshold is reached, so it is a fail-safe rather than a mathematical guarantee of an exact invoice. The design and operating margin must keep normal use inside included allocations and credit.

MVP constraints:

- One Vercel Pro deploying seat
- No paid add-ons
- No paid API, database, queue, AI model, analytics, or monitoring service
- No on-demand work caused by map visitors
- One shared, CDN-cacheable data snapshot for all visitors
- Bounded snapshot storage and automatic cleanup
- Monitor [Vercel Blob's metered storage, operations, and transfer](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- Usage and spend alerts enabled before public launch
- A Vercel spend-management action configured at the lowest practical threshold, with production pausing enabled

The design target is 100,000 map visits per month without exceeding the fixed Vercel fee. Before launch, verify the expected request, transfer, function, Blob, and map-tile usage against current provider pricing.

If usage approaches the limit, preserve the current read-only map and reduce non-critical ingestion or recovery history before allowing unplanned charges.

## Performance, Accessibility, and Privacy

### Performance

- Usable map within 3 seconds on ordinary mobile data
- Search results within 100 milliseconds after the catalog loads
- Location panel opens within 200 milliseconds from a loaded marker
- Default markers include `ELEVATED`, `HIGH`, and `SEVERE`; filtering updates the existing GeoJSON source without refetching data or resetting user navigation
- No blocking third-party hazard request during page load
- If map tiles fail, show a plain-language map error while keeping search, the non-normal location list, and location details usable

### Accessibility

- WCAG 2.2 AA target
- Keyboard-accessible search, map alternatives, controls, and location panel
- Text or icon accompanies every risk color
- Minimum touch target of 44 by 44 CSS pixels
- Screen-reader summary lists non-normal locations without requiring map interaction
- Reduced-motion preferences respected

### Privacy

- No accounts
- No browser geolocation request
- No storage of searches
- No advertising or cross-site tracking
- Search is performed locally in the browser
- Essential operational logs must not contain unnecessary personal data

## Acceptance Criteria

The MVP is ready to launch when:

1. Users can search or select every curated EU and Swiss location on desktop and mobile.
2. Every public label uses the plain-language definitions in this document.
3. Every non-normal state has an explanation, action, affected area, time, confidence, and direct source link.
4. A source failure cannot silently turn a location normal.
5. Expired and cancelled events disappear automatically.
6. Disabled optional sources, including GDELT, cannot fetch, store, or publish events unless their exact-true Production switch is set.
7. Every deferred hazard is visibly identified as partly checked or not checked.
8. No page view queries an upstream hazard API.
9. Invalid or partial ingestion cannot replace the last valid snapshot.
10. Each enabled source has license, coverage, mapping, expiry, and failure fixtures.
11. The UI remains usable without cookies, an account, or location permission.
12. Risk is understandable without relying on map color.
13. A 30-day cost model at 100,000 visits remains within included Vercel allocations and total monthly credit, with at least 25% documented cost headroom.
14. Production cutover checks confirm source isolation, expiry, bounded storage, and conservative failure behavior on the exact release commit.
15. Known unmonitored hazards and incomplete geographic coverage are visible to users.
16. Search and the text-based location experience remain usable when the basemap provider is unavailable.

## Non-Goals for the MVP

- General destination safety scores
- Crime data or rankings
- Transport status
- Trip planning or booking
- Accounts and saved places
- Push, email, or SMS notifications
- Browser geolocation
- User-submitted incident reports
- Native mobile applications
- Multiple languages
- Historical hazard exploration
- Predictive risk beyond the next 24 hours
- Manual event moderation

## Launch Gates and Known Limitations

- The exact 400–600-location catalog must be approved.
- A versioned country-by-hazard coverage matrix must identify permanent monitoring completeness for every covered country; the UI and `coverageGaps` must use that configuration, while provider and partition health independently determines `delayedHazards`.
- Each source's license and automated access must be verified in production.
- MeteoAlarm production access must be tested with an approved EDR token or with every required country Atom feed; a presumed Europe-wide Atom feed is not an acceptable dependency.
- The EEA air-quality adapter uses the official keyless European AQI ImageServer. Launch requires its live smoke test, source-time check, category-boundary fixtures, destination-specific missing-pixel behavior, 512 KB budget, and attribution to remain green.
- GDELT is enabled only with a reviewed publisher allowlist containing at least three independent parent groups. Its fixed exclusions, syndication fingerprints, six-hour candidate lifecycle, link-only persistence, and non-blocking failure behavior must remain covered by tests and live review.
- GDELT ingestion must not store or republish article bodies, headlines, snippets, images, or other publisher-owned content. Only hashes, reviewed ownership metadata, timestamps, point geometry, and canonical article links may persist; public copy remains fixed TravelCanary text.
- Human-caused hazard coverage is partial at launch: Copernicus EMS may provide `ELEVATED` context. `HIGH` or `SEVERE` security, unrest, conflict, industrial, or civil-emergency states require reusable official feeds that are not yet identified. Until those feeds are approved per country, the UI must name those categories as not checked rather than imply normal conditions.
- Nuclear and radiological emergencies remain visibly not checked outside enabled national-warning partitions; measurement feeds are not substitutes for official emergency notifications.
- Copernicus EMS activations and satellite fire detections provide context and may lag an incident; they are not equivalent to official public warnings.
- Source coverage varies by country and hazard. Missing coverage must be stated rather than represented as normal.
- The product is an information aid, not an emergency service. Official local instructions always take precedence.

## Keyless provider expansion contract

Public publication uses Snapshot V10/catalog V2 with provider and transport health, clustered evidence, permanent gaps, delayed hazards, and exactly 503 locations. The browser upgrades Snapshot V1–V9. Private state V12 accepts V1–V11. The first V12 state write preserves an immutable `ingestion-state-v11-backup.json`; the Snapshot V9→V10 publication separately preserves `snapshot-v9-backup.json`. Conditions V2 is a deliberate browser/publisher cutover with no V1 fallback. Older inputs retain version-specific immutable backups.

GDACS is discovery-only. EMSC is a preliminary earthquake fallback capped at `ELEVATED`; USGS ShakeMap wins. Vigicrues, LHP, FOEN, eHYD, SLF, and reviewed EAWS partitions are authoritative and coverage-scoped. GFM, active-fire hotspots, EONET, EDO, FCDO, and Catalonia context are capped at `ELEVATED`.

EEA AQI is enabled and location-specific at 498 reviewed destinations. The three Azores and two Canary destinations remain explicitly not monitored for official AQI. EFFIS/FIRMS attribution identifies the successful transport. IFRC, perimeters, GloFAS targeting, GDELT, GFM, and context remain independently gated. The national audit activates AT, CZ, DE, ES, FR, IT, LU, PL, and SE, with FI/IE weather fallbacks. Every other system retains an explicit evidence, credential, or access blocker. Disabled systems never imply coverage or cause a global outage.
