import { appendFileSync, chmodSync } from "node:fs";
import { conditionSourceIds } from "../src/lib/domain/conditions";
import { sourceIds } from "../src/lib/domain/schemas";
import { writeNativeFiles } from "../src/lib/native-setup";

const home = "/tmp/travelcanary-systemd-home";
const paths = writeNativeFiles({ home, repository: process.cwd(), node: process.execPath, port: 3199, environment: {} });
appendFileSync(paths.environmentFile, [
  `INGESTION_DISABLED_SOURCES=${sourceIds.join(",")}`,
  `CONDITIONS_DISABLED_SOURCES=${conditionSourceIds.join(",")}`,
  "CONTEXT_FEEDS_ENABLED=false",
  "GDELT_ENABLED=false",
  "GFM_ENABLED=false",
  "",
].join("\n"));
chmodSync(paths.environmentFile, 0o600);
console.log(paths.webUnit);
console.log(paths.collectorUnit);
