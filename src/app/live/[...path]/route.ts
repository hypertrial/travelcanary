import { getLocalPublicationStore } from "@/lib/local-server";
import { publicationSha256 } from "@/lib/publication-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const key = /^catalogs\/3\/(?:publication\/latest\.json|generations\/[a-f0-9]{64}\/manifest\.json|objects\/sha256\/[a-f0-9]{64}\.json)$/;

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  const pathname = Array.isArray(segments) ? segments.join("/") : "";
  if (!key.test(pathname)) return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const object = await getLocalPublicationStore().read(pathname, pathname.includes("/objects/") ? 2_000_000 : 512_000);
    if (!object) return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const etag = `"${publicationSha256(object.body)}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(object.body, { headers: {
      "Cache-Control": pathname.endsWith("latest.json") ? "public, max-age=30, stale-if-error=120" : "public, max-age=31536000, immutable",
      "Content-Type": "application/json; charset=utf-8",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "Public data is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
