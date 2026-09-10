# WORK-53 independent MD/BY source assessment

Reviewed 2026-09-08, read-only. Verdict: correct with caveats for a non-activating dossier; national automated coverage is not ready. This assessment supplies concrete dispositions, not a claim that every hazard has a national feed. No repository/Pad edits, credentials, outreach, or retained linked Belarus CAP bodies.

Grain: each hazard disposition is country × hazard eligibility; actual alerts must remain issuer × alert identifier × affected geometry × validity interval. Conditions are destination × observation/forecast series. A national website, country name, publication date, or successful empty index cannot substitute for a local valid observation or an active alert.

## National source records

### MD meteo/hydro: official-link, structured activation blocked

Authority now identifies itself as Autoritatea de Meteorologie și Monitoring de Mediu (AMM): https://www.meteo.md/ ; meteorological warnings https://www.meteo.md/index.php/ro/weather/current-warnings ; hydrological warnings https://www.meteo.md/index.php/ro/hydrological/current-warnings . The forecast centre's remit includes meteorological and hydrological warnings: https://www.meteo.md/index.php/despre-noi/centrul-de-prognoze-i-avertizri/ . Public HTML/PDF/maps are available without accounts. No documented anonymous national CAP/JSON lifecycle or redistribution licence was established in the bounded read.

Current page contains a September 6 wind warning with an explicit 11:00–18:00 validity interval; leaving it on the page after expiry does not make it active on September 8. It also distinguishes vegetation ignition danger from active fires. A future adapter needs exact issue/start/end timezone interpretation, multilingual ID/update/cancel semantics, geometry/region identifiers, completeness/pagination, and explicit reusable payload terms. HTML archive order is not an expiry policy.

Meteoalarm is a separate candidate: saved `tests/fixtures/europe-expansion/md-meteoalarm.xml`, SHA256 5813ac1ecd9a47870a2c678a46ff339fd8c3ac60182c66906d355d04ee077979, HTTP200, 986 bytes, updated 2026-09-08T15:35:07.503959Z, zero entries. Exact anonymous route: https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-moldova . This proves transport/empty-feed parsing only. It cannot validate region-to-destination joins or claim all Meteoalarm event types are emitted for MD. Keep positive CAP/geography/lifecycle acceptance gates, especially Tiraspol/Bender jurisdiction, separate from transport.

### MD civil emergency: official-link

https://igsu.gov.md/ro is the official Inspectoratul General pentru Situații de Urgență public HTML site. Current content mixes emergency notices, prevention, completed responses, and unrelated news; a September 6 wind item refers to the same expired AMM interval. Do not treat every article as an ongoing civil emergency. Before ingestion: exact event class, affected area, action/validity, stable ID, correction/withdrawal, list completeness, and reuse must be proven. No anonymous structured current emergency route was verified; this is a bounded evidence gap, not a conclusion that no source exists.

### MD utilities: official-link with operator scope

Verified primary routes: https://premierenergydistribution.md/ro/toate-lucrarile-programate and https://rednord.md/deconectari-2d . The former publishes scheduled works with addresses and time windows; the latter is a weekly document index including September 7–13, 2026. Use distribution operators rather than the similarly named energy supplier. Quarterly quality reports and energy-saving requests are not live outages. Do not assign either operator to all MD destinations, particularly Tiraspol/Bender, without service-area evidence. Ingestion gates: exact address/area match, planned versus unplanned semantics, local timezone, supersession/cancellation, update time, full pagination/document inventory, and reuse. No numeric availability/operational outage status can be inferred from a successful page load.

### MD transport: official-link

Canonical official site confirmed through its own links: https://www.andsa.md/ (S.A. Administrația Națională a Drumurilor). Its public map https://harta.asd.md/ supports road-index/kilometre segment queries and labels accident information preliminary. The map is not thereby a current disruption feed. HTML restriction notices are possible evidence leads, but no documented anonymous structured alert route, licence, current-state completeness or reopening contract was verified. Need exact road segment, direction, passenger-vehicle applicability, restriction severity, start/end and cancellation. Exclude routine works from hazard events under the current contract.

### BY CAP: blocked; index permission does not license linked CAP

WMO authority record https://alertingauthority.wmo.int/authorities.php?recId=15 identifies Belhydromet and OID 2.49.0.0.112.0, lists Met/Fire/Env/CBRNE categories and the feed route https://meteoalert.meteoinfo.ru/belarus/cap-feed/en/atom.xml . Registry categories do not establish an emitted vocabulary, and its blank alerting-area field cannot supply geometry. Registry language labels are inconsistent with route suffixes; inspect each CAP info.language, not the registry label.

