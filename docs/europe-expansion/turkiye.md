# WORK-53 independent Türkiye national-source review

Reviewed 2026-09-08. Verdict: correct with caveats for a non-activating source dossier. No national automated warning source is approved here. Existing shared-provider eligibility can progress under its separate review. All Türkiye, including Asian destinations such as Van, remains in scope. No repository/Pad edits, accounts, tokens, gated requests, outreach or retained restricted warning payloads.

Grain: issuer × event ID × affected geography × validity, not country × webpage or every news article. Observation conditions require destination × measurement series with source time/quality; modeled conditions are separate.

## Completed national source decisions

### MGM MeteoUYARI — blocked

Primary documentation: https://www.mgm.gov.tr/meteouyari/meteouyari-nedir.aspx ; terms https://www.mgm.gov.tr/site/yasal-uyari.aspx ; linking/embed conditions https://www.mgm.gov.tr/site/link-vermek-icin.aspx . Current official docs explain the four-colour weather warning system and adaptation of European colour classifications, which is not proof Türkiye publishes a Meteoalarm feed. Website terms require prior permission and attribution for copying/translation/republication; link/embed guidance asks that the authority be informed. No separately licensed anonymous structured route was established. Do not retain national warning content, add an embed, or contact MGM under this plan. These URLs can remain review evidence.

Reopening needs a published qualifying reusable structured route, precise province/district codes and geometry covering all 30 destinations, event codes, source-issued/start/end timezone, update/cancel IDs, multi-day duplication rules, and complete/partial transport. Green UI is not universal hazard absence. Different regional impact thresholds also rule out treating every colour as a universal numeric meteorological threshold. MGM website forecasts/images are not a format workaround for these gates.

### AFAD earthquakes — concrete anonymous route candidate; blocked new adapter, useful official link

Official service documentation https://deprem.afad.gov.tr/event-service is indexed with https://deprem.afad.gov.tr/apiv2/event/filter? . Public agency earthquake site: https://deprem.afad.gov.tr/tr/ . Its indexed notice requests attribution to AFAD and its Turkish Earthquake Data Center regulation, rather than establishing a blanket open licence for every AFAD product. The bounded web open of a one-hour September 8 query with limit=1 returned an internal tool error; the documentation/site rendered application shells. No successful API response or exact maximum/default limit is claimed in this pass. Third-party API catalogues were not used as contract evidence.

This is an actual official API lead, not an assertion no structured source exists. Before activating: obtain the current primary API parameter/timezone contract, validate eventID/revision handling, ML/Mw distinction, latitude/longitude/depth/magnitude units, event time versus updated time, fixed window/limit/order/completeness, replay and deletion behavior, attribution/reuse scope, and positive/empty/capped/error fixtures. AFAD and USGS/EMSC reports can describe the same earthquake: do not create additive severity or extra monitored-hazard credit. Existing reviewed USGS/EMSC already supplies earthquake eligibility to all 30; AFAD is not a prerequisite for that expansion.

### AFAD civil emergency and OGM wildfire — official-link only

https://www.afad.gov.tr/ is a public national emergency site; main page combines activity/news and disaster information. No reviewed anonymous active-alert API, completeness or cancellation contract was found in the bounded read. Historical relief/recovery announcements must not become ongoing local emergency warnings.

OGM primary example https://www.ogm.gov.tr/tr/haberler/orman-yanginlari-i%CC%87le-mucadelemiz-devam-ediyor (July 30, 2026) reports a mixture of forest/non-forest fires and response status. It establishes official reporting, not a structured complete active-fire inventory. Historical PDF fire reports also remain indexed. Use https://www.ogm.gov.tr/tr as a source link; ingestion requires exact fire ID/extent/start/update/control/extinguishment semantics, geography and reuse. Aggregate country fire counts cannot be joined to every city. Fire danger and active wildfire must stay separate.

### KGM roads — verified official-link only; useful structured fields in HTML

