import { backup, DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPendingRecovery, initializeLocalRuntime, localDatabasePath, LocalDatabase, readLocalPolicy, validateLocalBackup, writeLocalPolicy } from "../src/lib/local-storage";
import { disabledLocalPolicy, restrictedSourceManifestDigest } from "../src/lib/local-policy";
import { recoverCorruptDatabase } from "../src/lib/corrupt-recovery";
import { FilePublicationStore } from "../src/lib/publication-store";
import { checkPublicationHealth } from "../src/lib/public-health";
import { runtimePaths } from "../src/lib/runtime-paths";
// @ts-expect-error Shared JavaScript CLI helper has no declaration file.
import { fetchHealth } from "./fetch-health.mjs";
// @ts-expect-error Shared JavaScript CLI helper has no declaration file.
import { parseRestoreArgs, stopRecoveryWriters } from "./restore-options.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlDirectory = join(repository, ".travelcanary");
const installFile = join(controlDirectory, "install.json");
type Install = { runtime: "docker" | "native"; port: number; dataDirectory?: string; environmentFile?: string };

function fail(message: string): never { console.error(message); process.exit(1); }
function portValue(value: string | undefined) {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Port must be an integer from 1 to 65535");
  return port;
}
function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer; capture?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd: repository, env: options.env || process.env, input: options.input,
    stdio: [options.input !== undefined ? "pipe" : options.capture ? "ignore" : "inherit", options.capture ? "pipe" : "inherit", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command} exited with status ${result.status}`);
  return result.stdout as Buffer | null;
}
function readInstall(): Install | null {
  try { return JSON.parse(readFileSync(installFile, "utf8")) as Install; } catch { return null; }
}
function writeInstall(value: Install) {
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(installFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function composeArgs(install: Install, args: string[]) {
  const environmentFile = install.environmentFile || join(controlDirectory, "docker.env");
  return ["compose", "--env-file", environmentFile, ...args];
}
async function setup(args: string[]) {
  const runtimeIndex = args.indexOf("--runtime");
  const runtime = args[runtimeIndex + 1];
  const portIndex = args.indexOf("--port");
  const port = portValue(portIndex >= 0 ? args[portIndex + 1] : undefined);
  if (runtime === "native") fail("Native Linux requires the dedicated-user system services documented in docs/SELF_HOSTING.md; automated setup supports Docker only");
  if (runtime !== "docker") fail("Usage: travelcanary setup --runtime docker [--port 3000]");
  const environmentFile = join(controlDirectory, "docker.env");
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(environmentFile, `TRAVELCANARY_PORT=${port}\n`, { mode: 0o600 });
  run("docker", ["compose", "version"]);
  run("docker", ["compose", "--env-file", environmentFile, "up", "--build", "-d"]);
  writeInstall({ runtime, port, environmentFile });
  console.log(`TravelCanary is starting at http://127.0.0.1:${port}`);
}

async function status() {
  const install = readInstall();
  if (install) {
    try {
      const response = await fetchHealth(install.port);
      console.log(JSON.stringify(await response.json(), null, 2));
      if (!response.ok) process.exitCode = 1;
      return;
    } catch { fail(`TravelCanary is unavailable at http://127.0.0.1:${install.port}`); }
  }
  const paths = runtimePaths(process.env, false);
  console.log(JSON.stringify(await checkPublicationHealth(new FilePublicationStore(paths.publicRoot), { runtime: "filesystem" }), null, 2));
}

function directPolicy(action: string) {
  const database = new LocalDatabase();
  try {
    initializeLocalRuntime(database);
    const current = readLocalPolicy(database);
    const policy = action === "accept-restricted" ? {
      schemaVersion: 1 as const, restrictedSources: "accepted" as const,
      acceptedManifestDigest: restrictedSourceManifestDigest, acceptedAt: new Date().toISOString(),
    } : disabledLocalPolicy();
    writeLocalPolicy(database, policy, current.revision);
    console.log(action === "accept-restricted"
      ? `Restricted sources accepted for manifest ${restrictedSourceManifestDigest}.`
      : "Restricted sources disabled.");
  } finally { database.close(); }
}

function policy(action: string) {
  if (!new Set(["accept-restricted", "disable-restricted"]).has(action)) fail("Usage: travelcanary policy accept-restricted|disable-restricted");
  const install = readInstall();
  if (install?.runtime === "docker" && !process.env.TRAVELCANARY_DATA_DIR) {
    run("docker", composeArgs(install, ["exec", "-T", "collector", "bin/travelcanary", "policy", action])); return;
  }
  if (install?.dataDirectory) process.env.TRAVELCANARY_DATA_DIR = install.dataDirectory;
  directPolicy(action);
}

