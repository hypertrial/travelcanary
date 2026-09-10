import { getLocalDatabase } from "@/lib/local-server";
import { isAllowlistedPublicObjectKey } from "@/lib/local-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  const key = Array.isArray(segments) ? segments.join("/") : "";
  if (!isAllowlistedPublicObjectKey(key)) return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const object = getLocalDatabase().readPublic(key);
    if (!object) return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const etag = `"${object.revision}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(object.value, { headers: {
      "Cache-Control": "public, max-age=60, stale-if-error=300",
      "Content-Type": "application/json; charset=utf-8",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "Public data is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
