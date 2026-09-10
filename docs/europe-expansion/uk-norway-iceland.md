# WORK-53 independent UK/Norway/Iceland source review
Reviewed 2026-09-08. Decisions concern the anonymous-source scope. No credentials, account creation, outreach or repository edits. `blocked` means the listed contract is not ready for runtime; it does not mean the hazard is inapplicable. `activate-candidate` means source semantics are feasible, not that an adapter or release is approved.

## Completed shared assessments

### open-meteo — activate-candidate for weather/AQ context; marine subset only
Anonymous JSON endpoints: https://api.open-meteo.com/v1/forecast ; https://air-quality-api.open-meteo.com/v1/air-quality ; https://marine-api.open-meteo.com/v1/marine . Existing parseOpenMeteo implements the relevant hourly field/unit/time contract. Saved dossier includes successful weather and AQ replay for all62 UK/NO/IS points. Marine has41 coastal candidates,28 valid responses and13 unavailable responses: gb-belfast, gb-derry, gb-newcastle-upon-tyne, is-akureyri, is-reykjavik, is-isafjordur, no-alta, no-flam, no-geiranger, no-kirkenes, no-narvik, no-tromso, no-andalsnes. Exclude these13 from marine activation until an independently representative offshore cell is frozen; do not fill null wave arrays with zero. Open-Meteo modeled AQ does not establish eligibility for the separate EEA modeled raster.
Reuse/access: https://open-meteo.com/en/terms distinguishes CC BY4 data from free endpoint access: free service is noncommercial only, <10000calls/day,5000/hour,600/minute. Record that distinction in sourceReviews; existing source reuse alone is not sufficient proof of commercial API access. No purchase/account requested. Remaining gate is deployed-use eligibility under these terms plus release budgets, per-point marine/terrain decisions, unchanged forecast validity/null handling.

### AWC METAR — blocked on exact station mappings
Existing anonymous API and parser are reusable: https://aviationweather.gov/data/api/ . Country-level weather eligibility does not imply an airport observation. Use saved awc-stations-metadata.json and awc-metar-candidates.json to freeze ICAO ID, coordinates, actual observing timestamp, station operating identity and distance/terrain relation for each proposed destination. Station weather remains airport context; no whole-island/mountain representation. Tests need missing station, duplicate/latest observation, stale observation and partial batch. Do not add provisional nearest-airport matches to the catalog identity freeze.

### MeteoAlarm — blocked on country-specific nonempty lifecycle/geography
Existing saved GB/NO/IS Atom fixtures and linked CAP are usable. GB empty only does not prove nonempty warning mappings; IS existing sample is expired content, not fresh monitoring. Preserve CAP Actual/Public, Alert/Update/Cancel references, event subtype and exact polygons/geocodes. Separate marine/land and fire danger from actual wildfire; do not advertise all listed hazard categories just because country feed exists. Source attribution/license from reviewed feed contract retained. National specialist sources below are separate transports, not automatic replacements for every MeteoAlarm hazard.

## United Kingdom: four nations

### ea-flood — activate-candidate, England only
Official anonymous JSON https://environment.data.gov.uk/flood-monitoring/id/floods ; contract https://environment.data.gov.uk/flood-monitoring/doc/reference . OGL; attribute Environment Agency real-time flood/river API.15-minute updates. Grain is current flood-area warning; severity1 severe,2 warning,3 alert,4 withdrawn. Area ID can be reused after withdrawal; timeRaised is last review, not guaranteed onset. Use complete successful replacement and preserve unexpired prior state on failure. Freeze linked WGS84 flood polygons offline, resolve pagination (area lists default500) and exact destination intersections. No blanket UK/England county exposure. Earlier three bounded requests timed out: runtime acceptance remains blocked until a successful bounded current response and positive/withdrawal/reactivation/partial fixtures exist. Data availability failure is not proof that England is unmonitored by its authority.

### sepa-flood — excluded keyed route; link-only Scotland warnings
Floodline API access request remains outside anonymous scope. https://www.sepa.org.uk/environment/environmental-data/ . Public official warning links can be supplied without asserting ingestion. Do not conflate this exclusion with the following open observation route.

