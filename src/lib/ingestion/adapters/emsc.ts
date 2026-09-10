import { ExpandedAggregateSourceResultSchema as AggregateSourceResultSchema } from "../../domain/catalog-state";
import { type AggregateSourceResult, type NormalizedEvent } from "../../domain/schemas";
import { distanceKm } from "../../geospatial";
import { fetchAllowlisted, readJsonWithLimit } from "../fetch";
import { recordSourceDiagnostics, type ExpandedIngestionContext as IngestionContext, type ExpandedSourceAdapter } from "../types";

type Feature = { id?: unknown; geometry?: { coordinates?: unknown }; properties?: { mag?: unknown; time?: unknown; lastupdate?: unknown; unid?: unknown } };

export class EmscAdapter implements ExpandedSourceAdapter {
  readonly catalogVersion = 3 as const;
  readonly id = "emsc" as const;
  readonly cadence = "fast" as const;
  async fetch(context: IngestionContext): Promise<AggregateSourceResult> {
    const checkedAt = context.now.toISOString();
    const start = new Date(context.now.getTime() - 24 * 60 * 60_000).toISOString();
    const query = new URLSearchParams({ format: "json", minmag: "4.5", starttime: start, minlat: "25", maxlat: "75", minlon: "-30", maxlon: "55", limit: "200", orderby: "time" });
    try {
      const response = await fetchAllowlisted(context.fetch, `https://www.seismicportal.eu/fdsnws/event/1/query?${query}`, ["www.seismicportal.eu"]);
      const payload = response.status === 204 ? { features: [] } : await readJsonWithLimit(response, 2 * 1024 * 1024) as { features?: unknown };
      const events: NormalizedEvent[] = [];
      if (!Array.isArray(payload.features)) throw new Error("EMSC response has no features array");
      const overflow = payload.features.length >= 200;
      let malformed = 0;
      let parseable = 0;
      const features = payload.features.slice(0, 200) as Feature[];
      for (const feature of features) {
        const coordinatesValue = feature.geometry?.coordinates;
        const coordinates = Array.isArray(coordinatesValue) ? [Number(coordinatesValue[0]), Number(coordinatesValue[1])] as [number, number] : null;
        const magnitude = Number(feature.properties?.mag);
        const occurred = Date.parse(String(feature.properties?.time || ""));
        const featureId = String(feature.id || "");
        const updated = Date.parse(String(feature.properties?.lastupdate || ""));
        if (!coordinates || coordinates.some((value) => !Number.isFinite(value)) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90
          || !featureId || !Number.isFinite(occurred) || occurred > context.now.getTime() + 5 * 60_000 || updated > context.now.getTime() + 5 * 60_000
          || !Number.isFinite(magnitude)) {
          malformed += 1;
          continue;
        }
        parseable += 1;
        if (magnitude < 4.5) continue;
        const radiusKm = magnitude >= 5.5 ? 250 : 100;
        for (const location of context.locations) {
          if (distanceKm(coordinates, location.centroid) > radiusKm) continue;
          const expiresAt = new Date(occurred + 6 * 60 * 60_000).toISOString();
          if (Date.parse(expiresAt) <= context.now.getTime()) continue;
          const externalId = String(feature.properties?.unid || featureId);
          events.push({
            id: `emsc:${externalId}:${location.id}`, sourceId: "emsc", providerId: "emsc", type: "earthquake", level: "ELEVATED", timing: "ACTIVE",
            headline: `Preliminary earthquake report near ${location.name}.`,
            explanation: `EMSC reports a magnitude ${magnitude.toFixed(1)} earthquake about ${Math.round(distanceKm(coordinates, location.centroid))} km from ${location.name}. Local impact is not yet confirmed.`,
            action: "Check local emergency information and be prepared for aftershocks.", affectedArea: `${location.name} and nearby areas`,
            geometry: { kind: "locations", ids: [location.id] }, startsAt: new Date(occurred).toISOString(), endsAt: expiresAt,
            earthquake: { ids: [...new Set([featureId, externalId])], coordinates, magnitude },
            sourceUpdatedAt: new Date(Number.isFinite(updated) ? updated : occurred).toISOString(), checkedAt, expiresAt,
            sourceName: "EMSC", sourceUrl: `https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=${encodeURIComponent(featureId)}`, confidence: "MEDIUM",
          });
        }
      }
      if (features.length > 0 && parseable === 0) throw new Error("EMSC response contains no parseable records");
      const status = malformed || overflow ? "partial" : "ok";
      const errors = [malformed ? `${malformed} malformed EMSC records were skipped` : null, overflow ? "EMSC event limit reached" : null].filter(Boolean).join("; ") || null;
      const sourceUpdatedAt = events.map((event) => event.sourceUpdatedAt).sort().at(-1) || null;
      recordSourceDiagnostics(context, {
        recordsExamined: payload.features.length,
        matchedLocations: new Set(events.flatMap((event) => event.geometry.kind === "locations" ? event.geometry.ids : [])).size,
      });
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt, events, status, error: errors });
    } catch (error) {
      return AggregateSourceResultSchema.parse({ sourceId: this.id, checkedAt, sourceUpdatedAt: null, events: [], status: "failed", error: String(error).slice(0, 300) });
    }
  }
}
