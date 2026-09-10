import type { PublicCatalogLocation as PublicLocation } from "@/lib/domain/catalog-public";
import { useEffect, useRef } from "react";
import Image from "next/image";
import type {} from "@/lib/domain/schemas";
import { conditionRecords, type ConditionRecord, type ConditionSourceId, type InfrastructureIncident } from "@/lib/domain/conditions";
import { currentConditions, infrastructureTiming } from "@/lib/conditions/presentation";
import { useConditions } from "@/lib/use-conditions";
import { destinationTime } from "@/lib/time";
import styles from "./LocalConditions.module.css";

const number = (value: number | null | undefined, unit: string) => value == null ? "Not available" : `${Math.round(value * 10) / 10}${unit ? ` ${unit}` : ""}`;
const measurementLabels = {
  temperature: "Temperature",
  wind: "Wind",
  visibility: "Visibility",
  "water-level": "Water level",
  discharge: "Discharge",
  "water-temperature": "Water temperature",
  pm25: "PM2.5",
  pm10: "PM10",
  no2: "Nitrogen dioxide",
  ozone: "Ozone",
  rainfall: "Rainfall",
} as const;
const infrastructureSourceIds = new Set<ConditionSourceId>(["digitraffic", "krisinformation-infrastructure", "ndw-traffic", "autobahn-traffic", "eac-power", "enemalta-power"]);
const operationalContextSourceIds = new Set<ConditionSourceId>([...infrastructureSourceIds, "pse-energy-compass"]);
const infrastructureKind = { "power-outage": "power outage", "water-supply-disruption": "water-supply disruption", "telecom-disruption": "telecom disruption", "rail-disruption": "rail disruption", "road-closure": "road closure", "road-disruption": "road disruption", "district-heating-disruption": "district-heating disruption" } as const;