### sepa-hydrometry — NEW blocked context record, Scotland only
Anonymous KiWIS JSON supported at https://timeseries.sepa.org.uk/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&request=getStationList&format=json . Docs: https://timeseriesdoc.sepa.org.uk/api-documentation/api-function-reference/ and https://timeseriesdoc.sepa.org.uk/api-documentation/before-you-start/what-controls-there-are-on-access/ . OGL, acknowledge SEPA. Nominal5000anonymous credits/day; official known issue exhausts quota quickly, and docs recommend registration for web products. Therefore do not promise dependable unattended anonymous refresh. No key requested. Observation grain ts_id+timestamp, typically15minutes, subject to later quality revision. Request explicit timestamp/value/quality fields; freeze station river, parameter, aggregation interval, units and datum, not rainfall/daily totals mistaken for instantaneous level. Need quota-safe small station list, positive/quality/null/late-revision fixtures and exact Scottish destination-river matches before context activation. Never synthesize flood thresholds from stage.

### nrw-flood — excluded keyed route; link-only Wales warnings
https://api-portal.naturalresources.wales/ requires signup/API key for documented route; no request made. Public https://flood-warning.naturalresources.wales/ may be linked. OGL with NRW attribution does not remove access control. No inherited Environment Agency geometry for Wales.

### ni-flood — link-only; structured warning contract unproven
DfI Rivers is a separate authority: https://www.infrastructure-ni.gov.uk/ . Do not map EA/SEPA/NRW warning absence onto Northern Ireland or claim UK-wide flood coverage. No anonymous structured positive/withdrawal warning fixture established in bounded review. That exact missing transport/lifecycle contract is the gate; do not invent station-threshold warnings.

### sais-avalanche — blocked seasonal specialist
https://www.sais.gov.uk/ and https://www.sais.gov.uk/how-we-produce-avalanche-reports/ . Six Scottish mountain forecast areas, seasonal full bulletins, not all Scotland and not UK avalanche absence elsewhere. Existing dossier records advertised RSS but has no validated report payload/reuse contract. Need one winter bulletin with issue/validity, full terrain/aspect/elevation and official region geometry intersecting Cairngorms/local mountain footprints; record redistribution license before retaining report prose. Current off-season no-category response is seasonal-unavailable, never clear.

### traffic-wales-rss — NEW activate-candidate context; current positive fixture is excluded congestion
https://traffic.wales/developers explicitly allows anonymous RSS, updates5minutes, motorway/trunk roads generated by Traffic Wales only. Exact endpoint https://traffic.wales/feeds/incidents-events/rss.xml ; roadworks and headlines are separate /feeds/roadworks/rss.xml and /feeds/headlines/rss.xml. Credit Traffic Wales, preserve terms/copyright; DATEX/CCTV routes require access and remain excluded. https://traffic.wales/rss ; https://traffic.wales/copyright-statement . Saved /tmp/work53-independent-uk-no-is/wales-incidents.xml:1192bytes SHA256129cdcd72abc429176857ff5d64a0acb7a568c0b2007d2ac89692e23cb997d61. One GUID RNMDA_2026131677, M4 J24–J26, Moderate congestion, GeoRSS51.596832,-2.964887, pubDate2026-09-08T16:47:50Z. Description contains offset-free start/end/update clock text. Under current disruption contract this congestion sample must be ignored. Need strict closure/major-interruption vocabulary plus real positive closure sample, documented local-clock normalization, stable-ID replacement/removal and freshness bound. GeoRSS point is a road-event representative point, not whole-route/city closure. No pagination observed; require complete bounded RSS before replacement.

### trafficwatchni-rss — NEW activate-candidate context, nonempty gate remains
https://www.trafficwatchni.com/twni/rss-faqs lists separate incidents/roadworks/events; all-NI feeds cover trunk roads/motorways; *_belfast feeds cover all Greater Belfast roads. Five-minute cadence. https://www.trafficwatchni.com/twni/terms-and-conditions explicitly permits commercial RSS reuse when DfI Traffic Information and Control Centre is credited and links remain functional. Saved anonymous https://rss.trafficwatchni.com/trafficwatchni_incidents_rss.xml HTTP200,503bytes SHA2568d807f296cbae28cd32c18aa12bcd7c6867fc545ee73eb873c378070bda816d9, empty channel pubDate2026-09-08T18:30:00+01:00. See ni-incidents.txt/probes.json. Need nonempty ID/geometry/start/end/closure fixtures, duplicate handling when combining Belfast/all-NI feeds, source-age check and conditional complete-replacement behavior. Preserve article links; RSS's HTTP self/channel links do not authorize arbitrary HTTP fetches or credential-bearing URLs.

