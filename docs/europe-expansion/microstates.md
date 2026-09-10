# WORK-53 microstate source assessment

Reviewed 2026-09-08. These are inactive source dispositions for Andorra, Liechtenstein, Monaco, San Marino and Vatican City. A blocked transport is not evidence that a hazard is impossible. All runtime activation still requires the shared contract, mapping, fixture and rollout gates.

## National and specialist decisions

### Andorra

MeteoAlarm's retained Atom sample contains twelve polygon-bearing entries across three named areas, demonstrating storms and high temperature. Use actual validated CAP polygons, not neighboring French/Spanish warnings or guessed administrative regions. The current parser ignores those polygons. Review all five local footprints, coordinate order and lifecycle before granting partial support. Other weather categories need their own emitted-capability evidence. See the separate MeteoAlarm mapping review and https://www.meteo.ad/en/Alerts . The advertised national JSON service requires an application and is excluded: https://www.meteo.ad/json .

The official avalanche bulletin https://www.meteo.ad/estatneu/general is seasonal HTML/PDF context. Reviewed summer notice and regional bulletin validity are different products; an absent winter bulletin is not an all-clear. Runtime extraction is excluded; a separately licensed structured bulletin with exact region, altitude/aspect, validity and full information would reopen the integration decision.

https://www.mobilitat.ad/totes-incidencies is a useful official road-information link. It combines Andorran notices and separate Catalan/international incidents. The September8 holiday road closure and multi-month construction notices have different validity. No reviewed anonymous incident-data endpoint/reuse and complete cancellation/reopening contract was established. Do not ingest the Catalan section as Andorran jurisdiction or routine works as major disruption. https://www.feda.ad/ and its public office portal advertise planned power cuts, but the supplier/service area and individual planned schedule are not a national live outage feed. Do not use customer accounts or infer unplanned failures from maintenance.

### Liechtenstein

MeteoSwiss's hazard map explicitly covers Liechtenstein: https://www.meteosuisse.admin.ch/meteo/dangers/carte-des-alertes.html . Its open-data terms require attribution and prompt, unchanged warning presentation: https://opendatadocs.meteoswiss.ch/general/terms-of-use . The general open-data catalog is not itself a verified warning endpoint. Block automatic warning ingestion until the precise structured product, regions, lifecycle and compliant presentation are implemented; no silent use of the Swiss country partition.

SLF explicitly covers Liechtenstein in its avalanche bulletin: https://www.slf.ch/en/services-and-products/avalanche-bulletin/ . This is a stronger candidate than neighboring-country inference. Its documented anonymous CAAML and warning-region APIs are linked from https://www.slf.ch/en/services-and-products/slf-data-service/ ; region3311 is named Liechtenstein in https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/print-versions-avalanche-bulletin/ . The existing adapter already consumes CAAML but filters CH. Malbun is the candidate mountain/resort location; Vaduz and Schaan must not inherit mountain danger from a country-wide code. Independent review subsequently verified a winter bulletin polygon intersects Malbun and retains the upstream CH-3311 identifier. Activation still requires seasonal presentation and regression checks; see the separate SLF review. Preserve bulletin times, danger/no-rating and terrain/aspect information with SLF attribution; no duplicate upstream collection is needed.

Alertswiss's official FAQ explicitly limits its reports to Switzerland and Liechtenstein and distinguishes alert, warning and information: https://www.alert.swiss/en/faq.html . This establishes jurisdiction, not a redistributable machine-feed contract. The repository's existing Swiss source is already blocked on an undocumented production reader. Retain the official link for civil protection and utility disruption context; publisher-selected notices are not exhaustive utility availability. Separate issuer geometry from the app's approximate border push-notification radius.

### Monaco

The government has its own weather-alert framework covering wind, rain, waves/floods, snow/ice and temperature extremes: https://journaldemonaco.gouv.mc/en/Journaux/2022/Journal-8576/Ordonnance-Souveraine-n-9.071-du-28-janvier-2022-relative-a-la-securite-des-biens-et-des-personnes-en-cas-d-evenements-meteorologiques-majeurs . This proves a local framework, not that the French Alpes-Maritimes partition applies automatically. The retained source record also links Monaco's July20 drought decision with termination by superseding publication. Legal notices are linked context; no runtime HTML/PDF extraction or current-state inference from archive presence.

