# WORK-53 independent MeteoAlarm mapping review

Verdict: proceed with a small polygon-capable MeteoAlarm path, keep unresolved static-region countries blocked, and do not use NUTS as an unverified substitute for provider regions. No activation approved by this review.

## Scope and evidence

Nine candidate countries: AD5, BA10, IS12, MD8, ME8, MK8, NO20, RS12, GB30 (113 destinations). Inspected existing candidate Atom/CAP fixtures and `src/lib/ingestion/adapters/meteoalarm.ts`, `templates.ts`, and region matching in `geospatial.ts`. The figures below describe retained fixture contents, not a claim about present live alerts or complete country capability.

| Country | Fixture evidence | Smallest mapping route | Unresolved gate |
|---|---|---|---|
| AD | 12 Atom entries, all contain polygons; three distinct named zones South/Centre/North; observed storms and high temperature | Parse and intersect the explicit Atom CAP polygons. No metadata API or static NUTS mapping needed. These polygons can also support an independently reviewed versioned zone artifact if desired, but dynamic alert geometry is simpler. | Validate all five destination footprints against the three zones, boundary overlaps and axis order; prove update/cancel behavior for polygon events. Do not infer other hazards from membership. |
| BA | 32 entries; EMMA_ID BA001–BA010, ten named warning areas; no Atom or sampled linked-CAP polygons; observed high temperature and wind | Exact provider-zone mapping from an authoritative warning-region map or reusable geometry/crosswalk; store EMMA_ID plus evidence. | No destination-to-zone spatial crosswalk yet proven. A town sharing a zone name is not enough for its full destination radius, ski resorts or nearby mountains. Entity jurisdictions matter. No NUTS equivalence established. |
| IS | Two Atom entries, one polygon; EMMA_ID IS010/Southeast Iceland; linked CAP has same polygon and bilingual text; observed wind | Use actual warning polygon dynamically. Stable IS010 can remain provenance, not the sole spatial join. | One southeastern warning does not enumerate all 12 destinations' warning regions. Need geometry-first parser tests and capability evidence for other hazards; no blanket avalanche/flood/volcano inference. |
| MD | Empty Atom fixture | Wait for positive anonymous CAP/Atom geometry or an authoritative reusable warning-zone definition; retain official warning page as link-only meanwhile. | No positive geocode, polygon, lifecycle or provider-specific hazard fixture. Empty feed proves availability only. |
| ME | Eight entries; EMMA_ID ME001 Continental and Mountains, ME002 Central, ME003 Adriatic coast; no polygons in Atom or sampled CAP; observed high temperature, thunderstorm and wind | Exact three-zone authoritative boundary/crosswalk, then reviewed destination membership. | Names are not boundaries; especially mountain/coastal transition destinations. No NUTS equivalence established. |
| MK | Empty Atom fixture | Same positive-fixture/official-zone route as MD. | No verified positive geometry or country-specific hazard transport contract. Directory membership is insufficient. |
| NO | 18 entries and 18 polygons, nine named coastal gale areas; no geocodes; observed Gale | Dynamic polygons, with explicit marine/coastal applicability. Existing static area-name mapping is unnecessary and unsafe for these geometries. | These are marine gale warnings, not evidence of inland weather coverage. Verify inland alert examples and supported hazard taxonomy separately. A radius intersecting offshore water should not automatically imply the same impact across the whole destination. |
| RS | 24 entries; EMMA_ID RS001–RS011; no polygons in Atom or sampled CAP; observed high temperature | Authoritative eleven-warning-area crosswalk, using exact EMMA_ID identities. | Statistical NUTS regions are not proven identical. Explicitly avoid mapping RS007 Kosovo i Metohija onto the RS catalog or silently assigning XK destinations to RS jurisdiction. New XK coverage needs a separate reviewed decision. |
| GB | Empty Atom fixture | Positive official warning polygon fixture, then dynamic matching if that is the actual Atom/CAP representation. | No positive feed geometry seen. Do not assume NUTS, counties, Met Office administrative summary regions, or UK/GB code equivalence. |

## Concrete parser boundary

Current `hasValidAlertPayload` (meteoalarm.ts around 81–96) requires a geocode or areaDesc and ignores polygon as spatial validity evidence. `parseMeteoAlarmFeed` around 210–236 extracts all geocode values without valueName discrimination, appends normalized areaDesc, and emits only `geometry.kind = regions`. It never uses the explicit polygons already present in AD/IS/NO fixtures.

Smallest implementation: add a bounded validated CAP-polygon path within the existing parser. CAP coordinate order is latitude,longitude; convert explicitly to GeoJSON longitude,latitude. Validate finite legal coordinates, closure, minimum ring size, total points/bytes, and multiple polygons. Preserve alert identifiers and cancellation/update references; use deterministic per-area identity without relying on mutable area-list position. Prefer explicit valid geometry to geocode/name fallback for polygon alerts. Malformed or partially missing geometry must not silently turn into whole-country coverage or erase retained valid siblings.

