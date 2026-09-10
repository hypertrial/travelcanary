# WORK-53 independent AL/BA/XK/ME/MK/RS review

Reviewed 2026-09-08, read-only. Verdict: correct with caveats for a non-activating dossier. This closes bounded discovery decisions for all 20 hazards and seven conditions in each country. It does not assert absence of hazards or exhaustive absence of other sources. No repository/Pad changes, gated access, credentials or outreach.

Inputs reused without duplicate probes: `/tmp/travelcanary-national-source-review.json`, `/tmp/work53-meteoalarm-mapping-review.md`, `/tmp/work53-shared-provider-review.md`, current source dossier and forecast samples. Additional bounded primary page reads verified unresolved emergency, road, utility and advice links. No tests/builds or retained warning bodies.

## Contract gates used below

W: licensed anonymous structured warning transport, exact issuer/event vocabulary, source time/start/end with timezone, stable event/reference IDs, update/cancel/replay and complete-versus-partial feed semantics, authoritative affected geometry. Webpage existence or country directory membership is not destination coverage.

O: permitted structured observation transport with station/waterbody identity, exact destination distance/area, units/datum/quality, observed time versus fetched time, expiry and partial/outdated handling. Reports/annual statistics are not live observations.

T: permitted structured road incident route, authoritative segment/direction/vehicle scope and geometry, ID, start/end/reopen lifecycle, completeness/pagination; exclude routine works and ordinary traffic congestion under the existing hazard contract. HTML scraping is outside the selected ingestion policy.

U: permitted anonymous outage transport, verified operator service area and destination/address match, utility type, planned versus unplanned state, ID/update/start/end/cancellation, completeness/pagination. Customer identifiers/accounts and fault-report submissions are excluded. Scheduled maintenance is not unplanned failure or nationwide unavailability.

N: official emergency/news source remains link-only until W plus active-versus-resolved incident classification and licence are established. Preparedness guidance, meetings and response totals are not live warnings. A failed fetch does not mean no emergencies.

## Country source records and concrete decisions

### AL

Meteo/hydro: retain IGJEO official-link-only decision and existing evidence https://www.geo.edu.al/Monitorim_Parashikim/Parashikimi_Hidrologjik_dhe_Meteorologjik/Buletini_Mbi_Rreziqet_Natyrore/ . Prior primary review established publication by noon, 36-hour forecast, possible extra bulletins in dangerous episodes. Product is PDF/map/table; blocked W/O, not an anonymous structured alert feed. Rain/flood/fire danger components must remain distinct.

Emergency: https://akmc.gov.al/ is verified national civil protection. Current public HTML mixes preparedness, coordination and summer fire totals. Its August24 increasing fire-risk item is not an active-fire footprint. N gate; no structured live route proven. Authority claims do not create a redistribution licence.

Roads: reuse verified ARRSH https://www.arrsh.gov.al/situata-ne-akset-rrugore.html and https://www.arrsh.gov.al/njoftim-25.html . Dated closure/reopening prose is useful link-only information; T gate, no extraction or current-state inference from archive position.

Utilities: https://oshee.al/ and https://oshee.al/te-dhenat-e-hapura/ are public. The explicit open-data page lists energy quantities/losses, monthly generation and consumer/tariff material; it is not a live outage endpoint. Link-only, U gate for a separately documented distribution-outage service. Do not use customer portal or assume a page titled open data licenses all content.

### BA — both entities and separate service areas

Meteo/hydro: Federation https://www.fhmzbih.gov.ba/ and Republika Srpska https://rhmzrs.com/ ; prior exact hydrology evidence https://rhmzrs.com/index.php/page/hidrologija-saradnja describes extraordinary flood reports and civil-protection coordination. Entity observations/bulletins cannot be inherited by all BA destinations. MA fixture has BA001–BA010 and positive heat/wind, no polygons; authoritative warning-area crosswalk is unresolved. W requires exact provider region geometry and destination-footprint review; FHMZ web reuse restrictions do not transfer to licensed MA feed or vice versa. O gate separately for gauges.

Emergency: Federation https://fucz.gov.ba/ and https://fucz.gov.ba/category/izvjestaji/ verified public. News includes August fire-response deployments, thanks and training; no active incident set. Republika Srpska https://ruczrs.org/ timed out, while its official 2025 annual report remains indexed; no operational absence inferred. Both N, and neither supplies the other's jurisdiction. Brčko requires explicit competent-source/service-area determination, not nearest entity inheritance.

