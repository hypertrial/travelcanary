import { describe, expect, it } from "vitest";
import mapping from "../../data/italy-flood-zone-mapping.json";
import { locations } from "@/lib/data";
import { fetchItPartition, italianFloodBulletin } from "@/lib/ingestion/adapters/national-civil-alerts-it";
import { CatalogPartitionedSourceResultSchema, type IngestionState } from "@/lib/domain/catalog-state";
import { catalogV3CountryCodes } from "@/lib/domain/contract-identities";
import { createEmptyState, mergeSourceResults } from "@/lib/risk";

const api = "https://api.github.com/repos/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica";
const latest = "a".repeat(40); const oldest = "c".repeat(40);
const now = new Date("2026-08-30T10:00:00Z");
const green = "Assenza di fenomeni significativi prevedibili / NESSUNA ALLERTA";
const zones = [...new Set(mapping.mappings.flatMap(({ zoneNames }) => zoneNames))];
while (zones.length < 187) zones.push(`Fixture zone ${zones.length}`);
function topology(red: boolean) {
  return { type: "Topology", objects: { warning: { geometries: zones.map((name) => ({ properties: {
    "Nome zona": name, "Rappresentata nella mappa": red && name === "Aniene" ? "ALLERTA ROSSA" : green,
    "Per rischio idraulico": green, "Per rischio temporali": green, "Per rischio idrogeologico": green,
  } })) } } };
}
type File = { name: string; red?: boolean; fail?: boolean };
async function collect(files: File[], at = now, truncated = false, state?: IngestionState,
  discovery: { count?: number; baseSha?: string; mergeBaseSha?: string } = {}) {
  const calls: string[] = [];
  const descriptions = files.map(({ name }) => ({ filename: `files/topojson/${name}`, status: "added", raw_url: "https://untrusted.invalid/ignored" }));
  const fetchMock = async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.startsWith(`${api}/commits?path=files/topojson&per_page=`)) return Response.json([
      { sha: latest, commit: { committer: { date: at.toISOString() } } },
      { sha: "b".repeat(40), commit: { committer: { date: at.toISOString() } } },
      { sha: oldest, commit: { committer: { date: at.toISOString() } } },
      ...Array.from({ length: (discovery.count ?? 3) - 3 }, () => ({ sha: oldest, commit: { committer: { date: at.toISOString() } } })),
    ]);
    if (url === `${api}/commits/${latest}`) return Response.json({ files: descriptions.slice(0, 1) });
    if (url === `${api}/compare/${oldest}...${latest}?per_page=1`) return Response.json({
      base_commit: { sha: discovery.baseSha ?? oldest }, merge_base_commit: { sha: discovery.mergeBaseSha ?? oldest },
      files: truncated ? [...descriptions, ...Array.from({ length: 300 - descriptions.length }, (_, i) => ({ filename: `other/${i}` }))] : descriptions,
    });
    const file = files.find(({ name }) => url === `https://raw.githubusercontent.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica/${latest}/files/topojson/${name}`);
    if (file) return file.fail ? new Response("Unavailable", { status: 503 }) : Response.json(topology(Boolean(file.red)));
    throw new Error(`Unexpected request: ${url}`);
  };
  return { result: await fetchItPartition({ now: at, locations, fetch: fetchMock as typeof fetch, state }), calls };
}
const romeEvents = (result: Awaited<ReturnType<typeof fetchItPartition>>) => result.events.filter(({ geometry }) => geometry.kind === "locations" && geometry.ids.includes("it-rome"));

