import { handleMaintenance } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Maintenance publishes a pruned state without contacting an upstream source.
export function GET(request: Request) { return handleMaintenance(request); }
export function HEAD(request: Request) { return handleMaintenance(request); }