Roads: official publisher BIHAMK https://bihamk.ba/spi/stanje-na-cesti-u-bih verified public current road-condition page. Club information is not automatically a governmental warning. Link-only, T gate and explicit publisher attribution/reuse; do not assume its coverage description is a complete feed contract.

Utilities: verified EPBiH https://www.epbih.ba/eng/page/servisne-informacije planned interruption table; HZHB https://korisnicka.ephzhb.ba/ advertises next48-hour planned works; Republika Srpska regional operator https://www.elektrokrajina.com/ verified. These are distinct operators, not interchangeable national coverage. Link-only/U. No intranet/customer accounts were opened. Exact operator-to-destination assignment is still required; an entity boundary is not necessarily a distribution service boundary.

### XK — independent jurisdiction

Meteo/emergency: reuse exact official AME/IHMK sources https://ame.rks-gov.net/ , https://ame.rks-gov.net/post/al-sq/253/paralajm-rim , https://ame.rks-gov.net/post/al-sq/269/paralajm-rim-p-r-zjarre and https://ihmk-rks.net/ . Reviewed notices contain warning/prevention prose and named municipalities. Link-only W/N; no reviewed current structured ID/cancel/geometry/reuse. Do not map Serbian MA RS007 onto XK, including merely because a region label says Kosovo.

Roads: verified primary publisher https://www.kosovopolice.com/ and ministry https://www.mit-ks.net/ ; ministry current page has construction/news and public notices. Link-only; T requires an actual current incident feed, not every construction announcement. Police completed enforcement/accident reports are not ongoing road closures.

Utilities: preserve existing KEDS decision at https://www.keds-energy.com/shq/punime-ne-rrjet/njoftime-per-punime-ne-rrjet/ and https://www.keds-energy.com/shq/lajme/punimet-e-planifikuara-tani-mund-ti-gjeni-edh-121/ . Public planned-work map exists; U gate for anonymous structured endpoint/reuse/geography without customer codes. Neither Serbian source jurisdiction nor KEDS coverage may silently be assumed for every northern destination.

### ME

Meteo/hydro: https://www.meteo.co.me/ and https://www.meteo.co.me/page.php?id=165 verified; warning index links PDF notices. MA fixture positive heat/thunderstorm/wind with three custom areas ME001 Continental and Mountains, ME002 Central, ME003 Adriatic coast, no polygons. W blocks automation until exact authoritative three-zone geography/footprint boundaries are proven; labels are not boundaries, particularly mountain/coast transitions. Other hazards need transport capability evidence. O separate for station hydrology.

Emergency: https://www.gov.me/mup verified Ministry of Interior portal; N, no reviewed structured protection-and-rescue active set. A ministry homepage is an official link, not all-hazard monitoring.

Roads: https://amscg.org/ returned challenge page in bounded read; no bypass attempted. Keep official club link candidate with T gate; do not replace with syndicated press articles or claim source permanently unavailable.

Utilities: https://www.cedis.me/?post_type=exhibition is indexed with municipality/street/time scheduled works. Old dated query links may resolve to current general content; URL date text is not event time. Link-only/U with actual source-issued windows and cancellation. No SMS/email registration. Multiple intervals/temporary short cuts must not be flattened into continuous citywide outage.

### MK

Meteo: https://uhmr.gov.mk/ returned502; saved MA feed is empty. W needs positive official geometry/geocode and lifecycle evidence; feed availability/empty success does not prove warning-area mapping. Do not infer permanent outage from one failed homepage read.

Emergency: https://cuk.gov.mk/ verified current official Crisis Management Center portal. Concrete hazard: its rendered crisis/fire/flood sections repeat a March employment decision, and the Active notices link resolves to the homepage. Thus section labels/count placeholders cannot be used as active-emergency signals. Link-only/N until semantic records are independently validated. This is not evidence that there are no emergencies.

Roads: official AMSM https://amsm.mk/sostojba-na-patishta/dnevni-informacii/ verified via homepage. Public daily information and map are source links; T gate for structured transport, current versus historical restrictions and reuse. Club service is not a national CAP source.

Utilities: https://elektrodistribucija.mk/Grid/Planned-disconnections.aspx explicitly describes a map for current/future planned supply interruptions. Link-only/U; ordinary public map visibility does not prove anonymous data/API licence. Do not confuse meter-reading schedule with outages.

### RS