### England/Scotland roads and UK utilities — link-only scoped authorities
Current official route planners https://www.trafficengland.com/ and https://www.traffic.gov.scot/ are meaningful scoped links. This review did not validate a current anonymous structured incident+reuse contract for either; historical RSS references alone are not runtime evidence. No broad API registration undertaken. UK power requires local network-operator scope, with https://www.powercut105.com/ for Great Britain and NIE Networks separately for Northern Ireland; do not represent an electricity directory as a national outage feed. Water/telecom similarly remain link-only without operator geometry, public reuse and active/restored lifecycle. Missing transport is not hazard inapplicability.

## Norway

### met-norway-alerts — activate-candidate subject to explicit transport cache change
https://api.met.no/weatherapi/metalerts/2.0/current.rss?lang=en and linked CAP2 XML are anonymous; https://api.met.no/weatherapi/metalerts/2.0/documentation . Existing real CAP sample2.49.0.1.578.0.20260908063939.084 contains bilingual Actual/Public Alert, marine gale Moderate with UTC onset/expiry and altitude/ceiling. Exclude marine gale from land destinations and forestFire from actual-fire category. Full Alert/Update/Cancel identity/reference semantics and exact polygons required. https://api.met.no/doc/TermsOfService requires identifying UA, cache Expires/Last-Modified, no repeated immutable CAP retrieval, max4decimal coordinate requests, HTTPS and redirect/gzip support. Existing blanket redirect rejection is a real transport mismatch; implement only bounded allowlisted redirects or document why selected immutable routes avoid them. CC BY4 credit/license/modification notice; keep retired CAP IDs cached even when no scored event is emitted. No cadence or current-feed publication timestamp may overwrite original incident times.

### nve-flood — activate-candidate with municipality/time gates
Anonymous https://api01.nve.no/hydrology/forecast/flood/v1.0.10/api/Warning/2/2026-09-08/2026-09-09 returned[] earlier. https://api.nve.no/doc/flomvarsling/ documents versioned warning, municipality set, exposed height, validity and activity0 unassessed. Warning/All may synthesize0; no all-clear inference. NLOD compatible CC BY3Norway, identify Flomvarslingen/Varsom and preserve complete bulletin access. Need positive and revised/withdrawn samples, explicit timezone for offset-free JSON, current municipality identifiers and terrain-aware applicability. Fetch bounded date range, deduplicate event/version and do not allow stale lower version to replace newer. Flood hazard is not a station stage observation.

### nve-avalanche — activate-candidate after region/time mapping
https://api01.nve.no/hydrology/forecast/avalanche/v6.3.2/swagger/docs/v6.3.2 and /api/Cap/Feed/2026-09-08/2026-09-09 (294byte empty RSS). Winter fixture /api/RegionSummary/Detail/2/2026-02-15/2026-02-15 returned192242bytes. Synthetic RegId0/DangerLevel0 coexist with genuine bulletin IDs; use region+valid-time identity and revision/predecessor handling. Offset-free times need authoritative normalization before scoring; retain tendency, aspect/elevation and terrain warning context. NLOD attribution/full-bulletin requirements: https://api.nve.no/doc/snoeskredvarsel/ . Exclude Svalbard/JanMayen from this approved mainland roster, not from NVE source capabilities. Freeze exact forecast-region intersections for local mountain entries; city radius overlap alone is insufficient.

### norway-roads / nve-hydapi / frost — excluded authenticated routes
Documented Statens vegvesen traffic-message DATEX route requires ordering access: https://dataut.vegvesen.no/dataservice/trafikkmeldinger-api . Keep public https://www.vegvesen.no/trafikk/ link. NVE HydAPI and MET Frost observation routes must not inherit anonymous status from warning/forecast APIs; no credentials requested. An independently documented anonymous hydrometric route would require a separate record, not activate this excluded route.

### elvia-outages — NEW link-only regional utility
https://www.elvia.no/strombruddskart/ reports onset, affected meters/area and planned maintenance. It explicitly omits some low-voltage faults. https://www.elvia.no/hva-er-elvia/om-oss/kommuner-i-elvias-stromnett/ defines operator scope. Do not turn this into all-Norway coverage. Structured redistribution, stable outage IDs, restored lifecycle and exact service-area intersection are not validated; link-only is deliverable now, with no polling or login.

## Iceland

