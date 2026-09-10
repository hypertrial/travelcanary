import { readFile, writeFile } from "node:fs/promises";

const locations = JSON.parse(await readFile("public/locations.json", "utf8")).filter(({ isCoastal }) => isCoastal);
const radians = (value) => value * Math.PI / 180;
const distanceKm = (a, b) => {
  const latitude1 = radians(a[1]); const latitude2 = radians(b[1]);
  const latitudeDelta = radians(b[1] - a[1]); const longitudeDelta = radians(b[0] - a[0]);
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2));
};

const mappings = [];
for (let offset = 0; offset < locations.length; offset += 40) {
  const batch = locations.slice(offset, offset + 40);
  const url = new URL("https://marine-api.open-meteo.com/v1/marine");
  url.searchParams.set("latitude", batch.map(({ centroid }) => centroid[1]).join(","));
  url.searchParams.set("longitude", batch.map(({ centroid }) => centroid[0]).join(","));
  url.searchParams.set("hourly", "wave_height,wave_period,sea_surface_temperature");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("cell_selection", "sea");
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Marine review failed with HTTP ${response.status}`);
  const value = await response.json(); const rows = Array.isArray(value) ? value : [value];
  if (rows.length !== batch.length) throw new Error("Marine review response changed order or size");
  for (let index = 0; index < batch.length; index += 1) {
    const location = batch[index]; const row = rows[index];
    const coordinates = typeof row?.longitude === "number" && typeof row.latitude === "number" ? [row.longitude, row.latitude] : null;
    const distance = coordinates ? distanceKm(location.centroid, coordinates) : null;
    const hasWaveData = Array.isArray(row?.hourly?.wave_height) && row.hourly.wave_height.some(Number.isFinite);
    const mapped = Boolean(coordinates && distance <= 25 && hasWaveData);
    mappings.push({ locationId: location.id, status: mapped ? "mapped" : "unsupported",
      ...(mapped ? { queryCoordinates: coordinates } : {}), distanceKm: distance === null ? null : Math.round(distance * 10) / 10,
      provenance: mapped
        ? "Open-Meteo cell_selection=sea returned a current offshore grid cell with wave data within 25 km of the destination centroid."
        : distance !== null && distance > 25 ? "Nearest current sea grid cell exceeds the 25 km representativeness limit."
          : "Current marine product returned no usable wave series." });
  }
}
const artifact = { schemaVersion: 1, reviewedAt: new Date().toISOString().slice(0, 10),
  source: "https://marine-api.open-meteo.com/v1/marine", documentation: "https://open-meteo.com/en/docs/marine-weather-api",
  rule: "Current offshore sea-grid cell with a non-empty wave series and no more than 25 km from the committed destination centroid.", mappings };
await writeFile("data/marine-condition-mapping.json", `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Reviewed ${mappings.length} coastal destinations: ${mappings.filter(({ status }) => status === "mapped").length} mapped, ${mappings.filter(({ status }) => status === "unsupported").length} unsupported.`);