Meteo: primary https://www.meteoalarm.rs/eng/meteo_alarm.php and https://www.meteoalarm.rs/eng/terms_and_conditions2.pdf reviewed previously describe eleven custom geographic/administrative regions. MA saved fixture has RS001–RS011, heat, no polygons. W requires authoritative reusable region boundary/crosswalk and exact hazard capability; statistical NUTS is unproven. RS007 must not activate XK. National website terms and MA payload reuse remain distinct.

Emergency: https://www.mup.gov.rs/ redirects to https://www.mup.gov.rs/wps/portal/sr/ ; verified official ministry publisher. N; no reviewed anonymous structured active emergency product. Police/news reports cannot become unrelated current unrest/terrorism signals.

Roads: https://www.putevi-srbije.rs/index.php/sr/servisne-informacije verified current, paginated public HTML. September8 I A5 Preljina–Adrani incident14:12 is explicitly cleared16:26. Both articles remain listed. This is a positive lifecycle evidence opportunity but requires incident identity/correction matching; treating each article independently would retain a cleared obstruction. T gate; route description/direction, partial lane restriction and routine works must remain distinct.

Utilities: exact public primary https://www.elektrodistribucija.rs/planirana-iskljucenja/planirana-ns and https://elektrodistribucija.rs/planirana-iskljucenja-beograd/Dan_3_Iskljucenja.htm . Operator describes three-day planned-work notices, with date-specific regional HTML tables. Link-only/U: relative day filenames rotate and cached pages may be old, so body date is mandatory; service region plus locality/address needed. No automatic XK inheritance.

## Advice decisions, all six

All six exact FCDO pages opened successfully and remain eligible under the existing shared whole-country advice contract:
https://www.gov.uk/foreign-travel-advice/albania ; https://www.gov.uk/foreign-travel-advice/bosnia-and-herzegovina ; https://www.gov.uk/foreign-travel-advice/kosovo ; https://www.gov.uk/foreign-travel-advice/montenegro ; https://www.gov.uk/foreign-travel-advice/north-macedonia ; https://www.gov.uk/foreign-travel-advice/serbia . Keep publication timestamp/current page checks and OGL attribution. No extra national incident flags from general advice prose.

Material current correction: Kosovo page updated June10,2026 (still current September8) explicitly removes the prior all-but-essential travel advice for Zvečan, Zubin Potok, Leposavic and Mitrovica north of Ibar. Do not freeze the old restriction as current. Whole-country-only behavior and regional rejection remain regression requirements for future changes. BA's border-facility relocation and regional historic mine advice are not nationwide active armed conflict.

## All 20 hazard dispositions, each country

A denotes separately reviewed shared-provider eligibility, not activation in this report. L denotes above national official-link; B denotes the explicit gate; E excludes an unreviewed candidate from automated use, not hazard inapplicability. All public not_monitored values remain unchanged until implementation and verification.

| Hazard | AL | BA | XK | ME | MK | RS |
|---|---|---|---|---|---|---|
| severe-weather | L IGJEO/B W | L both met/B BA-region W | L IHMK/B W | L ZHMS/B3-region W | L UHMR/B positive W | L RHMZ/B11-region W |
| flood | L IGJEO/AKMC/B W,O | L both met+CP/B W,O | L IHMK/AME/B W,O | L ZHMS/MUP/B W,O | L UHMR/CUK/B W,O | L RHMZ/MUP/B W,O |
| extreme-heat | L IGJEO/B W | Positive MA heat; B mapping W | L IHMK/B W | Positive MA heat; B mapping W | L UHMR/B W | Positive MA heat; B mapping W |
| extreme-cold | L IGJEO/B W | L both met/B capability W | L IHMK/B W | L ZHMS/B capability W | L UHMR/B W | L RHMZ/B capability W |
| wildfire | L AKMC/B N | L both CP/B N | L AME/B N | L MUP/B N | L CUK/B N | L MUP/B N |
| fire-danger | L IGJEO/B W | L met/CP/B W | L IHMK/AME/B W | L ZHMS/B W | L UHMR/CUK/B W | L RHMZ/B W |
| air-quality | A EEA modeled raster | A EEA modeled raster | A EEA modeled raster | A EEA modeled raster | A EEA modeled raster | A EEA modeled raster |
| earthquake | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC |
| volcano | B national product unverified | B national product unverified | B national product unverified | B national product unverified | B national product unverified | B national product unverified |
| drought | A EDO context/L IGJEO | A EDO/L both met | A EDO/L IHMK | A EDO/L ZHMS | A EDO/L UHMR | A EDO/L RHMZ |
| snow-ice | L IGJEO/ARRSH/B W,T | L both met/BIHAMK/B W,T | L IHMK/AME/B W | L ZHMS/AMSCG/B W,T | L UHMR/AMSM/B W,T | L RHMZ/Putevi/B W,T |
| avalanche | B specific mountain bulletin W | B mountain/altitude/provider W | B independent mountain bulletin W | B mountain/altitude W | B mountain/altitude W | B mountain/altitude W |
| coastal | B actual coastal W; marine separate | B no national product; no coastal roster | E inland marine candidate | B Adriatic W; forecast separate | E inland marine candidate | E inland marine candidate |
| civil-unrest | L FCDO/B N | L FCDO/B N | L FCDO/police/B N | L FCDO/MUP/B N | L FCDO/CUK/B N | L FCDO/MUP/B N |
| security | A FCDO | A FCDO | A FCDO, old restriction removed | A FCDO | A FCDO | A FCDO |
| terrorism | L FCDO/B N | L FCDO/B N | L FCDO/police/B N | L FCDO/MUP/B N | L FCDO/B N | L FCDO/MUP/B N |
| armed-conflict | L FCDO/B N | L FCDO/B N | L FCDO/B N | L FCDO/B N | L FCDO/B N | L FCDO/B N |
| industrial | L AKMC/B N | L both CP/B N | L AME/B N | L MUP/B N | L CUK/B N | L MUP/B N |
| nuclear | B explicit radiological W/N | B entity/national radiological W/N | B independent radiological W/N | B radiological W/N | B radiological W/N | B radiological W/N |
| civil-emergency | L AKMC/B N | L both CP/B N | L AME/B N | L MUP/B N | L CUK/B N | L MUP/B N |