### iceland-roads — activate-candidate context, geometry/code gates
Existing saved segment and point JSON fixtures in /tmp/travelcanary-europe-source-probes are positive anonymous evidence, not an alert source. https://www.vegagerdin.is/vegagerdin/gagnasafn/faerd-gagnasnid and https://www.vegagerdin.is/vegagerdin/gagnasafn/vefthjonustur/terms-and-conditions . Attribute IRCA and licence. Freeze WFS segment geometry join, strict severe/unpassable codes; unknown/not-serviced never passable. DagsSkrad is observed/recorded state, DagsKeyrtUt export time, GildirTil point validity. Use complete snapshot replacement only after bounded success, retaining valid prior records on failure. Proposed512KiB/2000records/hourly bounds are implementation budgets, not provider guarantees. Need closure/reopening, stale export vs stale observation, missing geometry, duplicate segment and unknown-code fixtures. Published road condition does not establish every legal access restriction.

### imo-aviation — excluded from scored ground volcano
https://api.vedur.is/epos/openapi.json is public CC BY4, version2026-02-05; /volcano/general-information/volcanoes-status explicitly returns aviation color. Do not equate it with ground VALS or evacuation. /volcano/notice-reports/vona is aviation notice metadata with default limit1; /vwr is weekly report metadata, not a complete current restriction list. bbox is lat/lon order per schema, not GeoJSON order. No aviation-only UI is requested; retain official links.

### imo-ground — link-only current assessment; scored route blocked
https://en.vedur.is/volcanoes/fagradalsfjall-eruption/hazard-map/hazard-map documents new June2026 ground-hazard method replacing historical seven-zone map. Need current structured VALS+hazard polygons and exact publication/expiry; evacuation/access must come from responsible authority, not aviation colors or probabilistic ash/gas models. IMO reuse terms require attribution/download date and clear modification attribution: https://en.vedur.is/about-imo/the-web/conditions . No invented new scored mapping from a raster screenshot.

### imo-avalanche — link-only new official site; scored transport blocked
https://en.vedur.is/avalanches/forecast/ explicitly points to https://gottvedur.is/snjoflod/en ; bounded direct read returned403. Current official overview has5forecast regions with seasonal schedule, not older3region assumptions. Required fields: region polygon, bulletin ID/update, validity, rating/no-rating, altitude/aspect, full bulletin. Need a winter positive and off-season absence fixture from the new source, not scrape the retired page. Existing general reuse terms alone do not establish a stable structured endpoint.

### veitur-outages — NEW link-only scoped utility
https://www.veitur.is/en/outages lists active, planned and completed electricity/hot-water/cold-water/sewer notices with postcode/status filters and pagination. https://www.veitur.is/en/outages-and-precautions explicitly says brief/new outages may not yet be announced. Veitur serves defined networks, not all Iceland. Link-only now; no national monitored coverage. Runtime would require redistributable structured lifecycle/geometry, exact service area and pagination; filtering only first page or any historical completed notice would misstate current outages. Do not parse free prose into national hazard severity.

## Dossier edits recommended to parent
Add records and category links for sepa-hydrometry, traffic-wales-rss, trafficwatchni-rss, uk-air, elvia-outages and veitur-outages. UK-AIR observation candidate currently omitted: official OGC SOS/REST described at https://uk-air.defra.gov.uk/data/about_sos and https://uk-air.defra.gov.uk/sos-ukair/static/doc/api-doc/ ; OGL data attribution at https://uk-air.defra.gov.uk/data/gis-licences . Saved London station probe returned500 (/tmp/travelcanary-europe-source-probes/uk-air-probe.json). Block activation until a successful bounded station/pollutant/unit/averaging-period/quality sample and representative mapping, not because UK observed air data is unavailable in principle. Record UK four-nation scope and Open-Meteo access restrictions separately from data licence. Populate endpoint, jurisdiction, reuse, timestamp/lifecycle and concrete fixture/mapping fields; generic country officialUrls repeated across20hazards are not a completed source contract.

Exact Iceland road fixture provenance already retained by parent: https://gagnaveita.vegagerdin.is/api/faerd2017_1 HTTP200358289bytes SHA2565c1be7fc701776d28b651bd2aaf98cf788c152edb8b97cd2e75a712eabec6e1e, tests/fixtures/europe-expansion/iceland-roads.json ; https://gagnaveita.vegagerdin.is/api/faerdpunktar2017_1 HTTP20020863bytes SHA256b0d684586c2ee7313cb7cf1c1bdea506f23142657fc4993d7e1b84efeb5a092c, tests/fixtures/europe-expansion/iceland-road-points.json . No further probe required.