describe("Italian flood bulletin periods", () => {
  it("keeps today's red warning when the latest commit only changes green tomorrow", async () => {
    const { result, calls } = await collect([{ name: "20260830_1000_tomorrow.json" }, { name: "20260830_1000_today.json", red: true }]);
    expect(result.status).toBe("ok"); expect(result.checkedLocationIds).toContain("it-rome");
    expect(romeEvents(result)).toMatchObject([{ level: "SEVERE", timing: "ACTIVE", endsAt: "2026-08-30T22:00:00.000Z", sourceUpdatedAt: "2026-08-30T08:00:00.000Z" }]);
    expect(calls).toHaveLength(4);
    expect(calls.some((url) => url.includes("untrusted.invalid"))).toBe(false);
  });

  it("keeps distinct active and upcoming warnings from the same issuance", async () => {
    const { result } = await collect([{ name: "20260830_1000_tomorrow.json", red: true }, { name: "20260830_1000_today.json", red: true }]);
    const events = romeEvents(result);
    expect(events).toHaveLength(2); expect(new Set(events.map(({ id }) => id)).size).toBe(2);
    expect(events.map(({ timing }) => timing).sort()).toEqual(["ACTIVE", "UPCOMING"]);
  });

  it.each([false, true])("fails coverage closed while keeping tomorrow evidence when current bulletin is missing or failed (%s)", async (failed) => {
    const { result } = await collect([{ name: "20260830_1000_tomorrow.json", red: true }, ...(failed ? [{ name: "20260830_1000_today.json", fail: true }] : [])]);
    expect(result.status).toBe("partial"); expect(result.checkedLocationIds).toEqual([]);
    expect(result.unavailableLocationIds).toContain("it-rome"); expect(romeEvents(result)[0]).toMatchObject({ level: "SEVERE", timing: "UPCOMING" });
  });

  it.each([
    { name: "20260830_2400_today.json", at: now },
    { name: "20260830_1206_today.json", at: now },
    { name: "20260829_0000_tomorrow.json", at: new Date("2026-08-30T12:00:00Z") },
  ])("rejects invalid, future, or stale issuance despite fresh commit time ($name)", async ({ name, at }) => {
    const { result, calls } = await collect([{ name, red: true }, { name: "20260830_1000_tomorrow.json", red: true }], at);
    expect(result.status).toBe("partial"); expect(result.checkedLocationIds).toEqual([]);
    expect(romeEvents(result)).toMatchObject([{ timing: "UPCOMING", sourceUpdatedAt: "2026-08-30T08:00:00.000Z" }]);
    expect(calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/"))).toHaveLength(1);
  });

  it("chooses a later green correction and retires only the successful period when tomorrow fails", async () => {
    const { result } = await collect([
      { name: "20260830_0900_today.json", red: true }, { name: "20260830_1000_today.json" },
      { name: "20260830_1000_tomorrow.json", fail: true },
    ]);
    expect(result.status).toBe("partial"); expect(romeEvents(result)).toEqual([]);
    expect(result.removedEventPrefixes).toContain("it:flood-bulletin:20260830:");
    expect(result.removedEventPrefixes).not.toContain("it:flood-bulletin:20260831:");
  });

  it("retires legacy warning IDs only for a successfully corrected period during partial delivery", async () => {
    const state = createEmptyState(now);
    const context = { now, locations, fetch };
    const today = italianFloodBulletin(topology(true), context, now.toISOString(), { startsAt: "2026-08-29T22:00:00.000Z", endsAt: "2026-08-30T22:00:00.000Z" });
    const tomorrow = italianFloodBulletin(topology(true), context, now.toISOString(), { startsAt: "2026-08-30T22:00:00.000Z", endsAt: "2026-08-31T22:00:00.000Z" });
    state.events = [
      { ...romeEvents(today)[0], id: "it:flood-bulletin:2026-08-29:it-rome", transportId: "dpc-flood-bulletin", partitionCountryCode: "IT" },
      { ...romeEvents(tomorrow)[0], id: "it:flood-bulletin:2026-08-30:it-rome", transportId: "dpc-flood-bulletin", partitionCountryCode: "IT" },
    ];
    const { result } = await collect([{ name: "20260830_1000_today.json" }, { name: "20260830_1000_tomorrow.json", fail: true }], now, false, state);
    const publication = CatalogPartitionedSourceResultSchema.parse({ sourceId: "national-civil-alerts", checkedAt: now.toISOString(),
      partitions: Object.fromEntries(catalogV3CountryCodes.map((country) => [country, country === "IT" ? { ...result, transports: { "dpc-flood-bulletin": result } }
        : { status: "disabled", sourceUpdatedAt: null, events: [], error: null, limitationCode: "runtime_country_disabled" }])) });
    const merged = mergeSourceResults(state, [publication], now);
    expect(merged.events.map(({ id }) => id)).toEqual(["it:flood-bulletin:2026-08-30:it-rome"]);
  });

  it("rejects a possibly truncated changed-file inventory", async () => {
    await expect(collect([{ name: "20260830_1000_today.json" }, { name: "20260830_1000_tomorrow.json" }], now, true)).rejects.toThrow(/complete|truncat|limit/i);
  });

  it.each([{ count: 9 }, { baseSha: latest }, { mergeBaseSha: latest }])("rejects oversized history or mismatched ancestry before raw fetching (%j)", async (discovery) => {
    await expect(collect([{ name: "20260830_1000_today.json" }, { name: "20260830_1000_tomorrow.json" }], now, false, undefined, discovery))
      .rejects.toThrow(/limit|incomplete/i);
  });

  it("checks only the current date when the next 24 hours stay inside the autumn 25-hour day", async () => {
    const { result } = await collect([{ name: "20261024_1200_tomorrow.json", red: true }], new Date("2026-10-24T22:30:00Z"));
    expect(result.status).toBe("ok"); expect(romeEvents(result)[0]).toMatchObject({ timing: "ACTIVE", endsAt: "2026-10-25T23:00:00.000Z" });
  });

  it("requires the third intersecting date across the spring 23-hour day", async () => {
    const { result } = await collect([{ name: "20260328_1200_today.json" }, { name: "20260328_1200_tomorrow.json", red: true }], new Date("2026-03-28T22:30:00Z"));
    expect(result.status).toBe("partial"); expect(result.checkedLocationIds).toEqual([]);
    expect(romeEvents(result)[0]).toMatchObject({ timing: "UPCOMING", endsAt: "2026-03-29T22:00:00.000Z" });
  });
});
