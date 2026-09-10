import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobNotFoundError, BlobPreconditionFailedError, type get, type head, type put } from "@vercel/blob";
import { BlobCatalog3SnapshotStore, ConcurrencyError, publishCatalog3ConditionsFiles, publishConditionsFiles } from "@/lib/storage";
import { SnapshotV11Schema, ConditionsV3Schema } from "@/lib/domain/catalog-public";
import { conditionSourceIds, emptyConditions, ConditionsV2Schema, CONDITIONS_COUNTRY_LIMIT, CONDITIONS_TOTAL_LIMIT } from "@/lib/domain/conditions";
import release3 from "../../data/catalog-releases/3.json";
import demo from "../../public/demo-snapshot.json";

const now = new Date(demo.generatedAt);
const latestPath = "catalogs/3/latest.json";
const previousPath = "catalogs/3/previous.json";
const countries = [...new Set(release3.locationIds.map((id) => id.slice(0, 2).toUpperCase()))].sort();
afterEach(() => vi.useRealTimers());
function snapshot(generatedAt = now.toISOString()) {
  const value = structuredClone(demo);
  for (const id of ["meteoalarm", "eea-aqi", "national-civil-alerts"] as const) Object.assign(value.providers[id], {
    partitions: Object.fromEntries(countries.map((country) => [country, value.providers[id].partitions.AT])),
  });
  return SnapshotV11Schema.parse({ ...value, schemaVersion: 11, catalogVersion: 3, generatedAt,
    locations: Object.fromEntries(release3.locationIds.map((id) => [id, Reflect.get(value.locations, id)
      || { level: "UNKNOWN", coverage: "partial", coverageGaps: [], delayedHazards: [], hazards: [] }])) });
}
function conditions() {
  return countries.map((countryCode) => ConditionsV3Schema.parse({ schemaVersion: 3, catalogVersion: 3, countryCode,
    generatedAt: now.toISOString(), producerCommitSha: null, sources: {}, sourceHealth: {},
    locations: Object.fromEntries(release3.locationIds.filter((id) => id.startsWith(`${countryCode.toLowerCase()}-`)).map((id) => [id, emptyConditions()])) }));
}
function blobs() {
  const values = new Map<string, { body: string; etag: string }>(); let revision = 0;
  const key = (path: string) => path.startsWith("https:") ? new URL(path).pathname.slice(1) : path;
  const info = (path: string) => {
    const entry = values.get(key(path)); if (!entry) throw new BlobNotFoundError();
    return { url: `https://unit.public.blob.vercel-storage.com/${key(path)}`, downloadUrl: `https://unit.public.blob.vercel-storage.com/${key(path)}`,
      pathname: key(path), contentDisposition: "inline", cacheControl: "60", uploadedAt: now, etag: entry.etag, contentType: "application/json", size: Buffer.byteLength(entry.body) };
  };
  const headBlob = vi.fn<typeof head>().mockImplementation(async (path) => info(path));
  const getBlob = vi.fn<typeof get>().mockImplementation(async (path) => {
    const entry = values.get(key(path)); if (!entry) return null;
    return { statusCode: 200, stream: new Blob([entry.body]).stream(), headers: new Headers(), blob: info(path) };
  });
  const putBlob = vi.fn<typeof put>().mockImplementation(async (path, body, options) => {
    const previous = values.get(path);
    if ((options.allowOverwrite === false && previous) || (options.ifMatch && options.ifMatch !== previous?.etag)) throw new BlobPreconditionFailedError();
    if (typeof body !== "string") throw new Error("Expected JSON");
    values.set(path, { body, etag: String(++revision) }); return info(path);
  });
  return { values, getBlob, headBlob, putBlob, seed(path: string, value: unknown) { values.set(path, { body: JSON.stringify(value), etag: String(++revision) }); },
    store: new BlobCatalog3SnapshotStore("token", getBlob, putBlob, headBlob) };
}
function noTraffic(blob: ReturnType<typeof blobs>) {
  expect(blob.getBlob).not.toHaveBeenCalled(); expect(blob.headBlob).not.toHaveBeenCalled(); expect(blob.putBlob).not.toHaveBeenCalled();
}