function sentenceList(values: string[]) {
  if (values.length < 2) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function range(values: Array<number | null>, unit: string) {
  const present = values.filter((value): value is number => value != null);
  return present.length ? `${number(Math.min(...present), unit)}–${number(Math.max(...present), unit)}` : "Not available";
}
export function LocalConditions({ location, countryIds, snapshotUrl, now, catalogVersion = 2 }: { location: PublicLocation; countryIds: string[]; snapshotUrl: string | null; now: Date; catalogVersion?: 2 | 3 }) {
  const result = useConditions(snapshotUrl, location.countryCode, countryIds, catalogVersion);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRef(false);
  useEffect(() => {
    if (result.data && retryFocus.current) {
      retryFocus.current = false;
      const frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        const hasIntentionalTarget = active instanceof HTMLElement
          && active.matches('a, button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
        const isModalSheet = Boolean(headingRef.current?.closest('[role="dialog"]'));
        // A disabled retry button may leave focus on the body or on the modal
        // dialog container. Move that lost focus to the recovered content, but
        // preserve a deliberate desktop move to another interactive control.
        // The compact sheet traps focus, so recovery always moves to its new
        // content instead of whichever control the focus scope chose.
        if (isModalSheet || active === document.body || !hasIntentionalTarget) headingRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [result.data]);
  const raw = result.data?.locations[location.id];
  const data = raw && currentConditions(raw, now);
  const records = data ? conditionRecords(data) : [];
  const missingForecasts = data && records.length ? [
    !data.weather && "weather forecast",
    !data.airQuality && "modeled air quality",
    location.isCoastal && !raw?.limitations.includes("outside-product") && !data.marine && "nearby offshore forecast",
  ].filter((value): value is string => Boolean(value)) : [];
  const time = (value: string) => destinationTime(value, location.timezone, now);
  const source = (record: ConditionRecord) => {
    const attribution = result.data?.sources[record.sourceId];
    return <small>{attribution && <a href={"sourceUrl" in record ? record.sourceUrl : attribution.officialUrl} target="_blank" rel="noreferrer" aria-label={`${attribution.name} (opens in a new tab)`}>{attribution.name}</a>} · {record.sourceUpdatedAt ? `Source updated ${time(record.sourceUpdatedAt)}` : `Retrieved ${time(record.checkedAt)}`}{operationalContextSourceIds.has(record.sourceId) && record.sourceUpdatedAt ? ` · Checked ${time(record.checkedAt)}` : ""}</small>;
  };
  const infrastructureHealth = Object.entries(result.data?.sourceHealth || {}).filter(([id]) => infrastructureSourceIds.has(id as ConditionSourceId));
  const infrastructureProblems = infrastructureHealth.filter(([, health]) => health?.status === "failed" || health?.status === "partial");
  const infrastructureHealthWithoutRecord = infrastructureHealth.filter(([id, health]) => health?.status !== "ok"
    || !data?.infrastructureIncidents.some((record) => record.sourceId === id));
  const incident = (record: InfrastructureIncident) => <div key={`${record.sourceId}:${record.id}`}>
    <p>{record.status === "planned" ? "Planned" : "Reported"} {infrastructureKind[record.kind]} · {record.scopeLabel}. {record.status === "planned" ? `Starts ${time(record.startsAt)}. ` : `Active since ${time(record.startsAt)}. `}{record.estimatedRestorationAt ? `Estimated restoration ${time(record.estimatedRestorationAt)}.` : record.endsAt ? `Valid until ${time(record.endsAt)}.` : `Reported ongoing; checked ${time(record.checkedAt)}.`}{record.affectedCustomers != null ? ` ${record.affectedCustomers.toLocaleString("en")} affected customers reported by the authority.` : ""}</p>
    <p className={styles.note}>{record.scope === "region" ? "Regional notice; conditions may differ at this destination." : record.kind.startsWith("road-") ? "Nearby context only; this does not identify your route." : "Connected sources are incomplete and absence of a record is not an all-clear."}</p>{source(record)}
  </div>;
  return <section className={styles.section} aria-label="Local conditions">
    <h3 ref={headingRef} tabIndex={-1}>Local conditions</h3>
    <p className={styles.note}>Forecasts and nearby observations—not alerts, safety ratings, or complete monitoring.</p>
    {!data && <p role="status">{result.failed ? "Local conditions are unavailable. Alert information is unaffected." : "Loading local conditions…"}</p>}
    {(result.failed || result.retrying) && <button type="button" className={styles.retry} disabled={result.retrying} onClick={() => {
      retryFocus.current = true;
      result.retry();
    }}>Retry local conditions</button>}
    {data && !records.length && <p>Fresh local conditions are not available for this destination. Alert information is unaffected.</p>}
    {!!missingForecasts.length && <p className={styles.note}>Current {sentenceList(missingForecasts)} {missingForecasts.length === 1 ? "is" : "are"} unavailable. Other current local data is shown below.</p>}
    {data?.weather && <div><h4>Forecast</h4><p>Temperature {range(data.weather.temperature, "°C")} · Wind {range(data.weather.wind, "m/s")}</p>{source(data.weather)}
      <details><summary>Hourly forecast · {data.weather.temperature.length} available hours</summary><ol className={styles.hours}>{data.weather.temperature.map((value, index) => <li key={index}>
        <strong>{time(new Date(Date.parse(data.weather!.startAt) + index * 3_600_000).toISOString())}</strong><br />
        {number(value, "°C")} · Rain {number(data.weather!.precipitationProbability[index], "%")} / {number(data.weather!.precipitation[index], "mm")} · Wind {number(data.weather!.wind[index], "m/s")} · Gusts {number(data.weather!.gusts[index], "m/s")}
      </li>)}</ol></details></div>}
    {data?.airQuality && <div><h4>Modeled air quality</h4><p>European AQI {range(data.airQuality.aqi, "")} · PM2.5 {range(data.airQuality.pm25, "µg/m³")}</p>{source(data.airQuality)}
      <details><summary>Hourly modeled air quality · {data.airQuality.aqi.length} available hours</summary><ol className={styles.hours}>{data.airQuality.aqi.map((value, index) => <li key={index}>
        <strong>{time(new Date(Date.parse(data.airQuality!.startAt) + index * 3_600_000).toISOString())}</strong><br />AQI {number(value, "")} · PM2.5 {number(data.airQuality!.pm25[index], "µg/m³")} · PM10 {number(data.airQuality!.pm10[index], "µg/m³")} · Dust {number(data.airQuality!.dust[index], "µg/m³")} · UV {number(data.airQuality!.uv[index], "")}
      </li>)}</ol></details></div>}
    {data?.marine && <div><h4>Nearby offshore forecast</h4><p>Waves {range(data.marine.waveHeight, "m")} · Period {range(data.marine.wavePeriod, "s")} · Sea temperature {range(data.marine.seaTemperature, "°C")}</p>{source(data.marine)}<p className={styles.note}>Not beach or navigation safety information; does not describe ferry operation.</p>
      <details><summary>Hourly offshore forecast · {data.marine.waveHeight.length} available hours</summary><ol className={styles.hours}>{data.marine.waveHeight.map((value, index) => <li key={index}>
        <strong>{time(new Date(Date.parse(data.marine!.startAt) + index * 3_600_000).toISOString())}</strong><br />Waves {number(value, "m")} · Period {number(data.marine!.wavePeriod[index], "s")} · Sea temperature {number(data.marine!.seaTemperature[index], "°C")}
      </li>)}</ol></details></div>}
    {[...(data?.observations || []), ...(data?.rivers || [])].map((record) => <div key={`${record.sourceId}:${record.stationId}`}><h4>{record.daily ? "Daily observation" : "Observed"} at {record.stationName}</h4>
      <p>{record.measurements.map((measurement) => `${measurementLabels[measurement.metric]}: ${measurement.qualifier === "at-least" ? "at least " : ""}${number(measurement.value, measurement.unit)}${measurement.qualifier === "above-reference" ? " (above station reference, not a flood warning)" : ""}`).join(" · ")}</p>
      <p className={styles.note}>{time(record.observedAt)}{record.distanceKm != null ? ` · ${record.distanceKm} km from destination centre` : ""}{record.datum ? ` · Datum: ${record.datum}` : ""}{record.qualityCode ? ` · Source quality: ${record.qualityCode}${record.qualityStatus ? ` (${record.qualityStatus})` : ""}` : ""}. Nearby measurements may differ from conditions at your location.</p>{source(record)}</div>)}
    {!!data?.earthquakes.length && <div><h4>Recent nearby earthquakes</h4><p className={styles.note}>Previous 24 hours, magnitude 3 or greater. Magnitude alone does not establish harmful shaking.</p>{data.earthquakes.map((record) => <div key={`${record.sourceId}:${record.id}`}><p>M{record.magnitude} · {record.distanceKm} km away · {time(record.occurredAt)}</p>{source(record)}</div>)}</div>}
    {(!!data?.infrastructureIncidents.length || !!infrastructureHealth.length) && <section aria-label="Infrastructure disruptions"><h4>Infrastructure disruptions</h4>
      {!!infrastructureProblems.length && <p className={styles.note} role="status">Local infrastructure updates are incomplete: {sentenceList(infrastructureProblems.map(([id]) => result.data?.sources[id as ConditionSourceId]?.name || id))} could not provide a complete update. Alert information is unaffected.</p>}
      {!!data?.infrastructureIncidents.filter((item) => infrastructureTiming(item, now) === "active").length && <div><h5>Active now</h5>{data.infrastructureIncidents.filter((item) => infrastructureTiming(item, now) === "active").map(incident)}</div>}
      {!!data?.infrastructureIncidents.filter((item) => infrastructureTiming(item, now) === "planned").length && <div><h5>Planned in the next 24 hours</h5>{data.infrastructureIncidents.filter((item) => infrastructureTiming(item, now) === "planned").map(incident)}</div>}
      {!data?.infrastructureIncidents.length && !infrastructureProblems.length && <p className={styles.note}>No current incident published by connected infrastructure sources; coverage is incomplete.</p>}
      <div aria-label="Connected infrastructure sources">{infrastructureHealthWithoutRecord.map(([id, health]) => {
        const attribution = result.data?.sources[id as ConditionSourceId];
        if (!health || !attribution) return null;
        return <p className={styles.note} key={id}><a href={attribution.officialUrl} target="_blank" rel="noreferrer" aria-label={`${attribution.name} (opens in a new tab)`}>{attribution.name}</a> · {health.status === "ok" ? "Current list checked" : health.status === "partial" ? "Partial update checked" : health.status === "failed" ? "Update failed" : "Disabled"} {time(health.checkedAt)}</p>;
      })}</div>
    </section>}
    {!!data?.systemConditions.length && <section aria-label="National electricity system advisory"><h4>National electricity system advisory</h4>{data.systemConditions.map((record) => <div key={`${record.sourceId}:${record.id}`}>
      <p>{record.state === "limit-use" ? "PSE requires limiting electricity use" : "PSE recommends reducing electricity use"} from {time(record.startsAt)} until {time(record.endsAt)}.</p>
      <p className={styles.note}>This describes Poland’s electricity system and does not indicate a local power outage.</p>{source(record)}
    </div>)}</section>}
    {!!records.length && <details><summary>Sources and attribution</summary>{[...new Set(records.map((record) => record.sourceId))].map((id) => {
      const item = result.data!.sources[id]!;
      return <div key={id}><h4>{item.name}</h4>{item.logo && <a href={item.officialUrl} target="_blank" rel="noreferrer" aria-label={`${item.name} official site (opens in a new tab)`}><Image src={item.logo} alt="" width={80} height={80} unoptimized /></a>}<p>{item.notice}</p><p><a href={item.licenseUrl} target="_blank" rel="noreferrer" aria-label={`${item.name}: ${item.license} (opens in a new tab)`}>{item.license}</a></p></div>;
    })}</details>}
  </section>;
}