For fire-danger retain shared EFFIS only at exact eligible outdoor types; no blanket national eligibility. For wildfire/flood/industrial/civil emergency, shared satellite/CEMS/GFM roles and gates remain as separately reviewed; they do not license national scraping or create official warning coverage. National volcano/avalanche/nuclear products were not established by this bounded pass; none is marked hazard-impossible. EEA all six countries had valid modeled-raster samples in the supplied bounded probe; do not label them station observations or treat one success as permanent coverage health.

## All seven condition dispositions, each country

Existing source-dossier forecast counts are below; model forecasts are distinct from EEA raster and national observations.

| Condition | AL12 | BA10 | XK6 | ME8 | MK8 | RS12 |
|---|---|---|---|---|---|---|
| weather | A Open-Meteo12 | A10 | A6 | A8 | A8 | A12 |
| air-quality | A Open-Meteo12 | A10 | A6 | A8 | A8 | A12 |
| marine | A4 exact coast; E8 | E roster0 | E inland6 | A4 exact coast; E4 | E inland8 | E inland12 |
| airport-observation | B ICAO/current fixture | B ICAO/current fixture | B independent ICAO/current fixture | B ICAO/current fixture | B ICAO/current fixture | B ICAO/current fixture |
| hydrology | L IGJEO/B O | L both met/B O | L IHMK/B O | L ZHMS/B O | L UHMR/B O | L RHMZ/B O |
| transport | L ARRSH/B T | L BIHAMK/B T | L ministry/police/B T | L AMSCG/B T | L AMSM/B T | L Putevi/B T |
| utilities | L OSHEE/B U | L distinct operators/B U | L KEDS/B U | L CEDIS/B U | L DSO/B U | L EDS/B U |

Exact marine sampled/parsed destinations: AL Durrës, Himarë, Sarandë, Vlorë; ME Budva, Herceg Novi, Kotor, Ulcinj. BA has a coastline but this roster has no marine samples; never describe BA as landlocked. No nearest-ocean conversion for inland or lake destinations. Airport gate includes station country/operational status, exact proximity, report age/UTC, units and error/no-report fixture; airport existence alone is insufficient.

## Validation and residual limits

Read existing evidence and supplemented exact links with bounded official pages, including utility-specific routes, road reopening example and current FCDO Kosovo correction. No national structured product passed all gates in this pass. These decisions are ready to record as link-only/blocked/excluded candidate dispositions with reopening conditions, while shared eligibility remains subject to its independent implementation tests. They are not claims that inaccessible sources are upstream-broken, that generic news is live coverage, or that every possible national service has been exhaustively searched.


### AL final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: al-durres, al-sarande, al-vlore. Unsupported coastal mappings: al-himare. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### BA final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### XK final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### ME final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: me-ulcinj. Unsupported coastal mappings: me-budva, me-herceg-novi, me-kotor. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### MK final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### RS final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).
