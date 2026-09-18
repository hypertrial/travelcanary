import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { conditionSourceIds } from "../src/lib/domain/conditions";
import { sourceIds } from "../src/lib/domain/schemas";

const directory = join(process.env.RUNNER_TEMP || "/tmp", "travelcanary-systemd");
const repository = resolve(process.env.TRAVELCANARY_SYSTEMD_REPOSITORY || process.cwd());
mkdirSync(directory, { recursive: true });
const replacements: Record<string, string> = {
  "@REPOSITORY@": repository, "@NODE@": process.execPath,
  "@NEXT@": join(repository, "node_modules/next/dist/bin/next"), "@PORT@": "3199",
  "@WEB_ENVIRONMENT_FILE@": "/etc/travelcanary/web-environment",
  "@COLLECTOR_ENVIRONMENT_FILE@": "/etc/travelcanary/collector-environment",
  "@PRIVATE_DIRECTORY@": "/var/lib/travelcanary/private", "@PUBLIC_DIRECTORY@": "/var/lib/travelcanary/public",
  "@CACHE_DIRECTORY@": "/var/lib/travelcanary/cache",
};
writeFileSync(join(directory, "web-environment"), [
  "TRAVELCANARY_RUNTIME=local", "TRAVELCANARY_PUBLIC_DATA_DIR=/var/lib/travelcanary/public", "",
].join("\n"), { mode: 0o600 });
writeFileSync(join(directory, "collector-environment"), [
  "TRAVELCANARY_RUNTIME=local", "TRAVELCANARY_PRIVATE_DATA_DIR=/var/lib/travelcanary/private",
  "TRAVELCANARY_PUBLIC_DATA_DIR=/var/lib/travelcanary/public", "TRAVELCANARY_CACHE_DIR=/var/lib/travelcanary/cache",
  "LOCAL_CONDITIONS_ENABLED=true", `INGESTION_DISABLED_SOURCES=${sourceIds.join(",")}`,
  `CONDITIONS_DISABLED_SOURCES=${conditionSourceIds.join(",")}`, "CONTEXT_FEEDS_ENABLED=false", "GDELT_ENABLED=false",
  "GFM_ENABLED=false", "",
].join("\n"), { mode: 0o600 });
for (const name of ["travelcanary-web.service", "travelcanary-collector.service", "travelcanary-collector-once.service"]) {
  let unit = readFileSync(join("deploy/systemd", name), "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) unit = unit.replaceAll(placeholder, value);
  if (unit.includes("@")) throw new Error(`Unresolved systemd placeholder in ${name}`);
  const output = join(directory, name); writeFileSync(output, unit); console.log(output);
}
