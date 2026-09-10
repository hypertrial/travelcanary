import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildPendingCatalog3Snapshot, buildPendingCatalog3Conditions } from "../src/lib/catalog-projections";
import { SnapshotV11Schema, ConditionsV3Schema } from "../src/lib/domain/catalog-public";
import { CompleteSnapshotV10Schema } from "../src/lib/snapshot-validation";
import { createEmptyState } from "../src/lib/risk-state";
import { CONDITIONS_TOTAL_LIMIT, ConditionsV2Schema } from "../src/lib/domain/conditions";
import { catalog3ConditionsCountryLimit } from "../src/lib/conditions/publication-budget";
import { serializeCatalog3Conditions } from "../src/lib/conditions/serialization";
import { catalogV2CountryCodes } from "../src/lib/domain/contract-identities";

const legacy = CompleteSnapshotV10Schema.parse(JSON.parse(await readFile("public/demo-snapshot.json", "utf8")));
const now = new Date(legacy.generatedAt); const state = createEmptyState(now);
const pending = buildPendingCatalog3Snapshot(state, now);
const providers = Object.fromEntries(Object.entries(legacy.providers).map(([id, provider]) => [id, provider.partitions ? {
  ...provider, partitions: { ...pending.providers[id as keyof typeof pending.providers].partitions, ...provider.partitions },
} : provider]));
const snapshot = SnapshotV11Schema.parse({ ...pending, dataHealth: "delayed", providers, locations: { ...pending.locations, ...legacy.locations } });
const files = buildPendingCatalog3Conditions(state, now, {});
for (const country of catalogV2CountryCodes) {
  const file = ConditionsV2Schema.parse(JSON.parse(await readFile(`public/conditions/v2/${country}.json`, "utf8")));
  const delta = now.getTime() - Date.parse(file.generatedAt);
  const times = new Set(["checkedAt", "sourceUpdatedAt", "startAt", "expiresAt", "observedAt", "occurredAt"]);
  // Synthetic demo only: preserve each record's relative age and expiry, while
  // giving all45 files one deterministic demo generation and no production SHA.
  const retimed = JSON.parse(JSON.stringify(file, (key, value) => times.has(key) && typeof value === "string"
    ? new Date(Date.parse(value) + delta).toISOString() : value));
  files[files.findIndex((candidate) => candidate.countryCode === country)] = ConditionsV3Schema.parse({ ...retimed,
    generatedAt: now.toISOString(), producerCommitSha: null, schemaVersion: 3, catalogVersion: 3 });
}
const sizes = files.map((file) => Buffer.byteLength(serializeCatalog3Conditions(file)) + 1);
if (sizes.some((bytes, index) => bytes > catalog3ConditionsCountryLimit(files[index].countryCode))
  || sizes.reduce((sum, bytes) => sum + bytes, 0) > CONDITIONS_TOTAL_LIMIT) throw new Error("Demo conditions exceed publication budgets");
if (Buffer.byteLength(JSON.stringify(snapshot)) + 1 > 500_000) throw new Error("Demo snapshot exceeds publication budget");
const artifacts = new Map<string, string>([["public/catalogs/3/demo-snapshot.json", `${JSON.stringify(snapshot)}\n`],
  ...files.map((file) => [`public/catalogs/3/conditions/v3/${file.countryCode}.json`, `${serializeCatalog3Conditions(file)}\n`] as const)]);
for (const [path, body] of artifacts) {
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== body) throw new Error(`Demo artifact is out of date: ${path}`);
  } else {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, body);
  }
}
console.log(`Prepared catalog3 demo: ${Object.keys(snapshot.locations).length} destinations, ${files.length} countries; additions are explicitly pending`);
