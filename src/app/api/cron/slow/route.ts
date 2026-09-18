import { handleCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function GET(request: Request) { return handleCron(request, "slow"); }
export function HEAD(request: Request) { return handleCron(request, "slow"); }