https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/YolDanisma/TrafigeKapaliYollar.aspx returned a current public table with 12 records in this read. Fields include road code, kilometre interval, closure reason, closure date/time, updated time and description. Example: code09-03, km9–16, landslide closure February17,2026 17:30, table update September8,2026 17:46:21. Other rows include old ongoing closures and routine road works. One planned-work description says 30 days from July16 despite the September8 table update: global update time must not silently renew an explicit event interval.

No anonymous structured machine route or reuse contract established; HTML extraction is outside the selected ingestion transport. Reopening needs a separately permitted structured route, stable record identity, authoritative road-code/km geometry and passenger applicability, direction, start/end/reopening, complete-snapshot semantics and capped/partial fixtures. No nationwide closure can be inferred from a provincial row. Exclude routine construction under current contract. A landslide is not automatically one of the current hazard categories; road impact belongs in transport context unless a reviewed mapping says otherwise.

### Utilities — verified regional official links, blocked ingestion

AYEDAŞ public anonymous query https://online.ayedas.com.tr/elektrik-kesintisi-sorgulama distinguishes current and planned outages, uses address selectors/map, and warns planned start/end times may change. Official https://online.ayedas.com.tr/ identifies scope as İstanbul's Asian side. Therefore it cannot provide all İstanbul or all Türkiye availability. No personal/customer identifiers were used. No structured endpoint/reuse/completeness contract was established. Keep link-only; a new adapter needs exact service area and address geography, outage ID, utility type, planned/unplanned states, source update/expiry/revision and complete-page semantics. Do not use customer accounts or report-fault forms.

İSKİ public https://iski.istanbul/ links water faults/outages; official service inventory https://iskiapi.iski.gov.tr/uploads/2024_ISKI_Hizmet_Envanteri_67e7f7ca12.pdf describes planned water-cut communications. This establishes a regional water provider, not a national outage API or guarantee of present data. No API inferred from the document hosting subdomain. Retain link-only and the same measurement/lifecycle/service-area gates. Other cities require their own operator contracts rather than inheritance from İstanbul.

### Hydrology and national air observations — official links; automated access unverified

DSİ https://www.dsi.gov.tr/ publishes hydrological resources/statistics. Primary technical documentation https://usbs.tarimorman.gov.tr/usbs/content/220415_sayisallastirma_usul_ve_esaslari_dokumani.pdf describes station data and integration with the national water database. That does not establish anonymous current observation access or reuse. Historical annual series do not satisfy current conditions. No unapproved access sought. Gate: public structured gauge route, station-waterbody-destination mapping, datum/units/quality, observation time, completeness and expiry.

National air-quality portal candidate https://www.havaizleme.gov.tr/ did not produce extractable content in this bounded web read; no current station contract approved. It remains a national official-link lead, not evidence of zero pollution. The current EEA adapter is a modeled AQI raster: saved shared probe has zero valid TR samples, which is a single bounded outcome and not permanent non-support. Open-Meteo modeled AQ parsed all 30 destinations independently; do not call it national observed AQ.

### Security/travel advice — existing shared FCDO eligibility, regional advice remains link-only

https://www.gov.uk/foreign-travel-advice/turkey currently specifies all-travel advice within 10km of the Syrian border. That is not a whole-country travel ban and is not an active local armed-conflict or terrorism event. Retain whole-country-only parser behavior; a future regional mapping needs exact buffer/jurisdiction and positive/outside fixtures. https://www.gov.uk/help/reuse-govuk-content establishes GOV.UK reuse terms. No national incident feed for unrest, terrorism or conflict was verified.

## All 20 hazard dispositions

A = shared existing contract eligible subject to its separate implementation verification; L = official-link evidence only; B = explicit ingestion gate; E = exclude unsupported candidate from ingestion, not claim hazard impossible. Coverage remains not_monitored until activation is implemented and verified.