Existing dossier has index HTTP200 and metadata-only positive Alert/Update probes, including BYSTD1/2 identifiers, polygons and -00:00 timestamps. Keep those observations attributed to the earlier probe, not newly reproduced here. Retained index fixture is `tests/fixtures/europe-expansion/belarus-cap.xml`; linked bodies remain excluded pending payload reuse. The gate text saying public-domain feed rights were captured must expressly distinguish the index from linked bulletins. Other required gates: allowlisted detail host/path and bounded fanout, complete versus truncated index semantics, exact event vocabulary, polygon tests at the eight destinations, Alert/Update/Cancel/reference replay, expiration and future-onset behavior, and UTC -00:00 handling. Do not claim legal redistribution from WMO registration or anonymous availability.

Official public-facing authority link: https://pogoda.by/ . Web extraction returned no body; no alternative API contract established.

### BY emergency: blocked ingestion; official-link fallback

Primary URL https://mchs.gov.by/ and discovered daily-summary path https://mchs.gov.by/operativnaya-informatsiya/sutochnye-svodki-mchs/v-rb/ timed out in bounded web reads. This is a probe limitation, not evidence of upstream permanent outage or absent service. Daily historical incident summaries would still need active-versus-resolved discrimination, geometry/validity/lifecycle, pagination and reuse before alert ingestion. Do not substitute Russian mchs.gov.ru results; they have different jurisdiction and licensing.

### BY transport: verified official-link, structured contract blocked

Primary https://beldor.centr.by/ redirects to https://beldor.centr.by/en/ and directly links public operational road-weather https://i.centr.by/inforoads/ru/dises/ and repairs https://i.centr.by/inforoads/ru/repairs . Both returned anonymous HTML application shells; the officially linked https://i.centr.by/inforoads-light returned HTTP503. Thus there IS a specific official service, not merely a generic ministry homepage. No exact data API or reuse/completeness contract was established. Do not treat heavy-axle seasonal restrictions as passenger-road closure or repairs as hazard. Need data endpoint, per-record time and segment, direction/vehicle scope, cancel/reopen and pagination fixtures before activation.

### BY utilities: verified official-link, structured contract blocked

https://web.minskenergo.by/grafik-planovyh-otklyuchenij-elektroenergii/ provides public settlement/address lookup plus an all-outages link. The latter https://web.minskenergo.by/grafik-planovyh-otklyuchenij-elektroenergii/grafik-planovyh-otklyuchenij-elektroenergii/ rendered no extractable outage rows in this read; do not interpret as zero outages. https://web.minskenergo.by/grafik-otklyucheniya-goryachego-vodosnabzheniya/ is a monthly hot-water schedule (latest rendered August). Scheduled works can change; it is not current unplanned electricity failure. No account needed for these pages, but no public data/reuse contract established. Operator scope is not all Belarus. Need exact service areas/destination joins, address geometry, utility type, timestamps, planned/cancelled semantics and complete data transport. https://www.belenergo.by/ timed out; no national aggregation inferred.

## All 20 hazard dispositions

Codes: A = existing shared-provider eligibility acceptable subject to its separately reviewed activation tests; L = official-link only; B = specific automated contract blocked; E = exclude the named candidate from this use, not declare hazard impossible. Public coverage remains not_monitored until implementation/verification.

