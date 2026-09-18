import { handleConditions } from "@/lib/cron";

export const runtime = "nodejs";
export const maxDuration = 300;
export function GET(request: Request) { return handleConditions(request); }
export function HEAD(request: Request) { return handleConditions(request); }
