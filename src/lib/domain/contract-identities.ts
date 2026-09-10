// Historical identities are immutable wire contracts. New releases must define new
// schemas rather than extending these arrays. Current aliases are deliberately separate.
export const catalogV2CountryCodes = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH",
] as const;
export const catalogV3CountryCodes = [
  "AD", "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME",
  "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "TR", "VA", "XK",
] as const;
export const snapshotV10SourceIds = ["meteoalarm", "usgs", "effis", "cems", "eea", "gdelt", "gdacs", "gfm", "emsc", "slf-avalanche", "euregio-avalanche", "effis-active-fire", "national-civil-alerts", "vigicrues", "foen-flood", "ehyd-flood", "eonet", "edo-drought", "fcdo-travel-advice"] as const;
export const snapshotV10ProviderIds = ["meteoalarm", "usgs", "effis-fire-danger", "cems-rapid-mapping", "gdacs", "gfm", "emsc", "slf-avalanche", "euregio-avalanche", "effis-active-fire", "eea-aqi", "gdelt", "national-civil-alerts", "vigicrues", "foen-flood", "ehyd-flood", "eonet", "edo-drought", "fcdo-travel-advice"] as const;
export const conditionsV2SourceIds = ["open-meteo-weather", "open-meteo-air", "open-meteo-marine", "met-norway", "awc-metar", "ipma-observations", "ipma-seismic", "ign-seismic", "arso-hydro", "opw-hydro", "rws-water", "vmm-water", "lhmt-hydro", "syke-hydro", "cyprus-air", "nimh-hydro", "digitraffic", "smhi-water", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "eac-power", "enemalta-power", "pse-energy-compass"] as const;

export const countryCodes = catalogV2CountryCodes;
export const sourceIds = snapshotV10SourceIds;
export const providerIds = snapshotV10ProviderIds;
export const conditionSourceIds = conditionsV2SourceIds;
