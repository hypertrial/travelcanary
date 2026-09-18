import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildCatalog3Conditions } from "../src/lib/catalog-projections";
import { catalogMembershipHash } from "../src/lib/catalog-membership";
import { catalog3CoverageTarget } from "../src/lib/coverage-measurement";
import { serializeCatalog3Conditions } from "../src/lib/conditions/serialization";
import { ConditionsV3Schema, SnapshotV11Schema } from "../src/lib/domain/catalog-public";
import { PublicationManifestV1Schema, PublicationPointerV1Schema, publicationManifestPath, publicationObjectPath } from "../src/lib/domain/publication";
import { publicationSha256 } from "../src/lib/publication-store";
import { createEmptyState } from "../src/lib/risk-state";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = SnapshotV11Schema.parse(JSON.parse(await readFile(resolve(sourceRoot, "public/catalogs/3/demo-snapshot.json"), "utf8")));
const now = new Date(snapshot.generatedAt);
const state = createEmptyState(now);
const conditions = await Promise.all(buildCatalog3Conditions(state, now, {}).map(async (empty) => {
  const legacyPath = resolve(sourceRoot, `public/conditions/v2/${empty.countryCode}.json`);
  try {
    const legacy = JSON.parse(await readFile(legacyPath, "utf8"));
    return ConditionsV3Schema.parse({ ...legacy, schemaVersion: 3, catalogVersion: 3 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return empty;
  }
}));
const objects = new Map<string, string>();
const reference = (body: string, generatedAt: string) => {
  const sha256 = publicationSha256(body); const path = publicationObjectPath(sha256);
  objects.set(`public/${path}`, body);
  return { path, sha256, bytes: Buffer.byteLength(body), generatedAt };
};
const snapshotBody = JSON.stringify(snapshot);
const manifest = PublicationManifestV1Schema.parse({
  schemaVersion: 1, catalogVersion: 3, generatedAt: now.toISOString(), producerCommitSha: null,
  stateRevision: 0, collectionRevision: 1, ingestionFence: 1,
  membershipHash: catalogMembershipHash(Object.keys(snapshot.locations)),
  coverageContractHash: publicationSha256(JSON.stringify(catalog3CoverageTarget)), complete: true,
  snapshot: reference(snapshotBody, snapshot.generatedAt),
  conditions: conditions.map((file) => ({ ...reference(serializeCatalog3Conditions(file), file.generatedAt), countryCode: file.countryCode }))
    .sort((a, b) => a.countryCode.localeCompare(b.countryCode)),
  status: { state: "degraded", codes: ["demo/static"], collectorLastSuccess: now.toISOString() },
});
const manifestBody = JSON.stringify(manifest);
const manifestSha256 = publicationSha256(manifestBody);
const manifestPath = publicationManifestPath(manifestSha256);
const pointer = PublicationPointerV1Schema.parse({
  schemaVersion: 1, catalogVersion: 3, manifestPath, manifestSha256, publishedAt: now.toISOString(), producerCommitSha: null,
  stateRevision: 0, collectionRevision: 1, ingestionFence: 1,
});
objects.set(`public/${manifestPath}`, manifestBody);
objects.set("public/catalogs/3/publication/latest.json", JSON.stringify(pointer));

for (const [path, body] of objects) {
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== body) throw new Error(`Demo artifact is out of date: ${path}`);
  } else {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, body);
  }
}
console.log(`Prepared atomic Catalog 3 demo: ${Object.keys(snapshot.locations).length} destinations, ${conditions.length} countries`);
