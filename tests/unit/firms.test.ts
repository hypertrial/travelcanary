import { describe, expect, it, vi } from "vitest";
import { FirmsAdapter, parseFirmsCsv } from "@/lib/ingestion/adapters/firms";
import { locations } from "@/lib/data";
import { createSourceDiagnostics } from "@/lib/ingestion/types";
import { writeArrayBuffer } from "geotiff";

const now = new Date("2026-08-27T12:00:00.000Z");
const header = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";
const emptyEffisTiff = writeArrayBuffer(new Float32Array(700 * 470), { width: 700, height: 470 });

function effisResponse(url: string): Response | null {
  return url.includes("maps.effis.emergency.copernicus.eu") ? new Response(emptyEffisTiff, { status: 200 }) : null;
}

describe("NASA FIRMS active-fire adapter", () => {
  it("accepts high VIIRS confidence and rejects nominal, low, stale, and malformed rows", () => {
    const csv = [
      header,
      "47.4979,19.0402,320,1,1,2026-08-27,1100,N20,VIIRS,n,2,300,5,D",
      "47.5000,19.0500,320,1,1,2026-08-27,1055,N20,VIIRS,h,2,300,5,D",
      "47.5100,19.0600,320,1,1,2026-08-27,1050,N20,VIIRS,l,2,300,5,D",
      "47.5200,19.0700,320,1,1,2026-08-26,1000,N20,VIIRS,n,2,300,5,D",
      "broken,19.0800,320,1,1,2026-08-27,1040,N20,VIIRS,n,2,300,5,D",
      ",19.0800,320,1,1,2026-08-27,1040,N20,VIIRS,h,2,300,5,D",
      "47.5300,19.0800,320,1,1,2026-08-27,1040,Terra,MODIS,90,2,300,5,D",
    ].join("\n");
    const parsed = parseFirmsCsv(csv, "VIIRS_NOAA20_NRT", now);
    expect(parsed.detections).toHaveLength(1);
    expect(parsed.detections.map(({ confidence }) => confidence)).toEqual(["high"]);
    expect(parsed.invalidRows).toBe(3);
    expect(parsed.validRows).toBe(4);
  });

  it("uses the exact MODIS confidence boundary", () => {
    const csv = [
      header,
      "47.4979,19.0402,320,1,1,2026-08-27,1100,Terra,MODIS,80,6,300,5,D",
      "47.5000,19.0500,320,1,1,2026-08-27,1100,Aqua,MODIS,79,6,300,5,D",
    ].join("\n");
    expect(parseFirmsCsv(csv, "MODIS_NRT", now).detections).toHaveLength(1);
  });

  it("publishes one bounded elevated event per affected destination without leaking the key", async () => {
    const destination = locations.find(({ id }) => id === "es-las-palmas-de-gran-canaria")!;
    const urls: string[] = [];
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const effis = effisResponse(url);
      if (effis) return effis;
      const body = url.includes("VIIRS_NOAA20_NRT")
        ? `${header}\n${destination.centroid[1]},${destination.centroid[0]},320,1,1,2026-08-27,1100,N20,VIIRS,h,2,300,5,D\n`
        : `${header}\n`;
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const result = await new FirmsAdapter("a".repeat(32)).fetch({ now, locations: [destination], fetch: fetchMock });
    expect(result.status).toBe("ok");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      sourceId: "effis-active-fire", providerId: "effis-active-fire", type: "wildfire",
      level: "ELEVATED", confidence: "MEDIUM", sourceName: "NASA FIRMS",
      geometry: { kind: "locations", ids: ["es-las-palmas-de-gran-canaria"] },
    });
    expect(urls).toHaveLength(4);
    expect(urls.filter((url) => url.includes("firms.modaps")).every((url) => url.includes("/-25,25,45,72/1"))).toBe(true);
    expect(urls.some((url) => url.includes("VIIRS_SNPP"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("a".repeat(32));
  });

  it("keeps valid dataset evidence when another dataset is malformed", async () => {
    const destination = locations.find(({ id }) => id === "hu-budapest")!;
    const diagnostics = createSourceDiagnostics();
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      const effis = effisResponse(url);
      if (effis) return effis;
      if (url.includes("VIIRS_NOAA20_NRT")) return new Response("not,csv", { status: 200 });
      const body = url.includes("VIIRS_NOAA21_NRT")
        ? `${header}\n${destination.centroid[1]},${destination.centroid[0]},320,1,1,2026-08-27,1100,N21,VIIRS,h,2,300,5,D\n`
        : `${header}\n`;
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const result = await new FirmsAdapter("a".repeat(32)).fetch({ now, locations: [destination], fetch: fetchMock, diagnostics });
    expect(result).toMatchObject({ status: "partial", error: "1 FIRMS dataset requests failed" });
    expect(result.events).toHaveLength(1);
    expect(diagnostics.outcomeCodes).toEqual([
      "effis_ok",
      "firms_VIIRS_NOAA20_NRT_failed", "firms_VIIRS_NOAA21_NRT_ok", "firms_MODIS_NRT_ok",
    ]);
  });

  it("fails closed when every dataset response is malformed", async () => {
    const result = await new FirmsAdapter("a".repeat(32)).fetch({
      now,
      locations: [],
      fetch: (async (input) => effisResponse(String(input)) || new Response("not,csv", { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({ status: "partial", events: [], error: "3 FIRMS dataset requests failed" });
  });

  it("fails when successful datasets contain only malformed rows", async () => {
    const result = await new FirmsAdapter("a".repeat(32)).fetch({
      now,
      locations: [],
      fetch: (async (input) => effisResponse(String(input)) || new Response(`${header}\nbroken,19.0,320,1,1,2026-08-27,1100,N20,VIIRS,h,2,300,5,D\n`, { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({ status: "partial", events: [] });
    expect(result.error).toMatch(/malformed FIRMS rows/);
  });

  it("uses healthy keyless EFFIS without a configured FIRMS map key", async () => {
    let requests = 0;
    const result = await new FirmsAdapter("").fetch({
      now, locations,
      fetch: (async (input) => { requests += 1; return effisResponse(String(input)) || new Response(null, { status: 500 }); }) as typeof fetch,
    });
    expect(result).toMatchObject({ status: "ok", events: [], error: null });
    expect(requests).toBe(1);
  });

  it("retains elevated hotspot evidence when an optional perimeter window fails", async () => {
    const destination = locations.find(({ id }) => id === "hu-budapest")!;
    const raster = new Float32Array(700 * 470);
    raster[245 * 700 + 440] = 1;
    const activeEffisTiff = writeArrayBuffer(raster, { width: 700, height: 470 });
    vi.stubEnv("EFFIS_PERIMETERS_ENABLED", "true");
    try {
      const result = await new FirmsAdapter("").fetch({
        now, locations: [destination],
        fetch: (async (input) => {
          const url = String(input);
          if (url.includes("REQUEST=GetMap") && url.includes("LAYERS=all.hs")) return new Response(activeEffisTiff, { status: 200 });
          if (url.includes("REQUEST=GetFeatureInfo") && url.includes("QUERY_LAYERS=all.hs.query")) return new Response("Feature 0:\nlatitude = 47.4979\nlongitude = 19.0402\nacq_datetime = 2026-08-27T11:00:00Z\ninstrument = VIIRS", { status: 200 });
          if (url.includes("LAYERS=effis.nrt.ba.poly")) return new Response("Feature 0:\ncurrent = true", { status: 200 });
          return new Response("unavailable", { status: 503 });
        }) as typeof fetch,
      });
      expect(result).toMatchObject({ status: "partial", events: [{ level: "ELEVATED", geometry: { kind: "locations", ids: ["hu-budapest"] } }] });
      expect(result.error).toMatch(/perimeter windows failed/);
    } finally { vi.unstubAllEnvs(); }
  });

  it("upgrades an intersecting current EFFIS perimeter without extending the detection lifecycle", async () => {
    const destination = locations.find(({ id }) => id === "hu-budapest")!;
    const raster = new Float32Array(700 * 470);
    raster[245 * 700 + 440] = 1;
    const activeEffisTiff = writeArrayBuffer(raster, { width: 700, height: 470 });
    const gml = `<wfs:FeatureCollection><gml:featureMember><ms:effis.nrt.ba.poly><ms:msGeometry><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>18.9 47.4 19.2 47.4 19.2 47.6 18.9 47.6 18.9 47.4</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></ms:msGeometry></ms:effis.nrt.ba.poly></gml:featureMember></wfs:FeatureCollection>`;
    let perimeterTime: string | null = null;
    const confirmationTimes: string[] = [];
    vi.stubEnv("EFFIS_PERIMETERS_ENABLED", "true");
    try {
      const result = await new FirmsAdapter("").fetch({
        now, locations: [destination],
        fetch: (async (input) => {
          const url = new URL(String(input));
          const request = String(url.searchParams.get("REQUEST") || url.searchParams.get("request")).toLowerCase();
          const layers = String(url.searchParams.get("LAYERS") || url.searchParams.get("layers"));
          if (request === "getmap" && layers === "all.hs") return new Response(activeEffisTiff, { status: 200 });
          if (request === "getfeatureinfo" && layers === "all.hs") return new Response("Feature 0:\nlatitude = 47.4979\nlongitude = 19.0402\nacq_datetime = 2026-08-27T11:00:00Z\ninstrument = VIIRS", { status: 200 });
          if (request === "getfeatureinfo") {
            confirmationTimes.push(String(url.searchParams.get("time")));
            return new Response(url.searchParams.get("time") === "2026-08-27" ? "Feature 0:\ncurrent = true" : "Search returned no results", { status: 200 });
          }
          if (request === "getfeature") { perimeterTime = url.searchParams.get("time"); return new Response(gml, { status: 200 }); }
          return new Response("unexpected", { status: 500 });
        }) as typeof fetch,
      });
      expect(result).toMatchObject({ status: "ok", events: [{ level: "HIGH", confidence: "MEDIUM", expiresAt: "2026-08-27T23:00:00.000Z" }] });
      expect(perimeterTime).toBe("2026-08-27");
      expect(confirmationTimes).toEqual(["2026-08-27", "2026-08-29"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("fails when EFFIS and every configured FIRMS dataset fail", async () => {
    const result = await new FirmsAdapter("a".repeat(32)).fetch({
      now, locations: [], fetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });
    expect(result).toMatchObject({ status: "failed", events: [], error: "All active-fire transports failed" });
  });
});
