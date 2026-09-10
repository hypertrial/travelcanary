import { handleConditions } from "@/lib/cron";

export const runtime = "nodejs";
export const maxDuration = 60;
export function GET(request: Request) { return handleConditions(request); }
