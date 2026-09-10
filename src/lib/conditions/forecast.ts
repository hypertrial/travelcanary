import { z } from "zod";
import { AirForecastSchema, MarineForecastSchema, WeatherForecastSchema, type LocationConditions } from "../domain/conditions";

export const forecastProducts = {
  weather: { sourceId: "open-meteo-weather", endpoint: "https://api.open-meteo.com/v1/forecast", hours: 5, expiryHours: 6,
    fields: { temperature: "temperature_2m", precipitationProbability: "precipitation_probability", precipitation: "precipitation", wind: "wind_speed_10m", gusts: "wind_gusts_10m", weatherCode: "weather_code" } },
  airQuality: { sourceId: "open-meteo-air", endpoint: "https://air-quality-api.open-meteo.com/v1/air-quality", hours: 8, expiryHours: 12,
    fields: { aqi: "european_aqi", pm25: "pm2_5", pm10: "pm10", dust: "dust", uv: "uv_index" } },
  marine: { sourceId: "open-meteo-marine", endpoint: "https://marine-api.open-meteo.com/v1/marine", hours: 8, expiryHours: 12,
    fields: { waveHeight: "wave_height", wavePeriod: "wave_period", seaTemperature: "sea_surface_temperature" } },
} as const;
export type ForecastKind = keyof typeof forecastProducts;
const responseSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  utc_offset_seconds: z.literal(0), hourly: z.record(z.string(), z.array(z.unknown()).max(25)), hourly_units: z.record(z.string(), z.string()) });
const ranges: Record<string, [number, number, string]> = {
  temperature: [-100, 65, "°C"], precipitationProbability: [0, 100, "%"], precipitation: [0, 1000, "mm"],
  wind: [0, 150, "m/s"], gusts: [0, 200, "m/s"], weatherCode: [0, 99, "wmo code"],
  aqi: [0, 1000, "EAQI"], pm25: [0, 10000, "μg/m³"], pm10: [0, 10000, "μg/m³"], dust: [0, 10000, "μg/m³"], uv: [0, 30, ""],
  waveHeight: [0, 40, "m"], wavePeriod: [0, 60, "s"], seaTemperature: [-5, 45, "°C"],
};
export function parseOpenMeteo(value: unknown, kind: ForecastKind, now: Date): NonNullable<LocationConditions[ForecastKind]> {
  const response = responseSchema.parse(value);
  const times = response.hourly.time;
  if (!times?.length || times.length < 18) throw new Error("Insufficient forecast window");
  const parsedTimes = times.map((time) => typeof time === "number" ? time * 1000 : typeof time === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(time) ? Date.parse(`${time}Z`) : NaN);
  if (!parsedTimes.every((time, index) => Number.isFinite(time) && (!index || time - parsedTimes[index - 1] === 3_600_000))
    || Math.abs(parsedTimes[0] - now.getTime()) > 3_600_000 || parsedTimes.at(-1)! > now.getTime() + 24 * 3_600_000) throw new Error("Invalid forecast times");
  const product = forecastProducts[kind];
  const fields = Object.fromEntries(Object.entries(product.fields).map(([field, upstream]) => {
    const series = response.hourly[upstream];
    const [min, max, unit] = ranges[field];
    if (!series || series.length !== times.length || response.hourly_units[upstream] !== unit) throw new Error("Invalid forecast units or alignment");
    const safe = series.map((item) => item === null ? null : typeof item === "number" && Number.isFinite(item) && item >= min && item <= max ? item : NaN);
    if (safe.some((item) => Number.isNaN(item))) throw new Error("Invalid forecast value");
    return [field, safe];
  }));
  const required = kind === "weather" ? ["temperature", "wind"] : kind === "airQuality" ? ["aqi", "pm25"] : ["waveHeight"];
  if (required.some((field) => (fields[field] as Array<number | null>).filter((item) => item !== null).length < 18)) throw new Error("Forecast lacks representative data");
  return ({ weather: WeatherForecastSchema, airQuality: AirForecastSchema, marine: MarineForecastSchema }[kind]).parse({
    sourceId: product.sourceId, sourceUpdatedAt: null, checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + product.expiryHours * 3_600_000).toISOString(),
    startAt: new Date(parsedTimes[0]).toISOString(), stepMinutes: 60, ...fields,
  });
}

export function forecastUrl(kind: ForecastKind, coordinates: Array<[number, number]>) {
  if (!coordinates.length || coordinates.length > 40) throw new Error("Forecast batch exceeds 40 points");
  const product = forecastProducts[kind];
  const params = new URLSearchParams({ latitude: coordinates.map((point) => point[1].toFixed(4)).join(","), longitude: coordinates.map((point) => point[0].toFixed(4)).join(","),
    hourly: Object.values(product.fields).join(","), forecast_hours: "24", timezone: "GMT", timeformat: "unixtime" });
  if (kind === "weather") params.set("wind_speed_unit", "ms");
  if (kind === "airQuality") params.set("domains", "auto");
  if (kind === "marine") params.set("cell_selection", "sea");
  return `${product.endpoint}?${params}`;
}

export function parseMetNorway(value: unknown, now: Date): z.infer<typeof WeatherForecastSchema> {
  const response = z.object({ properties: z.object({ meta: z.object({ updated_at: z.string().datetime({ offset: true }) }),
    timeseries: z.array(z.object({ time: z.string().datetime({ offset: true }), data: z.object({
      instant: z.object({ details: z.object({ air_temperature: z.number().min(-100).max(65), wind_speed: z.number().min(0).max(150) }) }),
      next_1_hours: z.object({ details: z.object({ precipitation_amount: z.number().min(0).max(1000) }) }).optional(),
    }) })).max(120),
  }) }).parse(value);
  const issued = Date.parse(response.properties.meta.updated_at);
  if (issued > now.getTime() + 300_000 || now.getTime() - issued > 12 * 3_600_000) throw new Error("Stale MET Norway forecast");
  const rows = response.properties.timeseries.filter((row) => Date.parse(row.time) >= now.getTime() - 3_600_000 && Date.parse(row.time) <= now.getTime() + 24 * 3_600_000).slice(0, 25);
  if (rows.length < 18 || rows.some((row, index) => index && Date.parse(row.time) - Date.parse(rows[index - 1].time) !== 3_600_000)) throw new Error("Incomplete hourly fallback");
  return WeatherForecastSchema.parse({ sourceId: "met-norway", sourceUpdatedAt: response.properties.meta.updated_at,
    checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 6 * 3_600_000).toISOString(), startAt: rows[0].time, stepMinutes: 60,
    temperature: rows.map((row) => row.data.instant.details.air_temperature), wind: rows.map((row) => row.data.instant.details.wind_speed),
    precipitation: rows.map((row) => row.data.next_1_hours?.details.precipitation_amount ?? null),
    gusts: rows.map(() => null), precipitationProbability: rows.map(() => null), weatherCode: rows.map(() => null),
  });
}