async function directBackup(output: string) {
  const sourcePath = localDatabasePath();
  assertNoPendingRecovery(sourcePath);
  if (!existsSync(sourcePath)) fail("TravelCanary database does not exist");
  const stream = output === "-";
  const temporaryDirectory = stream ? mkdtempSync(join(dirname(sourcePath), ".backup-")) : null;
  const destination = temporaryDirectory ? join(temporaryDirectory, "travelcanary.db") : resolve(output);
  if (!stream && existsSync(destination)) fail(`Refusing to overwrite ${destination}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, destination); chmodSync(destination, 0o600); }
  finally { source.close(); }
  if (stream) {
    try { process.stdout.write(readFileSync(destination)); }
    finally { rmSync(temporaryDirectory!, { recursive: true }); }
  } else console.log(`Private backup created: ${destination}`);
}

async function backupCommand(output?: string) {
  const install = readInstall();
  const destination = resolve(output || `travelcanary-backup-${new Date().toISOString().replaceAll(":", "-")}.db`);
  if (install?.runtime === "docker" && !process.env.TRAVELCANARY_DATA_DIR) {
    if (existsSync(destination)) fail(`Refusing to overwrite ${destination}`);
    const bytes = run("docker", composeArgs(install, ["exec", "-T", "collector", "bin/travelcanary", "backup", "-"]), { capture: true });
    writeFileSync(destination, bytes!, { mode: 0o600 }); console.log(`Private backup created: ${destination}`); return;
  }
  if (install?.dataDirectory) process.env.TRAVELCANARY_DATA_DIR = install.dataDirectory;
  await directBackup(output === "-" ? "-" : destination);
}

async function directRestore(input: string, recover = false) {
  const target = localDatabasePath(); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(dirname(target), ".restore-"));
  const temp = join(temporaryDirectory, "travelcanary.db");
  try {
    if (input === "-") writeFileSync(temp, readFileSync(0), { mode: 0o600 });
    else copyFileSync(resolve(input), temp);
    chmodSync(temp, 0o600); validateLocalBackup(temp);
    if (recover) { await recoverCorruptDatabase(target, temp); }
    else {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const database = new LocalDatabase(target);
    try { await database.restoreBackup(temp, `${target}.pre-restore-${stamp}`); }
    finally { database.close(); }
    }
  } finally { rmSync(temporaryDirectory, { recursive: true, force: true }); }
  console.log(input === "-" ? "TravelCanary database restored." : `TravelCanary restored from private backup ${basename(input)}.`);
}

async function restoreCommand(args: string[]) {
  const { input, recover, stopped } = parseRestoreArgs(args);
  const install = readInstall();
  if (install?.runtime === "docker" && !process.env.TRAVELCANARY_DATA_DIR) {
    const bytes = readFileSync(resolve(input));
    if (recover) {
      stopRecoveryWriters((rest: string[], options: { capture?: boolean }) => run("docker", composeArgs(install, rest), options), (rest: string[], options: { capture?: boolean }) => run("docker", rest, options));
      run("docker", composeArgs(install, ["run", "--rm", "--no-deps", "-T", "collector", "bin/travelcanary", "restore", "-", "--recover-corrupt", "--collector-stopped"]), { input: bytes });
      run("docker", composeArgs(install, ["up", "-d", "web", "collector"])); return;
    }
    run("docker", composeArgs(install, ["stop", "web", "collector"]));
    try { run("docker", composeArgs(install, ["run", "--rm", "--no-deps", "-T", "collector", "bin/travelcanary", "restore", "-"]), { input: bytes }); }
    finally { run("docker", composeArgs(install, ["up", "-d"])); }
    return;
  }
  if (install?.runtime === "native") fail("Migrate this legacy same-user native installation to the dedicated-user system services before restoring");
  if (recover && !stopped) fail("--recover-corrupt requires --collector-stopped after stopping every private database writer");
  if (install?.dataDirectory) process.env.TRAVELCANARY_DATA_DIR = install.dataDirectory;
  await directRestore(input, recover);
}

const [command, ...args] = process.argv.slice(2);
if (command === "setup") await setup(args);
else if (command === "status") await status();
else if (command === "policy") policy(args[0]);
else if (command === "backup") await backupCommand(args[0]);
else if (command === "restore") await restoreCommand(args);
else fail("Usage: travelcanary setup --runtime docker [--port 3000] | status | policy accept-restricted|disable-restricted | backup [output] | restore <backup>");
