# Warning expansion fixtures

Captured 2026-09-07 from the official, keyless services. Fixtures are dated examples, never live app data. Latvia is CC0; AEMET and DHMZ reuse/attribution are documented in `THIRD_PARTY_NOTICES.md` and `docs/WARNING_EXPANSION.md`.

- `dhmz-today.xml` / `dhmz-tomorrow.xml`: complete responses from `https://meteo.hr/upozorenja/cap_hr_today.xml` and `https://meteo.hr/upozorenja/cap_hr_tomorrow.xml`. Preserve original multilingual CAP. Issued 2026-09-06 for September 7/8.
- `aemet-current.tar.gz`: advertised complete-state `https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/cap/Z_CAP_C_LEMM_20260907065945_AFAE.tar.gz`; 331 regular CAP files. `aemet-0.xml` and `aemet-1.xml` are unmodified member examples (mainland and Canary Islands).
- `lvgmc-tables.json.gz`: lossless JSON bundle of all four CKAN datastore tables, after pagination. Resource UUIDs are committed in the adapter. It contains 1 warning, 28,412 polygon vertices, 8 municipality joins and 46 municipalities. The warning ends 2026-09-07T13:00:00 Europe/Riga. Source dataset: `https://data.gov.lv/dati/dataset/hidrometeorologiskie-bridinajumi`.

Unit tests explicitly synthesize time-offset, cancellation/update, changed-area, malformed, missing-join and overflow variants from these originals; those variants are not represented as captured real messages.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| aemet-0.xml | 5851 | `674e3278d76a00d3645e8de87e5c47f2e0f7755fd2da12cac010762062cc8ccf` |
| aemet-1.xml | 4735 | `c0059081fbb8b85f9e6c939ef1506cef05f0a6d958636c2f3aad0752a00d2ce6` |
| aemet-current.tar.gz | 157397 | `4d425964ad5a3c8d58ad4d1a234ec7d7aed784dfed101b5de16218725a94f2ec` |
| dhmz-today.xml | 12022 | `ca221983c1a51bccc789a6e374a502674fb03a51e949066a34d9343ecea093b4` |
| dhmz-tomorrow.xml | 6458 | `310e341bc9578cec52cee93c3eb524d2c03a98dd7182053454cc9d1eac8a38ad` |
| lvgmc-tables.json.gz | 329844 | `62259863da7e8ee85b43ac7481c91183d0b89875f624b8e15edb4297ef175f4b` |