The existing normalized polygon contract can avoid expanding public event types. If multiple polygons cannot be represented as one existing normalized geometry, emit deterministic bounded per-polygon events while preserving source lifecycle. Do not build a general metadata service, fetch all linked CAPs, or copy every national region into a new framework merely to support polygons already inline.

Geocode fallback must retain the provider scheme: EMMA_ID is not NUTS. A NUTS boundary may be used only after exact provider/version equivalence is documented. AreaDesc normalization is a join key, not proof of geographic inclusion. Do not substitute nearest region, country centroid, country-wide fallback, or an unreviewed list of towns.

## Country hazard capability evidence

Only the observed fixture hazards above are proven end-to-end feed evidence. They are a lower bound, not the complete country capability set. Broader authority documentation can establish a warning service's remit, but still needs evidence that the selected MeteoAlarm transport carries the claimed hazard.

- AD official alerts page exposes the three-zone structure: https://www.meteo.ad/en/Alerts . Fixture proves storms and high temperature; do not treat all MeteoAlarm categories as AD capabilities.
- BA FHMZ's official 2023 report describes participation and entity-level issuing responsibilities: https://fhmzbih.gov.ba/bilten/2023-bilten.pdf . Its general discussion lists several hazardous phenomena but does not independently prove each one is carried by the reviewed Atom transport. Direct FHMZ page reuse has its own restrictions; do not assume MeteoAlarm fixture reuse terms transfer to arbitrary national website scraping.
- IS official alerts: https://en.vedur.is/alerts and https://www.vedur.is/vidvaranir . Positive fixture proves wind. Separate Iceland avalanche and volcanic services are not automatically MeteoAlarm capabilities.
- MD official warning guidance: https://www.meteo.md/index.php/ro/weather/current-warnings . It describes hazardous weather, but this pass has no positive MeteoAlarm fixture or mapping.
- ME official authority: https://www.meteo.co.me/ and warnings index https://www.meteo.co.me/page.php?id=165 . The retained feed demonstrates heat, thunderstorm and wind; complete transport capability remains unverified.
- MK: this bounded primary-source search did not resolve a current positive national/Atom mapping contract. Keep the gate explicit rather than relying on directory presence.
- NO official phenomena: https://www.met.no/vaer-og-klima/ekstremvaervarsler-og-andre-farevarsler/vaerfenomener-som-kan-gi-farevarsel-fra-met . It distinguishes separate marine gale warnings. https://www.met.no/vaer-og-klima/ekstremvaervarsler-og-andre-farevarsler/deling-av-farevarsel confirms dissemination through MeteoAlarm. https://api.met.no/weatherapi/metalerts/2.0/documentation describes CAP lifecycle and explicitly points flood consumers to NVE; therefore do not infer flood/avalanche completeness from MET gale fixtures.
- RS official region/phenomenon UI: https://www.meteoalarm.rs/eng/meteo_alarm.php . The authority describes eleven geographic or administrative warning areas at https://www.meteoalarm.rs/eng/terms_and_conditions2.pdf ; this supports custom provider regions, not NUTS equivalence. The national website's reuse conditions require review before copying its map; linked MeteoAlarm CAP has separate provenance.
- GB official service explicitly lists rain, thunderstorms, wind, snow, lightning, ice, extreme heat and fog: https://weather.metoffice.gov.uk/guides/warnings . This supports the national service remit, not proof that the empty retained Atom feed demonstrates every type. Rain must not be promoted to a separate flood-warning service; no avalanche or wildfire capability inferred.

Shared portal directory: https://api.meteoalarm.org/edr/v1/collections/warnings?f=html . Collections prove country availability, not a country-by-hazard monitoring contract. The portal uses warnings-UK while the catalog uses GB: make any translation explicit. Token-protected metadata/EDR endpoints are excluded by task scope; no credentials were obtained, embedded tokens inspected or authenticated requests made.

## Actionable next steps

1. Implement/test inline polygon support using the existing AD/IS/NO fixtures. Exercise far-away rejection, CAP axis order, overlapping destination radii, multiple polygons and update/cancel retention. Assess marine-only NO warnings as marine hazards rather than countrywide weather coverage.
2. Generate a read-only fixture-to-candidate intersection report, keeping unmatched destinations and partial footprints visible. This demonstrates those particular warnings, not stable nationwide monitoring.
3. For BA/ME/RS, locate authoritative public reusable warning-zone boundaries or exact jurisdiction crosswalks. Capture exact zone IDs, boundary version, source and reuse basis. If unavailable without credentials/permission, retain link-only and blocked automation for unmapped destinations.
4. For MD/MK/GB, obtain a positive retained anonymous alert fixture before deciding which geography path applies. Do not manufacture static NUTS mappings from empty feeds.
5. Freeze per-country hazard capability and destination eligibility separately. A healthy feed with no mapped region is unavailable monitoring for that destination, not a normal/no-warning result.

## Validation limits

Performed read-only XML extraction/counting of existing fixtures, parser/geospatial inspection, and bounded authoritative web research. No production changes, activation, new network adapter, credentials or tests executed. This review does not provide completed per-destination static mappings or a complete hazard matrix. It identifies a verified direct-geometry route for AD/IS/NO and precise remaining gates for the other six countries.
