import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sourceIds } from "../src/lib/domain/schemas";
import { conditionSourceIds } from "../src/lib/domain/conditions";

// This fixture owns only its unique Compose project and disposable private volumes.
const root = mkdtempSync(join(tmpdir(), "tc-docker-recovery-"));
const project = `tc-recovery-${randomUUID().slice(0, 8)}`;
function run(args: string[], capture = false) {
  const result = spawnSync("docker", args, { cwd: root, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  assert.equal(result.status, 0, result.error?.message || `Docker command failed: ${args[0]}`);
  return result.stdout as Buffer;
}
const compose = (args: string[], capture = false) => run(["compose", "--env-file", join(root, ".travelcanary/docker.env"), ...args], capture);
let once: string | undefined;
try {
  for (const directory of ["bin", "scripts", ".travelcanary"]) mkdirSync(join(root, directory), { mode: 0o700 });
  for (const file of ["bin/travelcanary", "scripts/fetch-health.mjs", "scripts/restore-options.mjs"]) copyFileSync(file, join(root, file));
  const disabled = `LOCAL_CONDITIONS_ENABLED: "true"\n      INGESTION_DISABLED_SOURCES: ${JSON.stringify(sourceIds.join(","))}\n      CONDITIONS_DISABLED_SOURCES: ${JSON.stringify(conditionSourceIds.join(","))}\n      CONTEXT_FEEDS_ENABLED: "false"\n      GFM_ENABLED: "false"\n      GDELT_ENABLED: "false"`;
  const yaml = `name: ${project}\n` + readFileSync("compose.yaml", "utf8").replaceAll("travelcanary:local", "travelcanary:ci").replaceAll('LOCAL_CONDITIONS_ENABLED: "true"', disabled);
  writeFileSync(join(root, "compose.yaml"), yaml);
  writeFileSync(join(root, ".travelcanary/docker.env"), "TRAVELCANARY_PORT=0\n", { mode: 0o600 });
  writeFileSync(join(root, ".travelcanary/install.json"), JSON.stringify({ runtime: "docker", port: 3000, environmentFile: join(root, ".travelcanary/docker.env") }), { mode: 0o600 });
  compose(["run", "--rm", "--no-deps", "-T", "collector", "node", "--import", "tsx", "--input-type=module", "-e", "import {LocalDatabase,initializeLocalRuntime} from './src/lib/local-storage.ts'; const db=new LocalDatabase(); initializeLocalRuntime(db); db.close();"]);
  const bytes = compose(["run", "--rm", "--no-deps", "-T", "collector", "bin/travelcanary", "backup", "-"], true);
  const candidate = join(root, "backup.db"); writeFileSync(candidate, bytes, { mode: 0o600 });
  once = compose(["--profile", "tools", "run", "--no-deps", "-d", "collector-once", "node", "-e", "setInterval(()=>{},1000)"], true).toString().trim();
  assert(/^[a-f0-9]{64}$/.test(once));
  compose(["run", "--rm", "--no-deps", "-T", "collector", "node", "-e", "require('node:fs').writeFileSync('/data/private/travelcanary.db','controlled disposable corruption',{mode:0o600})"]);
  const restored = spawnSync(process.execPath, [join(root, "bin/travelcanary"), "restore", candidate, "--recover-corrupt"], { cwd: root, stdio: "inherit", timeout: 180_000 });
  assert.equal(restored.status, 0);
  assert.equal(run(["inspect", "--format", "{{.State.Running}}", once], true).toString().trim(), "false");
  compose(["stop", "web", "collector"]);
  compose(["run", "--rm", "--no-deps", "-T", "collector", "node", "--import", "tsx", "--input-type=module", "-e", "import {validateLocalBackup} from './src/lib/local-storage.ts'; import {readdirSync,existsSync} from 'node:fs'; validateLocalBackup('/data/private/travelcanary.db'); if(existsSync('/data/private/travelcanary.db.recovery')||!readdirSync('/data/private').some(n=>n.startsWith('travelcanary.db.pre-recovery-')))throw Error('recovery evidence missing');"]);
  console.log("Disposable Docker corruption recovery and one-shot writer shutdown passed.");
} finally {
  if (once) spawnSync("docker", ["rm", "--force", once], { stdio: "ignore" });
  spawnSync("docker", ["compose", "--env-file", join(root, ".travelcanary/docker.env"), "--profile", "tools", "down", "--volumes", "--remove-orphans"], { cwd: root, stdio: "inherit" });
  rmSync(root, { recursive: true, force: true });
}
