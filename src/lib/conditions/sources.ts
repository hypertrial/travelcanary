import type { z } from "zod";
import { AttributionSchema, conditionSourceIds, type ConditionSourceId } from "../domain/conditions";

type Source = z.infer<typeof AttributionSchema> & {
  enabled: boolean; noncommercial: boolean; cadenceHours: number; reviewDate: string;
  evidence: string[]; blocker: string | null;
};
const openMeteo = {
  officialUrl: "https://open-meteo.com/", license: "CC BY 4.0; free service for noncommercial use only",
  licenseUrl: "https://open-meteo.com/en/terms", enabled: true, noncommercial: true,
  reviewDate: "2026-08-31", evidence: ["https://open-meteo.com/en/docs", "https://open-meteo.com/en/terms"], blocker: null,
};
const candidate = (name: string, officialUrl: string, blocker: string): Source => ({
  name, officialUrl, license: "Activation requires completed source review", licenseUrl: officialUrl,
  notice: "Not connected. This source does not contribute monitoring coverage.",
  enabled: false, noncommercial: false, cadenceHours: 1, reviewDate: "2026-08-31", evidence: [officialUrl], blocker,
});
export const conditionSources: Record<ConditionSourceId, Source> = {
  "open-meteo-weather": { ...openMeteo, name: "Open-Meteo weather forecast", cadenceHours: 5,
    notice: "Forecast, not an observation or warning. Open-Meteo and its weather-model providers; hourly data reformatted by TravelCanary." },
  "open-meteo-air": { ...openMeteo, name: "Open-Meteo / Copernicus CAMS", cadenceHours: 8,
    notice: "Modeled air quality, dust and UV, not station observations. Contains modified Copernicus Atmosphere Monitoring Service information." },
  "open-meteo-marine": { ...openMeteo, name: "Open-Meteo marine forecast", cadenceHours: 8,
    notice: "Open-Meteo / DWD and marine-model providers. Nearby offshore forecast. Not suitable for navigation, beach-safety decisions or determining ferry operation." },
  "met-norway": { name: "MET Norway", officialUrl: "https://www.met.no/en", license: "CC BY 4.0 / NLOD 2.0",
    licenseUrl: "https://api.met.no/doc/License", notice: "Fallback forecast, not an observation or official warning. Reformatted by TravelCanary.",
    enabled: true, noncommercial: false, cadenceHours: 3, reviewDate: "2026-08-31", evidence: ["https://api.met.no/doc/TermsOfService"], blocker: null },
  "awc-metar": { name: "NOAA Aviation Weather Center", officialUrl: "https://aviationweather.gov/", license: "US government weather information",
    licenseUrl: "https://www.weather.gov/disclaimer", notice: "Observed at the named airport, not throughout the destination. Units converted; not for aviation decisions.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-08-31", evidence: ["https://aviationweather.gov/data/api/"], blocker: null },
  "ipma-observations": { name: "IPMA weather stations", officialUrl: "https://api.ipma.pt/", license: "Free public data; noncommercial use",
    licenseUrl: "https://api.ipma.pt/", notice: "IPMA station observation. Modified: sentinel values removed, units preserved, and mapped only to reviewed representative destinations. Not a warning or destination-wide measurement.",
    logo: "/sources/ipma.png", enabled: true, noncommercial: true, cadenceHours: 1, reviewDate: "2026-09-01",
    evidence: ["https://api.ipma.pt/", "https://api.ipma.pt/open-data/observation/meteorology/stations/obs-surface.geojson"], blocker: null },
  "ipma-seismic": { name: "IPMA seismic activity", officialUrl: "https://api.ipma.pt/", license: "Free public data; noncommercial use",
    licenseUrl: "https://api.ipma.pt/", notice: "IPMA regional earthquake context. Modified: limited to the previous 24 hours, magnitude 3 or greater, within 100 km. This display threshold is not alert scoring.",
    logo: "/sources/ipma.png", enabled: true, noncommercial: true, cadenceHours: 1, reviewDate: "2026-09-01",
    evidence: ["https://api.ipma.pt/", "https://api.ipma.pt/open-data/observation/seismic/3.json", "https://api.ipma.pt/open-data/observation/seismic/7.json"], blocker: null },
  "ign-seismic": candidate("IGN regional earthquakes", "https://www.ign.es/web/social-rss", "RSS event-time and correction/deletion lifecycle need representative current fixtures before activation."),
  "arso-hydro": { name: "ARSO hydrology", officialUrl: "https://www.arso.gov.si/vode/podatki/hidro_podatki_xml.html",
    license: "Slovenian public information reuse; attribution required", licenseUrl: "https://eionet.arso.gov.si/pravna-podlaga",
    notice: "ARSO provisional river observation at a reviewed station. Reference-level crossings are factual station context, not an official warning or destination-wide flood condition.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-09-02",
    evidence: ["https://www.arso.gov.si/vode/podatki/hidro_podatki_xml.html", "https://www.arso.gov.si/vode/podatki/opis_hidro_xml.pdf", "https://eionet.arso.gov.si/pravna-podlaga"], blocker: null },
  "opw-hydro": { name: "Office of Public Works water levels", officialUrl: "https://waterlevel.ie/", license: "CC BY 4.0",
    licenseUrl: "https://waterlevel.ie/page/api/", notice: "Contains Irish Public Sector Information licensed under CC BY 4.0, provided by OPW (waterlevel.ie). Provisional, unchecked station observation relative to local gauge zero; not a flood warning. See https://waterlevel.ie/disclaimer/.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-09-08",
    evidence: ["https://waterlevel.ie/page/api/", "https://waterlevel.ie/disclaimer/", "https://waterlevel.ie/error/", "https://waterlevel.ie/0000030099/0001/"], blocker: null },
  "rws-water": { name: "Rijkswaterstaat Waterdata", officialUrl: "https://rijkswaterstaatdata.nl/waterdata/", license: "CC0",
    licenseUrl: "https://www.rijkswaterstaat.nl/zakelijk/open-data", notice: "Rijkswaterstaat current water-level observation at the named station, filtered to published quality codes and NAP datum. Observation only; not a flood warning or destination-wide measurement.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-09-01",
    evidence: ["https://rijkswaterstaatdata.nl/waterdata/", "https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/", "https://www.rijkswaterstaat.nl/zakelijk/open-data"], blocker: null },
  "vmm-water": candidate("VMM Waterinfo", "https://www.waterinfo.vlaanderen.be/default.aspx?path=Public%2FOver+waterinfo%2FFAQ+open+data", "The live tested group provides rainfall; water-level group IDs, quality codes and geographic mappings remain unapproved. HIC requires separate authenticated access."),
  "lhmt-hydro": candidate("Lithuanian Hydrometeorological Service", "https://api.meteo.lt/", "CC BY-SA 4.0 permits reuse; exact station/river mappings and vertical-reference metadata need review before publishing values."),
  "syke-hydro": candidate("Finnish Environment Institute SYKE", "https://www.syke.fi/en/environmental-data/open-web-services/environmental-data-apis", "OData observation queries, quality flags, vertical-reference metadata and exact mappings need a completed live fixture gate."),
  "cyprus-air": candidate("Cyprus air-quality network", "https://www.airquality.dli.mlsi.gov.cy/", "CC BY-SA dataset; local-time/DST interpretation, instrument flags and representative station mappings require review."),
  "nimh-hydro": candidate("Bulgarian NIMH", "https://info.meteo.bg/openData/", "Experimental daily data need documented timestamps, reuse and exact station-area mappings; daily values cannot imply current flood warnings."),
  digitraffic: { name: "Fintraffic Digitraffic", officialUrl: "https://www.digitraffic.fi/en/road-traffic/", license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/", notice: "Fintraffic / Digitraffic. Modified: only current accident-associated roadClosed records, matched by official geometry. Nearby context, not route advice or complete disruption coverage.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-08-31", evidence: ["https://www.digitraffic.fi/en/road-traffic/", "https://www.digitraffic.fi/en/terms-of-service/", "https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements/datex2-3.7.xml"], blocker: null },
  "smhi-water": candidate("SMHI water-shortage information", "https://opendata-download-warnings.smhi.se/ibww/api/version/1", "Informational-message validity and unmodified-warning reuse requirements need representative lifecycle fixtures."),
  "krisinformation-infrastructure": { name: "Krisinformation infrastructure notices", officialUrl: "https://www.krisinformation.se/", license: "Official open API; attribution required",
    licenseUrl: "https://www.krisinformation.se/om-krisinformation/for-myndigheter-och-andra-aktorer/oppen-data/", notice: "Official Swedish crisis information. Modified into fixed infrastructure categories; source prose is not republished. Regional notices do not prove a destination-wide interruption.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-09-02", evidence: ["https://api.krisinformation.se/v3", "https://www.krisinformation.se/om-krisinformation/for-myndigheter-och-andra-aktorer/oppen-data/"], blocker: null },
  "ndw-traffic": { name: "NDW open traffic data", officialUrl: "https://opendata.ndw.nu/", license: "CC0",
    licenseUrl: "https://www.ndw.nu/service/copyright", notice: "Official Dutch road incident data. Modified: only current serious incidents and complete closures intersecting the destination are retained. Not route advice.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-09-02", evidence: ["https://opendata.ndw.nu/", "https://docs.ndw.nu/faq/incidenten/", "https://www.ndw.nu/service/copyright"], blocker: null },
  "autobahn-traffic": { name: "Autobahn GmbH traffic information", officialUrl: "https://www.autobahn.de/", license: "Official public API; factual context only",
    licenseUrl: "https://autobahn.api.bund.dev/", notice: "Official German motorway closure or warning intersecting the destination. Fixed factual summary; not complete transport monitoring or route advice.",
    enabled: true, noncommercial: true, cadenceHours: 1, reviewDate: "2026-09-02", evidence: ["https://verkehr.autobahn.de/o/autobahn", "https://autobahn.api.bund.dev/"], blocker: null },
  "eac-power": { name: "Electricity Authority of Cyprus", officialUrl: "https://www.eac.com.cy/EN/RegulatedActivities/Distribution/PowerInterruptions/Pages/Faultsandscheduledinterruptions.aspx?District=0", license: "Official free public information; factual context only",
    licenseUrl: "https://www.eac.com.cy/EN/Documents/20210416_Access%20Guide%20to%20EAC%20Information.pdf", notice: "Official current faults and scheduled interruptions mapped only by reviewed locality names. The list may not represent every premises-level outage.",
    enabled: false, noncommercial: true, cadenceHours: 1, reviewDate: "2026-09-02", evidence: ["https://www.eac.com.cy/EN/RegulatedActivities/Distribution/PowerInterruptions/Pages/Faultsandscheduledinterruptions.aspx?District=0", "https://www.eac.com.cy/EN/Documents/20210416_Access%20Guide%20to%20EAC%20Information.pdf"], blocker: "The five public district pages did not complete within the reviewed eight-second source budget during the release live gate." },
  "enemalta-power": { name: "Enemalta live outage map", officialUrl: "https://www.enemalta.com.mt/planned-power-cuts/", license: "Official public outage map; factual context only",
    licenseUrl: "https://www.enemalta.com.mt/terms-of-use/", notice: "Official current and planned electricity interruptions matched by published geometry. Fixed factual summary; absence from the map is not an all-clear.",
    enabled: false, noncommercial: true, cadenceHours: 1, reviewDate: "2026-09-02", evidence: ["https://www.enemalta.com.mt/planned-power-cuts/", "https://mobilegis.enemalta.com.mt/mobilegis_rest/api/currentoutages/GetOutages", "https://mobilegis.enemalta.com.mt/mobilegis_Rest/api/currentoutages/GetPlannedOutages"], blocker: "The official planned-outage response was 1,209,931 bytes at the release live gate, exceeding the approved 512 KiB response limit." },
  "pse-energy-compass": { name: "PSE Energy Compass", officialUrl: "https://www.energetycznykompas.pl/", license: "Official public API",
    licenseUrl: "https://api.raporty.pse.pl/", notice: "National electricity-use recommendation from PSE. This describes system conditions and does not indicate a local power outage.",
    enabled: true, noncommercial: false, cadenceHours: 1, reviewDate: "2026-09-02", evidence: ["https://api.raporty.pse.pl/", "https://www.pse.pl/-/nowe-funkcje-w-energetycznym-kompasie"], blocker: null },
};

export function conditionsDisabledSources(value = process.env.CONDITIONS_DISABLED_SOURCES) {
  const ids = value?.trim() ? value.split(",").map((id) => id.trim()) : [];
  if (new Set(ids).size !== ids.length || ids.some((id) => !conditionSourceIds.includes(id as ConditionSourceId))) throw new Error("Invalid CONDITIONS_DISABLED_SOURCES");
  return new Set(ids as ConditionSourceId[]);
}
export function conditionSourceEnabled(id: ConditionSourceId, env: Record<string, string | undefined> = process.env) {
  const source = conditionSources[id];
  return env.LOCAL_CONDITIONS_ENABLED === "true" && source.enabled
    && (!source.noncommercial || env.NONCOMMERCIAL_DATA_ENABLED === "true") && !conditionsDisabledSources(env.CONDITIONS_DISABLED_SOURCES).has(id);
}
export function conditionAttribution(id: ConditionSourceId) { return AttributionSchema.parse(conditionSources[id]); }
