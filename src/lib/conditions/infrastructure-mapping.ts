import { z } from "zod";
import raw from "../../../data/infrastructure-condition-mapping.json";
import { locations } from "../data";

const schema = z.object({ schemaVersion: z.literal(1), reviewedAt: z.string().date(), sources: z.array(z.string().url()).min(3),
  sweden: z.record(z.string(), z.array(z.string()).min(1)),
  germany: z.array(z.tuple([z.string(), z.string().regex(/^A\d{1,3}$/)])).length(30),
  cyprus: z.record(z.string(), z.array(z.string())), unsupported: z.array(z.object({ locationId: z.string(), reason: z.string().min(10) })) });
const mapping = schema.parse(raw); const ids = new Set(locations.map(({ id }) => id));
if (mapping.germany.some(([id]) => !ids.has(id)) || Object.values(mapping.sweden).flat().some((id) => !ids.has(id)) || Object.keys(mapping.cyprus).some((id) => !ids.has(id)) || mapping.unsupported.some(({ locationId }) => !ids.has(locationId))) throw new Error("Infrastructure mapping has unknown destinations");
if (new Set(mapping.germany.map(([id]) => id)).size !== 30 || new Set(mapping.germany.map(([, road]) => road)).size > 24) throw new Error("Infrastructure motorway mapping is invalid");
const cyprusIds = locations.filter(({ countryCode }) => countryCode === "CY").map(({ id }) => id).sort();
if (Object.keys(mapping.cyprus).sort().join(",") !== cyprusIds.join(",")) throw new Error("Infrastructure Cyprus mapping is incomplete");
const cyprusAliases = Object.values(mapping.cyprus).flat();
if (new Set(cyprusAliases).size !== cyprusAliases.length || cyprusAliases.some((alias) => alias !== alias.trim().toLowerCase() || !alias)) throw new Error("Infrastructure Cyprus aliases are ambiguous");
const unsupported = new Set(mapping.unsupported.map(({ locationId }) => locationId));
if (new Set(mapping.unsupported.map(({ locationId }) => locationId)).size !== mapping.unsupported.length
  || Object.entries(mapping.cyprus).some(([id, aliases]) => aliases.length === 0 && !unsupported.has(id))) throw new Error("Infrastructure unsupported mappings are incomplete");
export const autobahnRoadIds = [...new Set(mapping.germany.map(([, road]) => road))].sort();
export const autobahnLocationsByRoad = new Map(autobahnRoadIds.map((road) => [road, mapping.germany.filter(([, value]) => value === road).map(([id]) => id)]));
export const swedenLocationsByCounty = new Map(Object.entries(mapping.sweden));
export const infrastructureMapping = mapping;
