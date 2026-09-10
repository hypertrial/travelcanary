import type { ConditionSourceId, InfrastructureIncident, LocationConditions } from "../domain/conditions";

export function infrastructureTiming(item: InfrastructureIncident, now: Date): InfrastructureIncident["status"] {
  return item.status === "planned" && Date.parse(item.startsAt) > now.getTime() ? "planned" : "active";
}

export function currentConditions(value: LocationConditions, now: Date, enabled: (id: ConditionSourceId) => boolean = () => true): LocationConditions {
  const result = structuredClone(value);
  const current = (item: { sourceId: Parameters<typeof enabled>[0]; expiresAt: string; checkedAt: string }) => enabled(item.sourceId)
    && Date.parse(item.expiresAt) > now.getTime() && Date.parse(item.checkedAt) <= now.getTime() + 300_000;
  for (const kind of ["weather", "airQuality", "marine"] as const) {
    const forecast = result[kind];
    if (!forecast || !current(forecast)) { delete result[kind]; continue; }
    const count = Object.values(forecast).find(Array.isArray)!.length;
    const first = Math.max(0, Math.floor((now.getTime() - Date.parse(forecast.startAt)) / 3_600_000));
    const last = Math.min(count, Math.floor((now.getTime() + 24 * 3_600_000 - Date.parse(forecast.startAt)) / 3_600_000) + 1);
    if (first >= last) { delete result[kind]; continue; }
    for (const [key, series] of Object.entries(forecast)) if (Array.isArray(series)) Object.assign(forecast, { [key]: series.slice(first, last) });
    forecast.startAt = new Date(Date.parse(forecast.startAt) + first * 3_600_000).toISOString();
  }
  for (const kind of ["observations", "rivers", "earthquakes", "infrastructureIncidents", "systemConditions"] as const) {
    Object.assign(result, { [kind]: result[kind].filter(current) });
  }
  return result;
}
