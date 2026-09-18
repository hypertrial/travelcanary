import { PublicationManifestV1Schema, PublicationPointerV1Schema, type PublicationManifestV1 } from "./domain/publication";
import { parseCatalogSnapshot } from "./domain/catalog-public";

const cache = new Map<string, { manifest: PublicationManifestV1; root: string; until: number }>();

function publicationRoot(pointerUrl: string) {
  const url = new URL(pointerUrl, window.location.href);
  const suffix = "catalogs/3/publication/latest.json";
  const sameOriginProxy = url.origin === window.location.origin && url.pathname === "/api/v1/data";
  if (!(url.protocol === "https:" || url.protocol === "http:" && url.origin === window.location.origin)
    || url.username || url.password || url.hash || (!sameOriginProxy && (url.search || !url.pathname.endsWith(suffix)))) {
    throw new Error("Publication pointer URL is outside the Catalog 3 namespace");
  }
  if (sameOriginProxy) return `${url.origin}/`;
  url.pathname = url.pathname.slice(0, -suffix.length);
  url.search = ""; url.hash = "";
  return url.href;
}

function objectUrl(root: string, pathname: string) {
  if (!/^catalogs\/3\/(?:objects\/sha256\/[a-f0-9]{64}\.json|generations\/[a-f0-9]{64}\/manifest\.json)$/.test(pathname)) {
    throw new Error("Publication object path is invalid");
  }
  return new URL(pathname, root).href;
}

async function sha256(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function boundedText(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) throw new Error("Publication object is unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Publication object is too large");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Publication object is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function loadPublication(pointerUrl: string, fetchImpl: typeof fetch = fetch) {
  const pointerResponse = await fetchImpl(pointerUrl, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(6000) });
  const pointerBody = await boundedText(pointerResponse, 64_000);
  const pointer = PublicationPointerV1Schema.parse(JSON.parse(pointerBody));
  const root = publicationRoot(pointerResponse.url || pointerUrl);
  const manifestResponse = await fetchImpl(objectUrl(root, pointer.manifestPath), { cache: "force-cache", redirect: "error", signal: AbortSignal.timeout(6000) });
  const manifestBody = await boundedText(manifestResponse, 512_000);
  if (await sha256(manifestBody) !== pointer.manifestSha256) throw new Error("Publication manifest digest mismatch");
  const manifest = PublicationManifestV1Schema.parse(JSON.parse(manifestBody));
  if (manifest.producerCommitSha !== pointer.producerCommitSha || manifest.stateRevision !== pointer.stateRevision
    || manifest.collectionRevision !== pointer.collectionRevision || manifest.ingestionFence !== pointer.ingestionFence) {
    throw new Error("Publication pointer and manifest disagree");
  }
  cache.set(pointerUrl, { manifest, root, until: Date.now() + 5 * 60_000 });
  return { pointer, manifest, root };
}

export async function loadPublicationSnapshot(pointerUrl: string, fetchImpl: typeof fetch = fetch) {
  const publication = await loadPublication(pointerUrl, fetchImpl);
  const response = await fetchImpl(objectUrl(publication.root, publication.manifest.snapshot.path), { cache: "force-cache", redirect: "error", signal: AbortSignal.timeout(6000) });
  const body = await boundedText(response, publication.manifest.snapshot.bytes);
  if (new TextEncoder().encode(body).byteLength !== publication.manifest.snapshot.bytes || await sha256(body) !== publication.manifest.snapshot.sha256) {
    throw new Error("Publication snapshot digest mismatch");
  }
  return parseCatalogSnapshot(JSON.parse(body));
}

export async function publicationConditionsUrl(pointerUrl: string, countryCode: string, fetchImpl: typeof fetch = fetch) {
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  let current = cache.get(pointerUrl);
  if (!current || current.until <= Date.now()) {
    const loaded = await loadPublication(pointerUrl, fetchImpl);
    current = { manifest: loaded.manifest, root: loaded.root, until: Date.now() + 5 * 60_000 };
  }
  const reference = current.manifest.conditions.find(({ countryCode: code }) => code === countryCode);
  return reference ? { url: objectUrl(current.root, reference.path), reference } : null;
}
