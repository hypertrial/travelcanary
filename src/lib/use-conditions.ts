import { ConditionsV3Schema } from "./domain/catalog-public";
import { useEffect, useState } from "react";
import { CONDITIONS_COUNTRY_LIMIT, ConditionsSchema, type Conditions as ConditionsV2 } from "./domain/conditions";
import { catalogV2Paths, catalogV2SnapshotUrl, catalogV3LocalSnapshotPath, catalogV3Paths, catalogV3SnapshotUrl } from "./catalog-paths";

type Conditions = ConditionsV2 | import("zod").infer<typeof ConditionsV3Schema>;

const cache = new Map<string, { promise: Promise<Conditions>; until: number }>();
export function conditionsUrl(snapshotUrl: string | null, country: string, catalogVersion?: 2 | 3): string | null {
  if (!/^[A-Z]{2}$/.test(country)) return null;
  catalogVersion ??= snapshotUrl === catalogV3Paths.demoSnapshot || catalogV3SnapshotUrl(snapshotUrl) ? 3 : 2;
  if (catalogVersion === 3) {
    if (snapshotUrl === catalogV3Paths.demoSnapshot || snapshotUrl === catalogV2Paths.demoSnapshot) return `/${catalogV3Paths.conditions}${country}.json`;
    if (snapshotUrl === catalogV3LocalSnapshotPath) return `/live/${catalogV3Paths.conditions}${country}.json`;
    const source = catalogV3SnapshotUrl(snapshotUrl) || catalogV2SnapshotUrl(snapshotUrl);
    return source ? new URL(`/${catalogV3Paths.conditions}${country}.json`, source).href : null;
  }
  if (snapshotUrl === catalogV2Paths.demoSnapshot) return `/${catalogV2Paths.conditions}${country}.json`;
  const url = catalogV2SnapshotUrl(snapshotUrl);
  return url ? new URL(`${catalogV2Paths.conditions}${country}.json`, url).href : null;
}

export async function loadConditions(url: string, country: string, ids: string[], fetchImpl = fetch, expectedCatalogVersion?: 2 | 3): Promise<Conditions> {
  const path = new URL(url, "https://local.invalid").pathname;
  const catalogVersion = path.startsWith("/catalogs/") ? 3 : 2;
  if ((catalogVersion === 3 && path !== `/${catalogV3Paths.conditions}${country}.json`)
    || (expectedCatalogVersion && expectedCatalogVersion !== catalogVersion)) throw new Error("Conditions catalog namespace mismatch");
  const key = `${catalogVersion}:${url}:${ids.join(",")}`;
  const existing = cache.get(key);
  if (existing && existing.until > Date.now()) { cache.delete(key); cache.set(key, existing); return existing.promise; }
  const promise = (async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(6000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Local conditions unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > CONDITIONS_COUNTRY_LIMIT) throw new Error("Conditions country file too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = (catalogVersion === 3 ? ConditionsV3Schema : ConditionsSchema).parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (result.countryCode !== country || Object.keys(result.locations).sort().join(",") !== [...ids].sort().join(",")) throw new Error("Conditions catalog mismatch");
    return result;
  })();
  const entry = { promise, until: Date.now() + 5 * 60_000 };
  cache.delete(key); cache.set(key, entry);
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  try { return await promise; } catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
}

export function useConditions(snapshotUrl: string | null, country: string, ids: string[], catalogVersion: 2 | 3 = 2) {
  const url = conditionsUrl(snapshotUrl, country, catalogVersion);
  const [result, setResult] = useState<{ key: string; url: string | null; data: Conditions | null; failed: boolean; retrying: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const catalogKey = ids.join(",");
  const key = JSON.stringify([url, country, catalogVersion, catalogKey]);
  useEffect(() => {
    if (!url) return;
    let active = true;
    void loadConditions(url, country, catalogKey.split(","), fetch, catalogVersion).then((data) => {
      if (active) setResult({ key, url, data, failed: false, retrying: false });
    }, () => { if (active) setResult({ key, url, data: null, failed: true, retrying: false }); });
    return () => { active = false; };
  }, [url, country, catalogKey, attempt, catalogVersion, key]);
  return {
    ...(result?.key === key ? result : { url, data: null, failed: !url, retrying: false }),
    retry: () => {
      setResult({ key, url, data: null, failed: false, retrying: true });
      setAttempt((value) => value + 1);
    },
  };
}