## Explicit category accounting addendum

Read-only consolidation of the retained review, `/tmp/work53-shared-provider-review.md` and `/tmp/work53-meteoalarm-mapping-review.md`; no repeated probes. Parent-supplied EEA and marine results are incorporated as review metadata, not independently remeasured here. `Conditional` means eligible for later activation after the stated gates, not presently activated. `Blocked` and source-route `excluded` never mean the hazard is inapplicable. EONET/CEMS fixes must pass their separate review/release gates; source-contract corrections do not themselves activate the expansion.

### United Kingdom: 20 hazards

| Hazard | Source role, disposition and exact remaining gate |
|---|---|
| severe-weather | Blocked MeteoAlarm mapping: retained GB Atom is empty. Met Office national remit includes rain/wind/storms/fog, but need positive Atom/CAP geometry and lifecycle; official Met Office page is link-only meanwhile. |
| flood | England EA candidate blocked pending successful current bounded response, flood-area polygons and withdrawal/reactivation tests. Scottish SEPA and Welsh NRW keyed warning routes excluded; public pages link-only. NI warning route link-only/structured contract blocked. GFM corroboration and CEMS mapping remain separately gated, never UK-wide warning coverage. |
| extreme-heat | Blocked MeteoAlarm positive geometry/lifecycle; Met Office explicitly supports extreme-heat warnings nationally. Official link-only until transport evidence passes. |
| extreme-cold | Blocked: no verified GB MeteoAlarm cold-warning contract. Do not equate snow/ice warnings or a forecast temperature with a national extreme-cold alert. |
| wildfire | Conditional shared eligibility: keyless EFFIS satellite evidence; EONET context after query/release gates. Neither establishes national wildfire-warning coverage. CEMS mapping context additionally needs country and completeness gates. National warning/restriction route blocked: exact geometry, severity and withdrawal contract unverified. |
| fire-danger | Conditional EFFIS forecast eligibility for seven outdoor destinations only; verify valid raster samples. Exclude other 23 from this adapter under its current type policy, not from the hazard itself. |
| air-quality | Reviewed EEA raster supplied 0 valid GB samples out of30: unavailable for this transport. UK-AIR is a separate blocked observation candidate (saved station probe500), requiring station/metric/averaging/quality contracts. Open-Meteo modeled AQ is context, not observed hazard monitoring. |
| earthquake | Conditional shared eligibility for every candidate: USGS reported earthquakes/ShakeMap; EMSC preliminary fallback only. Freeze expanded schema/eligibility and new-coordinate tests; no claim of complete small-earthquake detection. |
| volcano | Conditional EONET context eligibility only after query/release gates. No national ground-warning/restriction activation from global context; current polygons and authoritative validity/withdrawal gate remains. |
| drought | Conditional EDO agricultural/ecosystem context; exact valid centroid cell and source product date required. No-data is unavailable. Local water restrictions require a separately verified authority/lifecycle. |
| snow-ice | Blocked MeteoAlarm positive geometry/lifecycle; Met Office national remit includes snow and ice. No warning inferred from forecast snow alone. |
| avalanche | SAIS specialist blocked pending reusable winter positive/validity/region fixtures; six Scottish forecast areas only. Official SAIS link-only. Other GB destinations remain unmonitored, not inapplicable. |
| coastal | Blocked exact coastal-warning geometry/lifecycle. Marine forecasts are context only; weather rain/wind warnings do not prove storm-surge/coastal warning coverage. |
| civil-unrest | Blocked national scored route: no verified anonymous structured event, exact area, validity and withdrawal contract. No general news/discovery feed promoted to official monitoring. |
| security | FCDO foreign-travel-advice route excluded for GB: it has no foreign advice page for the home country. National scored security route blocked pending exact official structured contract; no substitute foreign country. |
| terrorism | Blocked national scored route: no verified anonymous local warning lifecycle/geometry. Whole-country foreign travel advice, where available, is security context only, not a terrorism alert feed. |
| armed-conflict | Blocked national scored route: no verified anonymous local warning lifecycle/geometry. Shared discovery and travel advice cannot establish armed-conflict monitoring. |
| industrial | Blocked national warning route. CEMS may provide bounded mapping-activation context after country/completeness gates; AOI is an analysis area, not confirmed hazardous extent. |
| nuclear | Blocked national warning route: exact anonymous emergency notice, area, validity and withdrawal unverified. No eligibility inferred from a radiation-network directory or absence of notices. |
| civil-emergency | Blocked national warning route: no complete structured lifecycle/area contract. Conditional CEMS mapping context requires country/completeness gates and is not civil-warning coverage. |

