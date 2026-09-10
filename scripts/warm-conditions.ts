// One resumable pass. The server owns the lease, due cohorts and weighted quota ledger.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyProduction, type ProductionVerificationReport } from "./verify-production";

export function conditionsWarmNextAction(responseOk: boolean, resultStatus: unknown,
  verification: Pick<ProductionVerificationReport, "blockers" | "warnings" | "metrics">) {
  const releasePending = verification.blockers.some(({ code }) => code === "conditions_sha_mismatch");
  const otherBlockers = verification.blockers.filter(({ code }) => code !== "conditions_sha_mismatch");
  if (!responseOk) return "Inspect the conditions route failure before another pass.";
  if (otherBlockers.length) return "Resolve the remaining Production blockers before another warm-up.";
  if (resultStatus === "partial" || releasePending) return "Re-run after at least 105 seconds. State resumes due work; do not reset quotas.";
  const overdue = verification.warnings.find(({ code }) => code === "conditions_source_health_persistent" || code === "conditions_stale_infrastructure");
  if (overdue) return `Investigate persistent conditions sources: ${overdue.message}`;
  if (verification.warnings.some(({ code }) => code === "conditions_source_health" || /^conditions_(?:weather|air_quality|marine)_incomplete$/.test(code))) {
    return "Wait for the next hourly conditions pass, then run verification again.";
  }
  return "Conditions publication matches the deployed release; no additional warm-up is required.";
}

async function main() {
  const origin = new URL(process.env.PRODUCTION_ORIGIN || "https://travelcanary.org");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Warm-up requires an HTTPS origin");
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is required; never place it in a command-line argument");
  const expectedSha = process.env.EXPECTED_COMMIT_SHA?.trim();
  if (!expectedSha) throw new Error("EXPECTED_COMMIT_SHA is required to verify release convergence");
  const response = await fetch(new URL("/api/cron/conditions", origin), { redirect: "error", signal: AbortSignal.timeout(59000), headers: { Authorization: `Bearer ${secret}` } });
  const result = await response.json() as { status?: unknown };
  const verification = await verifyProduction({ origin: origin.origin, expectedSha, expectLocalConditions: true });
  const nextAction = conditionsWarmNextAction(response.ok, result.status, verification);
  console.log(JSON.stringify({ status: response.status, result, verification: {
    status: verification.status, blockers: verification.blockers, warnings: verification.warnings,
    releaseSha: verification.metrics.releaseSha, conditions: verification.metrics.conditions,
  }, nextAction }, null, 2));
  if (!response.ok || result.status === "partial" || verification.blockers.length) process.exitCode = 1;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedUrl) await main();