| Hazard | Disposition |
|---|---|
| severe-weather | B MGM reuse/structured lifecycle and district mapping; review URLs retained |
| flood | B MGM warning contract; L AFAD/DSİ; shared CEMS country-name/GFM temporal gates remain |
| extreme-heat | B MGM contract; modeled temperature does not substitute official warning coverage |
| extreme-cold | B MGM contract; same role separation |
| wildfire | L OGM/AFAD; B active-fire geometry/lifecycle/reuse; shared EFFIS active-fire is context |
| fire-danger | B MGM national product/reuse; shared EFFIS only exact eligible destination types, not national blanket |
| air-quality | B EEA raster currently zero valid TR samples; L national observations portal; separate Open-Meteo model |
| earthquake | A USGS/EMSC all30; B AFAD new-adapter contract above; no double counting |
| volcano | B national volcano-warning contract unverified, retain not_monitored; AFAD earthquake API does not cover eruption status |
| drought | A EDO valid-cell agricultural context; B MGM national reuse/product semantics; DSİ historical data is not current drought warning |
| snow-ice | B MGM; L KGM road impact, not nationwide snow warning |
| avalanche | B MGM hazard/altitude/district/lifecycle contract; city identity alone does not establish local avalanche bulletin coverage |
| coastal | B national coastal warning product; distinguish sea-wave forecasts from warnings; exclude inland destinations from marine-derived coverage |
| civil-unrest | L FCDO/AFAD; B exact current licensed incident lifecycle; do not mine general advice as incident |
| security | A FCDO country eligibility; current regional border restriction L under whole-country parser |
| terrorism | L FCDO; B current local incident contract, not risk prose |
| armed-conflict | L FCDO; B current conflict geometry/validity; no whole-Türkiye event from border advice |
| industrial | L AFAD; B explicit active industrial-emergency product; shared CEMS mapping AOI is context |
| nuclear | L AFAD; B exact radiological warning contract; no verified NDK/RESİ transport/reuse in bounded pass, retain not_monitored |
| civil-emergency | L AFAD; B complete active-set, identity, update/cancel, affected-area and reuse contract |

## All seven condition dispositions

| Condition | Disposition |
|---|---|
| weather | A existing Open-Meteo model: all30 saved rows parsed; do not add restricted MGM images/data |
| air-quality | A Open-Meteo model: all30 saved rows parsed; EEA raster and national observed portal are separate |
| marine | A 13 saved parsed candidates only: Alanya, Antalya, Bodrum, Fethiye, İstanbul, Kaş, Kuşadası, Marmaris, Mersin, Samsun, Trabzon, Çanakkale, İzmir. Remaining17 excluded from this product; no lake/nearest-sea substitution |
| airport-observation | B exact operational ICAO/current METAR/matching radius and timestamp fixtures; no national airport proxy |
| hydrology | L DSİ; B current anonymous gauge/quality/datum/time/geometry contract |
| transport | L KGM closed-road table; B permitted structured transport and exact road/km mapping |
| utilities | L AYEDAŞ/İSKİ within verified service areas; B local operator, geography and outage lifecycle contracts; no national inheritance |

## Validation and limits

Primary official documentation/site reads and one bounded failed AFAD API web probe; read existing national review and current saved TR forecast row outcomes. No tests/builds or runtime changes. No restricted MGM warning body retained. No new structured national source was activated. Failed reads/empty shells do not imply absent services; source discovery decisions are complete for this bounded dossier with specific reopening gates, not a claim of exhaustive national provider inventory.


### TR final marine mapping review (2026-09-08)

Approved nearby offshore forecast mappings: tr-alanya, tr-antalya, tr-fethiye, tr-istanbul, tr-izmir, tr-kusadasi, tr-mersin, tr-samsun, tr-trabzon. Unsupported coastal mappings: tr-bodrum, tr-canakkale, tr-kas, tr-marmaris. Inland destinations are outside the marine product; this does not establish hazard applicability.

Exact reviewed mappings and per-destination unresolved gates are in data/marine-condition-mapping-v3.json. Only its30 mapped additions qualify for implementation; all other additions make zero marine requests. Shared compatibility, capacity and production gates remain; no expanded runtime activation yet. See [capacity and marine review](capacity.md).
