import type { HazardLevel, PublicHazard } from "./domain/schemas";

export const hazardLevelRank: Record<HazardLevel, number> = { ELEVATED: 1, HIGH: 2, SEVERE: 3 };

export function hazardTiming(startsAt: string, now: Date): "ACTIVE" | "UPCOMING" {
  return Date.parse(startsAt) > now.getTime() ? "UPCOMING" : "ACTIVE";
}

export function comparePublicHazards(a: PublicHazard, b: PublicHazard): number {
  return hazardLevelRank[b.level] - hazardLevelRank[a.level]
    || Number(a.timing === "UPCOMING") - Number(b.timing === "UPCOMING")
    || Date.parse(b.sourceUpdatedAt) - Date.parse(a.sourceUpdatedAt)
    || a.id.localeCompare(b.id);
}

export function currentPublicHazards(hazards: PublicHazard[], now: Date): PublicHazard[] {
  return hazards
    .filter((hazard) => Date.parse(hazard.startsAt) < Date.parse(hazard.endsAt)
      && Date.parse(hazard.expiresAt) > now.getTime() && Date.parse(hazard.endsAt) > now.getTime())
    .map((hazard) => ({ ...hazard, timing: hazardTiming(hazard.startsAt, now) }))
    .sort(comparePublicHazards);
}

export function eventIsPublishable(event: { startsAt: string; endsAt: string; expiresAt: string }, now: Date): boolean {
  return Date.parse(event.startsAt) < Date.parse(event.endsAt)
    && Date.parse(event.startsAt) < now.getTime() + 24 * 60 * 60_000
    && Date.parse(event.endsAt) > now.getTime()
    && Date.parse(event.expiresAt) > now.getTime();
}