CAM publishes local bus disruption information, for example https://www.cam.mc/nos-actualites/travaux-refection-des-enrobes-perturbations . Keep dated notices linked rather than treating an old diversion as active. A dataset describing Monaco GTFS-Realtime service alerts exists at https://www.data.gouv.fr/datasets/donnees-temps-reel-de-circulation-des-bus-de-monaco-via-le-reseau-cam but its page explicitly marks access restricted/authorization required. That route is excluded and makes zero requests. Static timetable/vehicle-position data is not a major disruption signal. SMEG identifies itself as Monaco's electricity/gas distributor: https://www.smeg.mc/smeg ; https://www.smeg.mc/faq describes procedures and contingency arrangements, not an active outage feed. Link only until exact public incident IDs, restoration, service geography and reuse are established.

### San Marino

Civil-protection ordinances are official local context: https://www.gov.sm/pub1/GovSM/Circolari-e-Ordinanze/Ordinanze-Protezione-Civile.html . A reviewed2026 ordinance explicitly says San Marino is included in the Emilia-Romagna warning system and cites areasA2/B1 for a particular wind alert. The national review record retains the exact ordinance URL. This is useful cross-border authority evidence but does not establish every hazard, current warning, or permanent destination-region equivalence. Block ingestion until a current structured product and exact applicable area/version are verified; do not merely assign the Italy country partition.

AASS is the official utility/public-service contact: https://www.aass.sm/site/home/contatti.html . Emergency contact details and service regulations do not establish a live feed of power, water, gas or transit disruptions. Keep the operator link; a future route requires explicit planned/active/restored state, timestamps, exact affected locations, completeness and reuse. No Italy-wide utility or road status is inherited.

### Vatican City

The Governorate's Directorate of Security and Civil Protection includes the Gendarmerie and Fire Brigade with its own territorial responsibilities: https://vaticanstate.va/en/directorates/directorate-of-security-and-civil-protection-services.html . Use this official information link. No reusable anonymous current-warning, transport-disruption or utility-incident contract was established. Italian/Lazio warnings need explicit Vatican applicability, not a radius crossing Rome. Rome airport observations likewise require representative measurement mapping and must remain airport context. The proposed Vatican FCDO path returned404 in the retained probe; do not substitute Italy. Shared global environmental or seismic geometry is a separate reviewed source contract.

## All twenty hazard dispositions

A = shared-provider eligibility candidate, subject to separately documented tests and local mapping; B = blocked named integration with the gates above; L = official information only; E = excluded named use, never a claim of hazard impossibility. EEA here means the existing modeled AQI raster, not a local station observation. Every row remains publicly not_monitored until approved runtime activation.

