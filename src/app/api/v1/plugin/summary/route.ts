import { getLocalDatabase } from "@/lib/local-server";
import { localPluginSummary } from "@/lib/local-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.TRAVELCANARY_RUNTIME !== "local") return Response.json({ error: "Self-hosted summary is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    return Response.json(localPluginSummary(getLocalDatabase()), { headers: { "Cache-Control": "public, max-age=60, stale-if-error=300" } });
  } catch {
    return Response.json({ error: "Summary is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
