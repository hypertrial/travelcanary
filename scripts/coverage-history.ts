import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CompleteSnapshotSchema } from "../src/lib/snapshot-validation";
import { measureCapture } from "./coverage-measurement";

const count = z.number().int().nonnegative();
const TotalsSchema = z.object({ applicable: count, fullyChecked: count, partlyChecked: count, notChecked: count,
  freshFullyChecked: count, freshPartlyChecked: count, delayed: count }).superRefine((value, context) => {
  if (value.applicable !== value.fullyChecked + value.partlyChecked + value.notChecked
    || value.fullyChecked + value.partlyChecked !== value.freshFullyChecked + value.freshPartlyChecked + value.delayed
    || value.freshFullyChecked > value.fullyChecked || value.freshPartlyChecked > value.partlyChecked) {
    context.addIssue({ code: "custom", message: "Inconsistent coverage counts" });
  }
});
const SampleSchema = z.object({ schemaVersion: z.literal(1), measuredAt: z.string().datetime(), snapshotAt: z.string().datetime(),
  catalogVersion: z.number().int(), contractSha256: z.string().regex(/^[a-f0-9]{64}$/), totals: TotalsSchema });

export function summarizeCoverageHistory(input: unknown[]) {
  if (!input.length || input.length > 366) throw new Error("Provide 1–366 verifier reports");
  const samples = input.map((value) => SampleSchema.parse((value as { metrics?: { coverageMeasurement?: unknown } })?.metrics?.coverageMeasurement));
  samples.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  if (new Set(samples.map(({ measuredAt }) => measuredAt)).size !== samples.length) throw new Error("Duplicate measurement times");
  if (new Set(samples.map(({ contractSha256, catalogVersion }) => `${contractSha256}:${catalogVersion}`)).size !== 1) {
    throw new Error("Coverage contracts differ; report each contract separately");
  }
  const first = samples[0]; const last = samples.at(-1)!;
  return { schemaVersion: 1, samples: samples.length, firstAt: first.measuredAt, lastAt: last.measuredAt,
    contractSha256: first.contractSha256, first: first.totals, last: last.totals,
    meanFreshFullyCheckedPairs: samples.reduce((sum, sample) => sum + sample.totals.freshFullyChecked, 0) / samples.length,
    meanFreshPartlyCheckedPairs: samples.reduce((sum, sample) => sum + sample.totals.freshPartlyChecked, 0) / samples.length,
    limitation: "Arithmetic means of sampled pair counts, not time-weighted uptime or incident recall. Unsampled intervals are unknown." };
}

async function readJson(path: string, maximum: number) {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("Input must be a regular file");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw new Error("Input exceeds size limit");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await file.close(); }
}

async function main() {
  const [mode, ...paths] = process.argv.slice(2);
  if (mode === "history") {
    if (!paths.length || paths.length > 366) throw new Error("Usage: coverage:measure history <1–366 verifier JSON files>");
    const reports: unknown[] = [];
    for (const path of paths) reports.push(await readJson(path, 2 * 1024 * 1024));
    console.log(JSON.stringify(summarizeCoverageHistory(reports), null, 2));
  } else if (mode === "capture" && paths.length === 2) {
    const snapshot = CompleteSnapshotSchema.parse(await readJson(paths[0], 500_000));
    const cases = measureCapture(snapshot, await readJson(paths[1], 128 * 1024));
    console.log(JSON.stringify({ snapshotAt: snapshot.generatedAt, cases,
      limitation: "Reviewed sample capture only. Evidence URL, publication time and headline must jointly identify a reviewed official incident; this is not population-wide recall." }, null, 2));
    if (cases.some(({ missed, unexpected }) => missed.length || unexpected.length)) process.exitCode = 1;
  } else throw new Error("Usage: coverage:measure history <reports...> | capture <snapshot.json> <cases.json>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
