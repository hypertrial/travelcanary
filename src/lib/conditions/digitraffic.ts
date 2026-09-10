import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import booleanIntersects from "@turf/boolean-intersects";
import { locations } from "../data";
import { locationPolygon } from "../geospatial";
import { InfrastructureIncidentSchema, type LocationConditions } from "../domain/conditions";

const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const line = z.array(point).min(2).max(10000);
const geometry = z.discriminatedUnion("type", [z.object({ type: z.literal("Point"), coordinates: point }),
  z.object({ type: z.literal("LineString"), coordinates: line }), z.object({ type: z.literal("MultiLineString"), coordinates: z.array(line).min(1).max(20) })]);
const geoSchema = z.object({ type: z.literal("FeatureCollection"), features: z.array(z.object({ type: z.literal("Feature"), geometry,
  properties: z.object({ situationId: z.string(), version: z.number().int() }) })).max(500) });
const timestamp = z.string().datetime({ offset: true });
const record = z.object({ "@_type": z.string(), "@_version": z.coerce.number().int(), situationRecordVersionTime: timestamp,
  probabilityOfOccurrence: z.string(), validity: z.object({ validityStatus: z.string(), validityTimeSpecification: z.object({ overallStartTime: timestamp, overallEndTime: timestamp.optional() }) }),
  roadOrCarriagewayOrLaneManagementType: z.string().optional(), });
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];

/** Join the documented DATEX closure class to the Simple JSON geometry by ID AND version. */
export function parseDigitraffic(xml: string, geo: unknown, now: Date) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported traffic XML");
  const root = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml)?.payload;
  if (!root || root.publicationCreator?.nationalIdentifier !== "Fintraffic" || root.publicationCreator?.country !== "FI") throw new Error("Invalid traffic authority");
  const features = geoSchema.parse(geo).features;
  const situations = array(root.situation);
  if (situations.length > 500) throw new Error("Traffic situation overflow");
  const result: Record<string, LocationConditions["infrastructureIncidents"]> = Object.fromEntries(locations.filter((location) => location.countryCode === "FI").map(({ id }) => [id, []]));
  for (const input of situations) {
    const situation = z.object({ "@_id": z.string(), headerInformation: z.object({ confidentiality: z.string(), informationStatus: z.string() }), situationRecord: z.unknown() }).parse(input);
    if (situation.headerInformation.confidentiality !== "noRestriction" || situation.headerInformation.informationStatus !== "real") continue;
    const records = array(situation.situationRecord).map((item) => record.parse(item));
    // A contemporaneous accident plus roadClosed is deliberately narrower than generic lane closures or planned works.
    if (!records.some((item) => /(?:^|:)Accident$/.test(item["@_type"]) && item.probabilityOfOccurrence === "certain")) continue;
    for (const item of records.filter((item) => item.roadOrCarriagewayOrLaneManagementType === "roadClosed")) {
      const updated = Date.parse(item.situationRecordVersionTime); const validity = item.validity;
      const starts = Date.parse(validity.validityTimeSpecification.overallStartTime);
      const end = validity.validityTimeSpecification.overallEndTime;
      if (item.probabilityOfOccurrence !== "certain" || !["active", "definedByValidityTimeSpec"].includes(validity.validityStatus)
        || updated > now.getTime() + 300000 || now.getTime() - updated > 86400000 || starts > now.getTime()
        || (end && Date.parse(end) <= now.getTime()) || (!end && validity.validityStatus !== "active")) continue;
      const feature = features.find((feature) => feature.properties.situationId === situation["@_id"] && feature.properties.version === item["@_version"]);
      if (!feature) throw new Error("Traffic geometry/version unavailable");
      for (const location of locations.filter((location) => location.countryCode === "FI")) {
        if (!booleanIntersects(feature, locationPolygon(location))) continue;
        result[location.id].push(InfrastructureIncidentSchema.parse({ id: situation["@_id"], sourceId: "digitraffic", sourceUpdatedAt: item.situationRecordVersionTime,
          checkedAt: now.toISOString(), expiresAt: new Date(Math.min(now.getTime() + 3600000, end ? Date.parse(end) : Infinity)).toISOString(),
          startsAt: new Date(starts).toISOString(), endsAt: end || null, estimatedRestorationAt: null, kind: "road-closure",
          status: "active", scope: "destination", scopeLabel: location.name, sourceUrl: "https://liikennetilanne.fintraffic.fi/" }));
      }
    }
  }
  let overflow = 0;
  for (const id of Object.keys(result)) {
    result[id] = [...new Map(result[id].map((item) => [item.id, item])).values()].sort((a, b) => b.sourceUpdatedAt!.localeCompare(a.sourceUpdatedAt!) || a.id.localeCompare(b.id));
    overflow += Math.max(0, result[id].length - 3); result[id] = result[id].slice(0, 3);
  }
  return { locations: result, overflow };
}
