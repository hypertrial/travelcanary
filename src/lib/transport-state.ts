import type { SourceHealth } from "./domain/schemas";
import type { NationalWarningSystem } from "./national-warning-sources";

export type TransportPublicStatus = "ok" | "partial" | "delayed" | "failed" | "disabled";

export type DeriveTransportStateInput = {
  system: NationalWarningSystem;
  health?: SourceHealth;
  fallbackStatus: TransportPublicStatus;
  effectiveStatus: SourceHealth["status"];
  now: Date;
};

function transportIsDelayed(health: SourceHealth, cadenceMinutes: number, now: Date) {
  if (health.status === "delayed" || health.consecutiveFailures >= 2) return true;
  if (!health.lastSuccess) return false;
  const nextExpected = health.nextExpectedUpdate
    ? Date.parse(health.nextExpectedUpdate)
    : Date.parse(health.lastSuccess) + cadenceMinutes * 60_000;
  return Number.isFinite(nextExpected) && now.getTime() > nextExpected + cadenceMinutes * 60_000;
}

function authorized(system: NationalWarningSystem, health: SourceHealth | undefined) {
  return system.status === "active" || system.status === "credential_gated" && Boolean(health && health.status !== "not_monitored");
}

export function deriveTransportState({ system, health, fallbackStatus, effectiveStatus, now }: DeriveTransportStateInput) {
  const status = !authorized(system, health) ? "disabled" as const
    : system.role === "fallback" && effectiveStatus === "ok" ? "ok" as const
    : health?.status === "not_monitored" ? "disabled" as const
      : health && system.role === "coverage" && transportIsDelayed(health, system.cadenceMinutes || 10, now) ? "delayed" as const
      : health?.status === "ok" || health?.status === "partial" || health?.status === "delayed" ? health.status
        : health?.status === "failed" ? "failed" as const : fallbackStatus;
  return {
    id: system.id, name: system.systemName, role: system.role, status,
    lastSuccess: health?.lastSuccess || null, sourceUpdatedAt: health?.sourceUpdatedAt || null,
    nextExpectedUpdate: health?.nextExpectedUpdate || null,
    limitationCode: status === "disabled" ? system.limitationCode || "credential_not_configured" : null,
    officialUrl: system.officialUrl,
  };
}