### United Kingdom: seven condition categories

| Condition | Source role, disposition and exact remaining gate |
|---|---|
| weather | Conditional shared Open-Meteo forecast eligibility for every candidate; preserve hourly units/time/null validation, grid/terrain representativeness and free-service noncommercial/use limits. Not observations or warnings. |
| air-quality | Conditional shared Open-Meteo/CAMS modeled AQ eligibility for every candidate; source date/grid/null handling and access terms required. Never promote to station-observed coverage. |
| marine | Conditional only for frozen representative coastal/offshore sample mappings. The new50 offshore successes across the expansion do not approve the13 previously null GB/NO/IS destinations listed above. Explicit suitability/retest still required; inland excluded from marine product, not coastal hazard applicability. |
| airport-observation | AWC METAR blocked until exact ICAO observing station, operating identity, freshness and distance/terrain representativeness are frozen. Nearest airport alone is insufficient. |
| hydrology | Scotland SEPA anonymous KiWIS candidate blocked on quota-safe station/series/units/datum/quality mapping; registered route excluded. England EA observation mapping needs its own station contract. Wales/NI not inherited. No stage-to-flood severity inference. |
| transport | Traffic Wales RSS candidate blocked on severe disruption positive/time/reopening mapping (retained congestion excluded). TrafficwatchNI RSS candidate blocked on nonempty event/lifecycle. England/Scotland official traffic pages link-only; keyed routes excluded. |
| utilities | Link-only scoped network operators: Powercut105 directory for Great Britain; NIE Networks separately for NI. Runtime blocked on service-area, active/restored IDs and redistribution; no national feed claimed. |

### Norway: 20 hazards

| Hazard | Source role, disposition and exact remaining gate |
|---|---|
| severe-weather | Conditional national Metalerts candidate: explicit land-warning CAP geometry, Alert/Update/Cancel, identifying UA/cache rules and bounded redirects required. Retained MeteoAlarm polygons are marine gales and do not prove land monitoring. |
| flood | NVE flood candidate blocked pending positive/revised warning, municipality mapping, offset-free time interpretation and unassessed0 handling. Current empty sample does not prove no risk. GFM/CEMS context separately gated. |
| extreme-heat | Blocked country/transport-specific heat-warning capability and positive contract; no inference from modeled temperature or general MET warning presence. |
| extreme-cold | Blocked country/transport-specific cold-warning capability and positive contract; general warnings/forecasts are insufficient. |
| wildfire | Conditional shared eligibility: keyless EFFIS satellite evidence; EONET context after query/release gates. Neither establishes national wildfire-warning coverage. CEMS mapping context additionally needs country and completeness gates. National warning/restriction route blocked: exact geometry, severity and withdrawal contract unverified. |
| fire-danger | Conditional EFFIS forecast eligibility for five outdoor destinations only, valid pixels required; other15 excluded from this adapter type policy. MET forestFire danger must be kept distinct from active wildfire. |
| air-quality | Conditional modeled EEA raster eligibility:20/20 valid candidate samples reported by parent. Preserve source age, valid-cell/quality rules and expanded eligibility; one successful raster is not uninterrupted availability. Modeled AQ remains separate context. |
| earthquake | Conditional shared eligibility for every candidate: USGS reported earthquakes/ShakeMap; EMSC preliminary fallback only. Freeze expanded schema/eligibility and new-coordinate tests; no claim of complete small-earthquake detection. |
| volcano | Conditional EONET context eligibility only after query/release gates. No national ground-warning/restriction activation from global context; current polygons and authoritative validity/withdrawal gate remains. |
| drought | Conditional EDO agricultural/ecosystem context; exact valid centroid cell and source product date required. No-data is unavailable. Local water restrictions require a separately verified authority/lifecycle. |
| snow-ice | Metalerts/MeteoAlarm candidate blocked on exact snow/ice type and land geometry/lifecycle evidence; marine gale fixture is insufficient. |
| avalanche | NVE candidate blocked on exact forecast-region/terrain mapping, offset-free time semantics and real bulletin vs RegId0/DangerLevel0 synthetic rows. Preserve full bulletin and expiry. Mainland roster excludes Svalbard/Jan Mayen locations, not those source capabilities. |
| coastal | Positive marine gale CAP/Atom polygons support marine-only candidate; cache/lifecycle and destination applicability gate remains. Exclude marine-only gale from land warnings; it does not establish storm-surge coverage. |
| civil-unrest | Blocked national scored route: no verified anonymous structured event, exact area, validity and withdrawal contract. No general news/discovery feed promoted to official monitoring. |
| security | Conditional FCDO whole-country travel-advice context, supported verified Norway slug; preserve source timestamp and two-hour validity. Does not establish national/local security warning coverage. |
| terrorism | Blocked national scored route: no verified anonymous local warning lifecycle/geometry. Whole-country foreign travel advice, where available, is security context only, not a terrorism alert feed. |
| armed-conflict | Blocked national scored route: no verified anonymous local warning lifecycle/geometry. Shared discovery and travel advice cannot establish armed-conflict monitoring. |
| industrial | Blocked national warning route. CEMS may provide bounded mapping-activation context after country/completeness gates; AOI is an analysis area, not confirmed hazardous extent. |
| nuclear | Blocked national warning route: exact anonymous emergency notice, area, validity and withdrawal unverified. No eligibility inferred from a radiation-network directory or absence of notices. |
| civil-emergency | Blocked national warning route: no complete structured lifecycle/area contract. Conditional CEMS mapping context requires country/completeness gates and is not civil-warning coverage. |