describe("inactive catalog3 snapshot storage", () => {
  it("creates only the missing versioned latest namespace, leaving legacy and previous untouched", async () => {
    const blob = blobs(); blob.seed("latest.json", demo); blob.seed("previous.json", demo);
    const old = new Map(blob.values);
    expect(await blob.store.readLatest()).toBeUndefined();
    expect(await blob.store.publish(snapshot(), undefined, now)).toMatchObject({ status: "published" });
    expect((await blob.store.readLatest())?.data).toEqual(snapshot());
    expect(blob.values.get("latest.json")).toEqual(old.get("latest.json")); expect(blob.values.get("previous.json")).toEqual(old.get("previous.json"));
    expect(blob.values.has(previousPath)).toBe(false);
    expect(blob.putBlob).toHaveBeenCalledWith(latestPath, expect.any(String), expect.objectContaining({ allowOverwrite: false }));
  });

  it.each(["missing ID", "same-count replacement", "legacy wire", "oversized", "future"])("rejects %s candidate before storage requests", async (mode) => {
    const blob = blobs(); const value = snapshot();
    if (mode === "missing ID" || mode === "same-count replacement") { value.locations["gb-unreviewed"] = value.locations[release3.locationIds[0]]; delete value.locations[release3.locationIds[0]]; if (mode === "missing ID") delete value.locations["gb-unreviewed"]; }
    if (mode === "legacy wire") Object.assign(value, { schemaVersion: 10, catalogVersion: 2 });
    if (mode === "future") value.generatedAt = new Date(now.getTime() + 300001).toISOString();
    if (mode === "oversized") {
      const hazardous = Object.values(value.locations).find((location) => location.hazards.length)!;
      hazardous.hazards[0].sourceName = "x".repeat(500 * 1024);
      expect(SnapshotV11Schema.safeParse(value).success).toBe(true);
    }
    await expect(blob.store.publish(value, undefined, now)).rejects.toThrow(); noTraffic(blob);
  });

  it.each([demo, { schemaVersion: 11 }])("does not treat malformed or wrong-version stored content as missing", async (value) => {
    const blob = blobs(); blob.seed(latestPath, value);
    await expect(blob.store.readLatest()).rejects.toThrow(); expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it("bounds stored snapshot bytes before parsing an otherwise valid padded JSON document", async () => {
    const blob = blobs(); blob.seed(latestPath, snapshot());
    const stored = blob.values.get(latestPath)!; stored.body = " ".repeat(500 * 1024) + stored.body;
    await expect(blob.store.readLatest()).rejects.toThrow(/large|limit|size|exceeds/i);
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it("propagates unexpected read failures and rejects first-creation races without overwriting", async () => {
    const blob = blobs(); blob.headBlob.mockRejectedValueOnce(new Error("transport failed"));
    await expect(blob.store.readLatest()).rejects.toThrow("transport failed");
    blob.seed(latestPath, snapshot()); const before = blob.values.get(latestPath);
    await expect(blob.store.publish(snapshot(), undefined, now)).rejects.toBeInstanceOf(ConcurrencyError);
    expect(blob.values.get(latestPath)).toEqual(before);
  });

  it.each([0, -60000])("leaves latest and previous untouched for equal/older candidate delta%s", async (delta) => {
    const blob = blobs(); blob.seed(latestPath, snapshot());
    const expected = await blob.store.readLatest(); const before = new Map(blob.values);
    expect(await blob.store.publish(snapshot(new Date(now.getTime() + delta).toISOString()), expected, now)).toMatchObject({ status: "unchanged" });
    expect(blob.values).toEqual(before); expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it("stages prior generation before latest, and safely retries a crash after previous succeeds", async () => {
    const blob = blobs(); const old = snapshot(new Date(now.getTime() - 60000).toISOString()); blob.seed(latestPath, old);
    const expected = await blob.store.readLatest(); const normalPut = blob.putBlob.getMockImplementation()!;
    blob.putBlob.mockImplementation(async (...args) => { if (args[0] === latestPath) throw new Error("latest unavailable"); return normalPut(...args); });
    await expect(blob.store.publish(snapshot(), expected, now)).rejects.toThrow("latest unavailable");
    expect(JSON.parse(blob.values.get(latestPath)!.body)).toEqual(old); expect(JSON.parse(blob.values.get(previousPath)!.body)).toEqual(old);
    expect(blob.putBlob.mock.calls.map(([path]) => path)).toEqual([previousPath, latestPath]);
    blob.putBlob.mockImplementation(normalPut);
    await expect(blob.store.publish(snapshot(), expected, now)).resolves.toMatchObject({ status: "published" });
    expect(JSON.parse(blob.values.get(latestPath)!.body)).toEqual(snapshot()); expect(JSON.parse(blob.values.get(previousPath)!.body)).toEqual(old);
  });

  it.each(["write failure", "wrong-version previous"])("does not advance latest when staging previous encounters %s", async (mode) => {
    const blob = blobs(); const old = snapshot(new Date(now.getTime() - 60000).toISOString()); blob.seed(latestPath, old);
    const expected = await blob.store.readLatest();
    if (mode === "wrong-version previous") blob.seed(previousPath, demo);
    else blob.putBlob.mockRejectedValue(new Error("previous failed"));
    await expect(blob.store.publish(snapshot(), expected, now)).rejects.toThrow();
    expect(JSON.parse(blob.values.get(latestPath)!.body)).toEqual(old);
    expect(blob.putBlob.mock.calls.some(([path]) => path === latestPath)).toBe(false);
  });

  it("rejects stale latest CAS without regressing the newer previous generation", async () => {
    const blob = blobs(); blob.seed(latestPath, snapshot(new Date(now.getTime() - 120000).toISOString()));
    const stale = await blob.store.readLatest();
    const winner = snapshot(new Date(now.getTime() - 30000).toISOString()); blob.seed(latestPath, winner); blob.seed(previousPath, winner);
    await expect(blob.store.publish(snapshot(), stale, now)).rejects.toBeInstanceOf(ConcurrencyError);
    expect(JSON.parse(blob.values.get(latestPath)!.body)).toEqual(winner); expect(JSON.parse(blob.values.get(previousPath)!.body)).toEqual(winner);
  });

  it("repairs an implausibly future previous generation before advancing latest", async () => {
    const blob = blobs(); const old = snapshot(new Date(now.getTime() - 60000).toISOString());
    blob.seed(latestPath, old); blob.seed(previousPath, snapshot("2099-01-01T00:00:00Z"));
    const expected = await blob.store.readLatest();
    await expect(blob.store.publish(snapshot(), expected, now)).resolves.toMatchObject({ status: "published" });
    expect(JSON.parse(blob.values.get(previousPath)!.body)).toEqual(old);
    expect(blob.putBlob.mock.calls.map(([path]) => path)).toEqual([previousPath, latestPath]);
  });

  it("bounds previous CAS conflict repair to two attempts without advancing latest", async () => {
    const blob = blobs(); const old = snapshot(new Date(now.getTime() - 60000).toISOString());
    blob.seed(latestPath, old); blob.seed(previousPath, snapshot(new Date(now.getTime() - 120000).toISOString()));
    const expected = await blob.store.readLatest();
    blob.putBlob.mockRejectedValue(new BlobPreconditionFailedError());
    await expect(blob.store.publish(snapshot(), expected, now)).rejects.toThrow();
    expect(blob.putBlob.mock.calls.map(([path]) => path)).toEqual([previousPath, previousPath]);
    expect(JSON.parse(blob.values.get(latestPath)!.body)).toEqual(old);
  });

  it("accepts exactly5-minute future boundary and repairs an implausibly future latest without preserving it", async () => {
    const blob = blobs(); blob.seed(latestPath, snapshot("2099-01-01T00:00:00Z"));
    const expected = await blob.store.readLatest();
    await expect(blob.store.publish(snapshot(new Date(now.getTime() + 300000).toISOString()), expected, now)).resolves.toMatchObject({ status: "published" });
    expect(blob.values.has(previousPath)).toBe(false);
  });
});

describe("inactive catalog3 conditions publication", () => {
  it("publishes all45 files with at most4 concurrent writes and never touches legacy paths", async () => {
    const blob = blobs(); let active = 0; let peak = 0;
    const normalPut = blob.putBlob.getMockImplementation()!;
    blob.putBlob.mockImplementation(async (...args) => { active++; peak = Math.max(peak, active); await new Promise<void>((resolve) => setImmediate(resolve));
      try { return await normalPut(...args); } finally { active--; } });
    expect(await publishCatalog3ConditionsFiles(conditions(), "token", blob)).toEqual({ published: countries, unchanged: [], failed: [] });
    expect(peak).toBe(4); expect(blob.putBlob).toHaveBeenCalledTimes(45);
    expect([...blob.values.keys()].sort()).toEqual(countries.map((code) => `catalogs/3/conditions/v3/${code}.json`));
  });

  it.each(["membership", "duplicate country", "wrong wire", "subset", "mixed generation", "mixed producer", "total size", "country size"])("rejects %s before storage traffic", async (mode) => {
    const blob = blobs(); const files = conditions();
    if (mode === "membership") { const id = Object.keys(files[0].locations)[0]; files[0].locations["ad-unreviewed"] = files[0].locations[id]; delete files[0].locations[id]; }
    if (mode === "duplicate country") files.push(files[0]);
    if (mode === "wrong wire") Object.assign(files[0], { schemaVersion: 2, catalogVersion: 2 });
    if (mode === "subset") files.pop();
    if (mode === "mixed generation") files[0].generatedAt = new Date(now.getTime() - 60000).toISOString();
    if (mode === "mixed producer") files[0].producerCommitSha = "a".repeat(40);
    if (mode === "total size" || mode === "country size") {
      for (const file of files) file.sources = Object.fromEntries(conditionSourceIds.map((id) => [id, { name: "Source", license: "License", officialUrl: `https://example.com/${"a".repeat(900)}`, licenseUrl: `https://example.com/${"b".repeat(900)}`, notice: "x".repeat(500) }]));
      if (mode === "country size") {
        const source = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/AT.json", "utf8")));
        const record = structuredClone(source.locations["at-vienna"]);
        for (const forecast of [record.weather, record.airQuality, record.marine]) if (forecast) for (const [key, value] of Object.entries(forecast)) {
          if (Array.isArray(value) && key !== "weatherCode") Reflect.set(forecast, key, value.map(() => 1.2345678901234567));
        }
        const gb = files.find(({ countryCode }) => countryCode === "GB")!;
        for (const id of Object.keys(gb.locations)) gb.locations[id] = structuredClone(record);
        expect(Buffer.byteLength(JSON.stringify(gb))).toBeGreaterThan(CONDITIONS_COUNTRY_LIMIT);
        // Keep the whole generation valid so country bytes, not missing files, trigger rejection.
      } else {
        expect(files.every((file) => Buffer.byteLength(JSON.stringify(file)) <= CONDITIONS_COUNTRY_LIMIT)).toBe(true);
        expect(files.reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file)), 0)).toBeGreaterThan(CONDITIONS_TOTAL_LIMIT);
      }
      for (const file of files) expect(ConditionsV3Schema.safeParse(file).success).toBe(true);
    }
    await expect(publishCatalog3ConditionsFiles(files, "token", blob)).rejects.toThrow(); noTraffic(blob);
  });

  it("reports bounded independent read/write failures and repairs only failed countries on replay", async () => {
    vi.useFakeTimers(); const blob = blobs(); const files = conditions(); const normalHead = blob.headBlob.getMockImplementation()!; const normalPut = blob.putBlob.getMockImplementation()!;
    blob.headBlob.mockImplementation(async (...args) => { if (args[0].endsWith("/AD.json")) throw new Error("read unavailable"); return normalHead(...args); });
    blob.putBlob.mockImplementation(async (...args) => { if (args[0].endsWith("/AL.json")) throw new Error("write unavailable"); return normalPut(...args); });
    const pending = publishCatalog3ConditionsFiles(files, "token", blob); await vi.runAllTimersAsync();
    expect(await pending).toEqual({ published: countries.filter((code) => !["AD", "AL"].includes(code)), unchanged: [], failed: [{ countryCode: "AD", code: "read_failed" }, { countryCode: "AL", code: "write_failed" }] });
    expect(blob.headBlob.mock.calls.filter(([path]) => path.endsWith("/AD.json"))).toHaveLength(3);
    expect(blob.putBlob.mock.calls.filter(([path]) => path.endsWith("/AL.json"))).toHaveLength(3);
    blob.headBlob.mockImplementation(normalHead); blob.putBlob.mockImplementation(normalPut);
    const replay = publishCatalog3ConditionsFiles(files, "token", blob); await vi.runAllTimersAsync();
    expect(await replay).toEqual({ published: ["AD", "AL"], unchanged: countries.filter((code) => !["AD", "AL"].includes(code)), failed: [] });
  });

  it("bounds existing country bytes and reports failure without overwriting otherwise valid JSON", async () => {
    const blob = blobs(); const files = conditions(); const path = `catalogs/3/conditions/v3/${files[0].countryCode}.json`;
    blob.seed(path, files[0]); const stored = blob.values.get(path)!; stored.body = " ".repeat(CONDITIONS_COUNTRY_LIMIT) + stored.body;
    const original = stored.body;
    const pending = publishCatalog3ConditionsFiles(files, "token", blob);
    const result = await pending;
    expect(result.failed).toEqual([{ countryCode: files[0].countryCode, code: "read_failed" }]);
    expect(result.published).toHaveLength(44); expect(blob.values.get(path)!.body).toBe(original);
    expect(blob.putBlob.mock.calls.some(([written]) => written === path)).toBe(false);
  });

  it("rejects wrong-country content at a legacy path before treating it as unchanged or overwriting", async () => {
    const blob = blobs();
    const austria = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/AT.json", "utf8")));
    const belgium = ConditionsV2Schema.parse(JSON.parse(readFileSync("public/conditions/v2/BE.json", "utf8")));
    blob.seed("conditions/v2/AT.json", belgium); const original = blob.values.get("conditions/v2/AT.json");
    const pending = publishConditionsFiles([austria], "token", blob);
    expect(await pending).toEqual({ published: [], unchanged: [], failed: [{ countryCode: "AT", code: "read_failed" }] });
    expect(blob.headBlob).toHaveBeenCalledTimes(3); expect(blob.putBlob).not.toHaveBeenCalled();
    expect(blob.values.get("conditions/v2/AT.json")).toEqual(original);
  });

  it("rereads a first-creation conflict and retains the concurrently newer file", async () => {
    vi.useFakeTimers(); const blob = blobs(); const files = conditions(); const file = files[0];
    const normalPut = blob.putBlob.getMockImplementation()!;
    blob.putBlob.mockImplementation(async (...args) => {
      if (args[0].endsWith(`/${file.countryCode}.json`)) {
        blob.seed(args[0], { ...file, generatedAt: new Date(now.getTime() + 60000).toISOString() }); throw new BlobPreconditionFailedError();
      }
      return normalPut(...args);
    });
    const pending = publishCatalog3ConditionsFiles(files, "token", { ...blob, now }); await vi.runAllTimersAsync();
    expect(await pending).toEqual({ published: countries.slice(1), unchanged: [file.countryCode], failed: [] });
    expect(blob.putBlob.mock.calls.filter(([path]) => path.endsWith(`/${file.countryCode}.json`))).toHaveLength(1);
  });

  it.each(["future", "invalid clock"])("rejects %s before any storage request", async (mode) => {
    const blob = blobs(); const files = conditions();
    if (mode === "future") for (const file of files) file.generatedAt = new Date(now.getTime() + 300001).toISOString();
    await expect(publishCatalog3ConditionsFiles(files, "token", { ...blob, now: mode === "invalid clock" ? new Date(NaN) : now })).rejects.toThrow();
    noTraffic(blob);
  });

  it("accepts exactly five minutes ahead and repairs a stored implausible future generation with its ETag", async () => {
    const blob = blobs(); const files = conditions();
    for (const file of files) file.generatedAt = new Date(now.getTime() + 300000).toISOString();
    const path = `catalogs/3/conditions/v3/${files[0].countryCode}.json`;
    blob.seed(path, { ...files[0], generatedAt: "2099-01-01T00:00:00Z" });
    const etag = blob.values.get(path)!.etag;
    expect(await publishCatalog3ConditionsFiles(files, "token", { ...blob, now })).toEqual({ published: countries, unchanged: [], failed: [] });
    expect(blob.putBlob).toHaveBeenCalledWith(path, expect.any(String), expect.objectContaining({ allowOverwrite: true, ifMatch: etag }));
    expect(ConditionsV3Schema.parse(JSON.parse(blob.values.get(path)!.body))).toEqual(files[0]);
  });
});

describe("strict legacy compatibility generation publication", () => {
  function legacyFile() {
    return ConditionsV2Schema.parse({ ...conditions().find(({ countryCode }) => countryCode === "AT")!, schemaVersion: 2, catalogVersion: 2 });
  }

  it.each(["equal-time different", "newer different"] as const)("does not credit a %s V2 file toward exact generation completion", async (mode) => {
    const blob = blobs(); const file = legacyFile(); const path = "conditions/v2/AT.json";
    const prior = { ...file, producerCommitSha: "a".repeat(40), ...(mode === "newer different" ? { generatedAt: new Date(now.getTime() + 1).toISOString() } : {}) };
    blob.seed(path, prior); const before = blob.values.get(path);
    expect(await publishConditionsFiles([file], "token", { ...blob, requireExactGeneration: true, now })).toEqual({
      published: [], unchanged: [], failed: [{ countryCode: "AT", code: "concurrent_update" }],
    });
    expect(blob.putBlob).not.toHaveBeenCalled(); expect(blob.values.get(path)).toEqual(before);
  });

  it("credits only an exactly equivalent existing V2 generation as unchanged", async () => {
    const blob = blobs(); const file = legacyFile(); blob.seed("conditions/v2/AT.json", file);
    expect(await publishConditionsFiles([file], "token", { ...blob, requireExactGeneration: true, now })).toEqual({ published: [], unchanged: ["AT"], failed: [] });
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps ordinary V2 future behavior and enables repair only in strict mode: %s", async (strict) => {
    const blob = blobs(); const file = legacyFile(); const path = "conditions/v2/AT.json";
    blob.seed(path, { ...file, generatedAt: "2099-01-01T00:00:00Z" }); const before = blob.values.get(path)!;
    const result = await publishConditionsFiles([file], "token", { ...blob, requireExactGeneration: strict, now });
    if (strict) {
      expect(result).toEqual({ published: ["AT"], unchanged: [], failed: [] });
      expect(blob.putBlob).toHaveBeenCalledWith(path, JSON.stringify(file), expect.objectContaining({ ifMatch: before.etag, allowOverwrite: true }));
      expect(JSON.parse(blob.values.get(path)!.body)).toEqual(file);
    } else {
      expect(result).toEqual({ published: [], unchanged: ["AT"], failed: [] });
      expect(blob.putBlob).not.toHaveBeenCalled(); expect(blob.values.get(path)).toEqual(before);
    }
  });

  it.each([300000, 300001])("uses the exact five-minute actual-clock boundary for strict V2 candidates at offset%s", async (offset) => {
    const blob = blobs(); const file = legacyFile(); file.generatedAt = new Date(now.getTime() + offset).toISOString();
    const pending = publishConditionsFiles([file], "token", { ...blob, requireExactGeneration: true, now });
    if (offset > 300000) { await expect(pending).rejects.toThrow(/future/); noTraffic(blob); }
    else expect(await pending).toEqual({ published: ["AT"], unchanged: [], failed: [] });
  });
});
