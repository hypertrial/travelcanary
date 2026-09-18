import { getLocalPublicationStore } from "@/lib/local-server";
import { checkPublicationHealth, checkPublicHealth, unavailablePublicationHealth } from "@/lib/public-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const HEALTH_CACHE_MS = 60_000;
type ProductionHealth = Awaited<ReturnType<typeof checkPublicHealth>>;
let cachedHealth: { key: string; expiresAt: number; value: ProductionHealth } | null = null;
let pendingHealth: { key: string; value: Promise<ProductionHealth> } | null = null;

function healthCacheKey() {
  return [process.env.TRAVELCANARY_PUBLICATION_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL, process.env.VERCEL_GIT_COMMIT_SHA, process.env.TRAVELCANARY_RELEASE_SHA].join("\0");
}

async function productionHealth() {
  const key = healthCacheKey(); const now = Date.now();
  if (cachedHealth?.key === key && cachedHealth.expiresAt > now) return cachedHealth.value;
  if (pendingHealth?.key === key) return pendingHealth.value;
  const value = checkPublicHealth({}).then((result) => {
    cachedHealth = { key, expiresAt: Date.now() + HEALTH_CACHE_MS, value: result };
    return result;
  }).finally(() => { if (pendingHealth?.key === key) pendingHealth = null; });
  pendingHealth = { key, value };
  return value;
}

export async function GET(request?: Request) {
  if (request && new URL(request.url).search) return Response.json({ schemaVersion: 1, status: "degraded" }, {
    status: 400, headers: { "Cache-Control": "no-store" },
  });
  if (process.env.TRAVELCANARY_RUNTIME !== "local") {
    const result = await productionHealth();
    return Response.json(result, { status: result.available ? 200 : 503,
      headers: { "Cache-Control": "public, max-age=0, s-maxage=60, must-revalidate" } });
  }
  try {
    const result = await checkPublicationHealth(getLocalPublicationStore(), { runtime: "filesystem",
      expectedSha: process.env.TRAVELCANARY_RELEASE_SHA || process.env.VERCEL_GIT_COMMIT_SHA });
    return Response.json(result, { status: result.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(unavailablePublicationHealth(new Date(), "filesystem"), { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