### Norway: seven condition categories

| Condition | Source role, disposition and exact remaining gate |
|---|---|
| weather | Conditional shared Open-Meteo forecast eligibility for every candidate; preserve hourly units/time/null validation, grid/terrain representativeness and free-service noncommercial/use limits. Not observations or warnings. |
| air-quality | Conditional shared Open-Meteo/CAMS modeled AQ eligibility for every candidate; source date/grid/null handling and access terms required. Never promote to station-observed coverage. |
| marine | Conditional only for frozen representative coastal/offshore sample mappings. The new50 offshore successes across the expansion do not approve the13 previously null GB/NO/IS destinations listed above. Explicit suitability/retest still required; inland excluded from marine product, not coastal hazard applicability. |
| airport-observation | AWC METAR blocked until exact ICAO observing station, operating identity, freshness and distance/terrain representativeness are frozen. Nearest airport alone is insufficient. |
| hydrology | NVE HydAPI authenticated observation route excluded; flood-warning API does not supply station-level observations. Alternative anonymous route blocked until independently verified. |
| transport | Documented Vegvesen DATEX access-ordering route excluded; public road map link-only. No credentials requested or national incident coverage inferred. |
| utilities | Elvia regional outage page link-only; bounded operator area and omission of some low-voltage faults matter. Runtime blocked on exact active/restored structured IDs, geometry and reuse. |

### Iceland: 20 hazards