| Hazard | AD | LI | MC | SM | VA |
|---|---|---|---|---|---|
| severe-weather | B MeteoAlarm polygon/lifecycle; L national alerts | B MeteoSwiss transport/presentation; L map | L local government weather alerts | B current Emilia-Romagna jurisdiction/product; L civil protection | L Governorate; B exact local warning jurisdiction |
| flood | L national alerts; B emitted flood capability | L natural-hazard map; B distinct flood authority/product | L local weather framework; B structured flood warning | L civil protection; B explicit flood jurisdiction/product | L Governorate; B local warning contract |
| extreme-heat | B positive MeteoAlarm polygons/lifecycle | B MeteoSwiss warning product | L local weather framework | L civil protection; B current heat product | L Governorate; B local warning contract |
| extreme-cold | L national alerts; B emitted MeteoAlarm capability | B MeteoSwiss warning product | L local weather framework | L civil protection; B current cold product | L Governorate; B local warning contract |
| wildfire | L civil protection; shared satellite context only | L Alertswiss; shared satellite context only | L government; shared satellite context only | L civil protection; shared satellite context only | L Governorate; shared satellite context only |
| fire-danger | A EFFIS for2 reviewed outdoor locations, valid pixels | A EFFIS for Malbun only, valid pixel | E outdoor-only EFFIS for city roster | E outdoor-only EFFIS for city roster | E outdoor-only EFFIS for city roster |
| air-quality | B fresh EEA raster eligibility | B fresh EEA raster eligibility | B fresh EEA raster eligibility | B fresh EEA raster eligibility | B fresh EEA raster eligibility |
| earthquake | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC | A USGS/EMSC |
| volcano | B national warning contract unverified; global context only | B national warning contract unverified; global context only | B national warning contract unverified; global context only | B national warning contract unverified; global context only | B national warning contract unverified; global context only |
| drought | A EDO agricultural context, valid pixel; L national | A EDO agricultural context, valid pixel; L official | L government drought decision; A EDO context if valid | A EDO context if valid; L official | A EDO context if valid; L official |
| snow-ice | L national alerts; B emitted MeteoAlarm capability | B MeteoSwiss warning product | L local weather framework | L civil protection; B current snow/ice product | L Governorate; B local warning contract |
| avalanche | L seasonal national bulletin; B structured product | B SLF Malbun seasonal/regression checks (geometry verified) | E unreviewed mountain provider for city roster | E unreviewed mountain provider for city roster | E unreviewed mountain provider for city roster |
| coastal | E marine provider for inland roster | E marine provider for inland roster | L local wave-submersion framework; B structured warnings | E marine provider for inland roster | E marine provider for inland roster |
| civil-unrest | L FCDO; E incident scoring from advice prose | L FCDO; E incident scoring from advice prose | L FCDO; E incident scoring from advice prose | L FCDO; E incident scoring from advice prose | L Governorate; E invented Italy advice mapping |
| security | A verified FCDO country path, whole-country rule only | A verified FCDO country path, whole-country rule only | A verified FCDO country path, whole-country rule only | A verified FCDO country path, whole-country rule only | B unsupported FCDO path; L Governorate |
| terrorism | L FCDO/national; B active incident contract | L FCDO/Alertswiss; B active incident contract | L FCDO/government; B active incident contract | L FCDO/civil protection; B active incident contract | L Governorate; B active incident contract |
| armed-conflict | L advice; B active incident/extent contract | L advice; B active incident/extent contract | L advice; B active incident/extent contract | L advice; B active incident/extent contract | L Governorate; B active incident/extent contract |
| industrial | L civil protection; B licensed active bulletin | L Alertswiss; B licensed machine reader | L government; B licensed active bulletin | L civil protection; B licensed active bulletin | L Governorate; B licensed active bulletin |
| nuclear | L civil protection; E deriving alert from radiation data | L Alertswiss; E deriving alert from radiation data | L government; E deriving alert from radiation data | L civil protection; E deriving alert from radiation data | L Governorate; E deriving alert from radiation data |
| civil-emergency | L civil protection; B current structured bulletin | L Alertswiss; B licensed machine reader | L government; B current structured bulletin | L civil protection; B current structured bulletin | L Governorate; B current structured bulletin |

Shared CEMS country-name matching remains blocked until explicit new-country aliases are implemented and tested; its mapping AOI is context, not proof of impact. GFM flood raster acquisition/time semantics remain separately blocked. Neither changes these national-warning dispositions. The retained EEA probe returned valid modeled raster samples for all12 microstate candidates, but one sample does not prove enduring completeness or a station measurement; preserve no-data and freshness gates. Microstate pixels/forecast cells can include neighboring territory without granting neighboring official warning jurisdiction.

## All seven conditions dispositions

| Condition | AD | LI | MC | SM | VA |
|---|---|---|---|---|---|
| weather | A Open-Meteo5points; terrain labels | A Open-Meteo3points; terrain labels | A Open-Meteo1point | A Open-Meteo2points | A Open-Meteo1point |
| air-quality | A modeled Open-Meteo5 | A modeled Open-Meteo3 | A modeled Open-Meteo1 | A modeled Open-Meteo2 | A modeled Open-Meteo1 |
| marine | E inland roster | E inland roster | B exact representative offshore cell/freshness | E inland roster | E inland roster |
| airport-observation | B operational/relevant station and terrain mapping | B operational/relevant station and terrain mapping | B cross-border measurement representativeness | B Rimini altitude/distance representativeness | B Rome station distance/representativeness |
| hydrology | L national; B station/river/datum/time contract | L official; B station/river/datum/time contract | L government; B relevant local station contract | L official; B local station contract | L official; B local river/station contract |
| transport | L Mobilitat; B data/lifecycle/segment/reuse | L official travel information; B current local incident contract | L CAM; E restricted GTFS-RT route | L AASS; B current local incident contract | L Governorate; B current local incident contract |
| utilities | L FEDA; B schedule/service-area/reuse | L Alertswiss/operator information; B incident/service-area/reuse | L SMEG; B incident/service-area/reuse | L AASS; B incident/service-area/reuse | L Governorate; B local incident/reuse |

Validation: retained dossier/fixture inspection and bounded primary-source web research. No new runtime transport or country activated. Independent SLF geometry review passed for the winter fixture; unrated seasonal behavior and activation regressions remain unverified.


### AD final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### LI final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### MC final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: mc-monaco. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### SM final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).


### VA final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: none. Unsupported coastal mappings: none. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).