| Hazard | Moldova | Belarus |
|---|---|---|
| severe-weather | L AMM; B positive Meteoalarm CAP/region contract | L pogoda; B linked-CAP reuse/lifecycle/geography |
| flood | L AMM hydro/IGSU; B Meteoalarm regions and CEMS new-country names/GFM acquisition contract | L pogoda/MChS; B CAP flood vocabulary plus common CAP gates; CEMS/GFM gates |
| extreme-heat | L AMM; B positive Meteoalarm hazard/region evidence | L pogoda; B CAP exact vocabulary and common gates |
| extreme-cold | L AMM; B positive Meteoalarm hazard/region evidence | L pogoda; B CAP exact vocabulary and common gates |
| wildfire | L IGSU; E AMM ignition-danger notices as active wildfire; shared satellite context only | L MChS/pogoda; B actual fire CAP vocabulary/rights; shared satellite context only |
| fire-danger | L AMM; E current EFFIS outdoor-only eligibility (all MD candidates are cities) | L pogoda; E current EFFIS outdoor-only eligibility (all BY candidates are cities) |
| air-quality | B EEA modeled-AQI raster: 0/8 valid samples in bounded probe, not permanent exclusion; national observations AMM link only | B EEA modeled-AQI raster: 0/8 valid samples in bounded probe, not permanent exclusion; national observations pogoda link only |
| earthquake | A USGS, EMSC fallback; no extra national coverage credit | A USGS, EMSC fallback; no extra national coverage credit |
| volcano | B national contract unverified; retain not_monitored; imported ash impacts are not ruled out | B national contract unverified; retain not_monitored; imported ash impacts are not ruled out |
| drought | A EDO agricultural context with valid-cell semantics; L AMM | A EDO agricultural context with valid-cell semantics; L pogoda |
| snow-ice | L AMM; B positive Meteoalarm vocabulary/regions | L pogoda; B CAP vocabulary and common gates |
| avalanche | E unproven Meteoalarm national event eligibility; not_monitored | E no reviewed national avalanche provider; not_monitored |
| coastal | E marine coastal provider for landlocked roster; river/lake flooding stays flood | E marine coastal provider for landlocked roster; river/lake flooding stays flood |
| civil-unrest | L FCDO advice; E deriving incident flags from advice prose | L FCDO advice; E deriving incident flags from advice prose |
| security | A FCDO country eligibility, but current Transnistria-only advice remains L under whole-country parser; do not silently map whole MD | A FCDO verified whole-country all-travel advice for all eight |
| terrorism | L FCDO; B no exact licensed live incident contract | L FCDO; B no exact licensed live incident contract |
| armed-conflict | L FCDO; B regional live incident/extent/validity contract; historical statements not active event | L FCDO; B live incident contract; general risk of spread not actual local conflict |
| industrial | L IGSU; B licensed active emergency lifecycle; CEMS AOI context gate separately | L MChS; B exact industrial CAP vocabulary/rights/lifecycle; CEMS AOI context gate |
| nuclear | L IGSU/AMM; B radiation observations are not nuclear-event warnings without explicit contract | L MChS/pogoda; B WMO CBRNE category alone insufficient; no actual radiological warning contract |
| civil-emergency | L IGSU; B active-versus-completed emergency lifecycle/geometry | L MChS; B exact emergency CAP vocabulary/rights/lifecycle |

FCDO primary checks: https://www.gov.uk/foreign-travel-advice/moldova (current September 8, updated December 10, 2025; all-travel restriction applies to Transnistria) and https://www.gov.uk/foreign-travel-advice/belarus (current September 8, updated May 11, 2026; all-travel whole country). GOV.UK reuse: https://www.gov.uk/help/reuse-govuk-content . Moldova's old energy-shortage paragraph is not evidence of a current outage. Dossier has Tiraspol and Bender; their regional-advice treatment must not disappear into a generic country label.

## All seven condition dispositions (each country)

| Condition | Moldova | Belarus |
|---|---|---|
| weather | A existing Open-Meteo modeled forecast at eight verified coordinates; use saved forecast rows | A same for eight |
| air-quality | A existing modeled Open-Meteo series at eight; does not establish EEA raster coverage | A same for eight |
| marine | E these inland destinations from marine projection; no nearest-ocean substitution | E these inland destinations from marine projection |
| airport-observation | B exact operational ICAO station, country, distance and current timestamp fixtures; no nationwide airport proxy | B same; airport existence alone does not establish current METAR availability |
| hydrology | L AMM hydro warnings; B station observation route, IDs, datum/units, quality, UTC and expiry | L pogoda; B anonymous station route and identical measurement contract |
| transport | L AND/map; B segment/lifecycle/reuse contract above | L Beldorcenter operational interfaces; B data endpoint/lifecycle/reuse above |
| utilities | L two distribution schedules; B operator geography and planned/unplanned lifecycle | L Minskenergo electricity/hot-water pages; B geography and utility-specific lifecycle |

## Validation and limits

Read current dossier, existing probe metadata and shared review; bounded official page reads/searches, including click-through provenance for canonical road and utility URLs. No broad tests/build or runtime activation. Existing forecasts/probes were not all independently replayed. None of the empty HTML shells, expired notices, failed requests, or zero-entry indexes proves hazard absence. Additional retained fixtures should be synthetic unless source-body reuse is resolved; primary URL/status/title/date metadata can be recorded now. The above dispositions close source discovery decisions for this dossier while preserving explicit implementation gates.

Correction: current EEA adapter samples a modeled AQI raster, not station/pollutant observations. `/tmp/travelcanary-europe-source-probes/shared-probes.json` and `eea-candidates.json` report 100/176 valid raster samples, MD0/8 and BY0/8. These are bounded sample outcomes, not permanent geographic exclusion. Open-Meteo modeled AQ remains an independent condition source; national observations remain link-only.


### BY final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### MD final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).