| Hazard | Source role, disposition and exact remaining gate |
|---|---|
| severe-weather | MeteoAlarm candidate: saved IS010 Southeast Iceland polygon proves wind-alert geography. Inline polygon support and lifecycle tests needed; one southeastern sample does not establish every destination/type mapping. |
| flood | Blocked national anonymous structured flood warning contract and positive geometry/lifecycle. Generic IMO weather directory is insufficient. GFM corroboration/CEMS mapping are separately gated context. |
| extreme-heat | Blocked exact country/transport hazard capability; no inference from forecast temperature or a wind-only fixture. |
| extreme-cold | Blocked exact country/transport cold-warning capability/geometry/lifecycle; wind-only fixture insufficient. |
| wildfire | Conditional shared eligibility: keyless EFFIS satellite evidence; EONET context after query/release gates. Neither establishes national wildfire-warning coverage. CEMS mapping context additionally needs country and completeness gates. National warning/restriction route blocked: exact geometry, severity and withdrawal contract unverified. |
| fire-danger | Conditional EFFIS forecast eligibility for two outdoor destinations only with valid samples; other10 excluded from adapter type policy. Glaciated/terrain no-data must remain unavailable. |
| air-quality | Conditional modeled EEA raster eligibility:12/12 valid candidate samples reported by parent. Preserve raster source age and valid-cell semantics; Open-Meteo modeled AQ is a separate condition. |
| earthquake | Conditional shared eligibility for every candidate: USGS reported earthquakes/ShakeMap; EMSC preliminary fallback only. Freeze expanded schema/eligibility and new-coordinate tests; no claim of complete small-earthquake detection. |
| volcano | IMO current ground hazard/VALS and restrictions link-only; scored route blocked on post-June2026 geometry and validity/withdrawal authority. Aviation-color API excluded from scored ground warnings. EONET remains conditional global context only. |
| drought | Conditional EDO agricultural/ecosystem context; exact valid centroid cell and source product date required. No-data is unavailable. Local water restrictions require a separately verified authority/lifecycle. |
| snow-ice | Blocked positive country/transport snow/ice alert geometry/lifecycle; do not infer from the retained wind CAP or forecast snow. |
| avalanche | IMO new five-region gottvedur service link-only; automation blocked on new-site winter/off-season fixtures, region geometry, rating/no-rating and validity. Previous direct403 is an access limitation, not hazard absence. |
| coastal | Blocked positive coastal-specific warning contract/geography; marine forecast is context, wind CAP alone does not establish surge/wave warnings. |
| civil-unrest | Blocked national scored route: no verified anonymous structured event, exact area, validity and withdrawal contract. No general news/discovery feed promoted to official monitoring. |
| security | Conditional FCDO whole-country Iceland advice context using verified slug and two-hour validity; no local security warning coverage inferred. |
| terrorism | Blocked national scored route: no verified anonymous local warning lifecycle/geometry. Whole-country foreign travel advice, where available, is security context only, not a terrorism alert feed. |
| armed-conflict | Blocked national scored route: no verified anonymous local warning lifecycle/geometry. Shared discovery and travel advice cannot establish armed-conflict monitoring. |
| industrial | Blocked national warning route. CEMS may provide bounded mapping-activation context after country/completeness gates; AOI is an analysis area, not confirmed hazardous extent. |
| nuclear | Blocked national warning route: exact anonymous emergency notice, area, validity and withdrawal unverified. No eligibility inferred from a radiation-network directory or absence of notices. |
| civil-emergency | Blocked national warning route: no complete structured lifecycle/area contract. Conditional CEMS mapping context requires country/completeness gates and is not civil-warning coverage. |

### Iceland: seven condition categories

| Condition | Source role, disposition and exact remaining gate |
|---|---|
| weather | Conditional shared Open-Meteo forecast eligibility for every candidate; preserve hourly units/time/null validation, grid/terrain representativeness and free-service noncommercial/use limits. Not observations or warnings. |
| air-quality | Conditional shared Open-Meteo/CAMS modeled AQ eligibility for every candidate; source date/grid/null handling and access terms required. Never promote to station-observed coverage. |
| marine | Conditional only for frozen representative coastal/offshore sample mappings. The new50 offshore successes across the expansion do not approve the13 previously null GB/NO/IS destinations listed above. Explicit suitability/retest still required; inland excluded from marine product, not coastal hazard applicability. |
| airport-observation | AWC METAR blocked until exact ICAO observing station, operating identity, freshness and distance/terrain representativeness are frozen. Nearest airport alone is insufficient. |
| hydrology | Blocked exact anonymous station/series observation contract, units/datum/quality and representative mapping; no substitution from flood/volcano warning products. |
| transport | IRCA road JSON conditional candidate: positive segment/point fixtures; freeze geometry join, severe/unpassable codes, observation vs export time, reopening/expiry/duplicate handling. Unknown/not-serviced is not passable. |
| utilities | Veitur defined-network notices link-only, not all Iceland; runtime blocked on structured active/planned/completed lifecycle, service areas, pagination and reuse. |


### IS final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: is-grindavik, is-hofn, is-vestmannaeyjar, is-vik-i-myrdal. Unsupported coastal mappings: is-akureyri, is-isafjordur, is-keflavik, is-reykjavik. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### NO final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: no-bodo, no-lofoten, no-oslo, no-svolvaer, no-trondheim. Unsupported coastal mappings: no-alesund, no-alta, no-andalsnes, no-bergen, no-flam, no-geiranger, no-kirkenes, no-kristiansand, no-narvik, no-stavanger, no-tromso. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### GB final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: gb-aberdeen, gb-brighton, gb-bushmills, gb-cardiff, gb-edinburgh, gb-isle-of-skye, gb-pembrokeshire-coast-national-park, gb-plymouth. Unsupported coastal mappings: gb-belfast, gb-derry, gb-inverness, gb-liverpool, gb-newcastle-upon-tyne, gb-orkney-islands, gb-portsmouth, gb-shetland-islands, gb-swansea. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).
