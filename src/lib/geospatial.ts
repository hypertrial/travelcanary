import type { NormalizedEventV13 as NormalizedEvent } from "./domain/catalog-state";
import booleanIntersects from "@turf/boolean-intersects";
import distance from "@turf/distance";
import { earthRadius, point, polygon } from "@turf/helpers";
import type { CatalogLocation as Location } from "./catalog-data";

type Position = [number, number];
const locationPolygonCache = new WeakMap<Location, ReturnType<typeof polygon>>();
const eventPolygonCache = new WeakMap<NormalizedEvent, ReturnType<typeof polygon>>();

function radiusRing([longitude, latitude]: Position, radiusKm: number, steps = 24): Position[] {
  const result: Position[] = [];
  const latitudeScale = 110.574;
  const longitudeScale = 111.32 * Math.cos((latitude * Math.PI) / 180);
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    result.push([longitude + (Math.cos(angle) * radiusKm) / longitudeScale, latitude + (Math.sin(angle) * radiusKm) / latitudeScale]);
  }
  result.push(result[0]);
  return result;
}

export function locationPolygon(location: Location) {
  const cached = locationPolygonCache.get(location);
  if (cached) return cached;
  const result = location.geometry.kind === "polygon"
    ? polygon(location.geometry.coordinates)
    : polygon([radiusRing(location.geometry.center, location.geometry.radiusKm)]);
  locationPolygonCache.set(location, result);
  return result;
}

function eventPolygon(event: NormalizedEvent) {
  const cached = eventPolygonCache.get(event);
  if (cached) return cached;
  const result = event.geometry.kind === "point"
    ? polygon([radiusRing(event.geometry.coordinates, event.geometry.radiusKm)])
    : event.geometry.kind === "polygon" ? polygon(event.geometry.coordinates) : null;
  if (result) eventPolygonCache.set(event, result);
  return result;
}

export function eventAffectsLocation(event: NormalizedEvent, location: Location): boolean {
  if (event.geometry.kind === "locations") return event.geometry.ids.includes(location.id);
  if (event.geometry.kind === "regions") {
    if (event.geometry.countryCode !== location.countryCode) return false;
    if (event.geometry.codes.includes(`${location.countryCode}:country`)) return true;
    const normalized = location.sourceRegionCodes.meteoalarm.map((code) => code.replace(/^GR/, "EL"));
    return event.geometry.codes.some((code) => {
      const candidate = code.replace(/^GR/, "EL");
      if (normalized.includes(candidate)) return true;
      if (!candidate.startsWith("area:") || !["capital", "city", "resort"].includes(location.type)) return false;
      const eventArea = candidate.slice(5);
      return normalized.some((locationCode) => {
        if (!locationCode.startsWith("area:")) return false;
        const locationArea = locationCode.slice(5);
        return locationArea.length >= 5 && (eventArea.startsWith(`${locationArea} `) || locationArea.startsWith(`${eventArea} `));
      });
    });
  }
  if (event.geometry.kind === "point") {
    if (location.geometry.kind === "radius") {
      return distance(point(event.geometry.coordinates), point(location.geometry.center), { units: "kilometers" }) <= event.geometry.radiusKm + location.geometry.radiusKm;
    }
    try {
      return booleanIntersects(
        eventPolygon(event)!,
        locationPolygon(location),
      );
    } catch {
      return false;
    }
  }
  try {
    return booleanIntersects(eventPolygon(event)!, locationPolygon(location));
  } catch {
    return false;
  }
}

export function distanceKm(a: Position, b: Position) {
  return distance(point(a), point(b), { units: "kilometers" });
}

export function distanceToLocationKm(coordinates: Position, location: Location) {
  if (location.geometry.kind === "radius") return Math.max(0, distanceKm(coordinates, location.geometry.center) - location.geometry.radiusKm);
  try { if (booleanIntersects(point(coordinates), locationPolygon(location))) return 0; } catch { return Infinity; }
  return Math.min(...location.geometry.coordinates.flatMap((ring) => ring.slice(1).map((end, index) => distanceToSegmentKm(coordinates, ring[index], end))));
}

function distanceToSegmentKm(position: Position, start: Position, end: Position) {
  const radiusKm = earthRadius / 1000;
  const length = distanceKm(start, end) / radiusKm;
  if (!length) return distanceKm(position, start);
  const bearing = (a: Position, b: Position) => {
    const lat1 = a[1] * Math.PI / 180; const lat2 = b[1] * Math.PI / 180;
    const longitude = (b[0] - a[0]) * Math.PI / 180;
    return Math.atan2(Math.sin(longitude) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitude));
  };
  const distance = distanceKm(start, position) / radiusKm;
  const angle = bearing(start, position) - bearing(start, end);
  const along = Math.atan2(Math.sin(distance) * Math.cos(angle), Math.cos(distance));
  if (along <= 0) return distanceKm(position, start);
  if (along >= length) return distanceKm(position, end);
  return Math.abs(Math.asin(Math.max(-1, Math.min(1, Math.sin(distance) * Math.sin(angle))))) * radiusKm;
}
