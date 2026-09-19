import { ConditionsV3Schema } from "./domain/catalog-public";
import { useEffect, useState } from "react";
import { CONDITIONS_COUNTRY_LIMIT, ConditionsSchema, type Conditions as ConditionsV2 } from "./domain/conditions";
import { catalogV3Paths } from "./catalog-paths";
import { publicationConditionsUrl } from "./publication-client";

type Conditions = ConditionsV2 | import("zod").infer<typeof ConditionsV3Schema>;

const cache = new Map<string, { promise: Promise<Conditions>; until: number }>();

export async function loadConditions(url: string, country: string, ids: string[], fetchImpl = fetch, expectedCatalogVersion?: 2 | 3,
  reference?: { sha256: string; bytes: number }): Promise<Conditions> {
  const path = new URL(url, "https://local.invalid").pathname;
  const publicPath = path.startsWith("/live/") ? path.slice("/live".length) : path;
  const immutableV3 = /\/catalogs\/3\/objects\/sha256\/[a-f0-9]{64}\.json$/.test(publicPath);
  const catalogVersion = publicPath.startsWith("/catalogs/") || immutableV3 ? 3 : 2;
  if ((catalogVersion === 3 && !immutableV3 && publicPath !== `/${catalogV3Paths.conditions}${country}.json`)
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
        if (size > Math.min(CONDITIONS_COUNTRY_LIMIT, reference?.bytes ?? CONDITIONS_COUNTRY_LIMIT)) throw new Error("Conditions country file too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = new TextDecoder().decode(bytes);
    if (reference) {
      if (size !== reference.bytes) throw new Error("Conditions object size mismatch");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (sha !== reference.sha256) throw new Error("Conditions object digest mismatch");
    }
    const result = (catalogVersion === 3 ? ConditionsV3Schema : ConditionsSchema).parse(JSON.parse(body));
    if (result.countryCode !== country || Object.keys(result.locations).sort().join(",") !== [...ids].sort().join(",")) throw new Error("Conditions catalog mismatch");
    return result;
  })();
  const entry = { promise, until: Date.now() + 5 * 60_000 };
  cache.delete(key); cache.set(key, entry);
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  try { return await promise; } catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
}

export function useConditions(snapshotUrl: string | null, country: string, ids: string[], catalogVersion: 2 | 3 = 3) {
  const [url, setUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; url: string | null; data: Conditions | null; failed: boolean; retrying: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const catalogKey = ids.join(",");
  const key = JSON.stringify([snapshotUrl, country, catalogVersion, catalogKey]);
  useEffect(() => {
    if (!snapshotUrl || catalogVersion !== 3) return;
    let active = true;
    void (async () => {
      let resolvedUrl: string | null = null;
      try {
        const resolved = await publicationConditionsUrl(snapshotUrl, country);
        if (!resolved) throw new Error("Conditions country is absent from publication");
        resolvedUrl = resolved.url;
        if (active) setUrl(resolved.url);
        const data = await loadConditions(resolved.url, country, catalogKey.split(","), fetch, 3, resolved.reference);
        if (active) setResult({ key, url: resolved.url, data, failed: false, retrying: false });
      } catch { if (active) setResult({ key, url: resolvedUrl, data: null, failed: true, retrying: false }); }
    })();
    return () => { active = false; };
  }, [snapshotUrl, country, catalogKey, attempt, catalogVersion, key]);
  return {
    ...(result?.key === key ? result : { url, data: null, failed: !url, retrying: false }),
    retry: () => {
      setResult({ key, url, data: null, failed: false, retrying: true });
      setAttempt((value) => value + 1);
    },
  };
}
