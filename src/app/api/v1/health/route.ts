import { getLocalDatabase } from "@/lib/local-server";
import { localHealth } from "@/lib/local-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.TRAVELCANARY_RUNTIME !== "local") return Response.json({
    schemaVersion: 1, status: "ok", runtime: "vercel", catalogVersion: process.env.NEXT_PUBLIC_CATALOG_VERSION === "3" ? 3 : 2,
  }, { headers: { "Cache-Control": "no-store" } });
  try {
    const result = localHealth(getLocalDatabase());
    return Response.json(result, { status: result.status === "degraded" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ schemaVersion: 1, status: "degraded", runtime: "sqlite", catalogVersion: 3 }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
