import { backup, DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeLocalRuntime, localDatabasePath, LocalDatabase, publicObjectLimit, readLocalPolicy, writeLocalPolicy } from "../src/lib/local-storage";
import { disabledLocalPolicy, LocalRuntimePolicySchema, restrictedSourceManifestDigest } from "../src/lib/local-policy";
import { localHealth } from "../src/lib/local-status";
import { writeNativeFiles } from "../src/lib/native-setup";
import { parseCatalogState } from "../src/lib/domain/catalog-state";
import { ConditionsV3Schema, SnapshotV11Schema } from "../src/lib/domain/catalog-public";
import { catalogV3Paths } from "../src/lib/catalog-paths";
import { catalogV3CountryCodes } from "../src/lib/domain/contract-identities";
import { PRIVATE_STATE_HARD_LIMIT_BYTES } from "../src/lib/ingestion/limits";

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
    stdio: options.capture ? [options.input ? "pipe" : "ignore", "pipe", "inherit"] : "inherit", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(result.error?.message || `${command} exited with status ${result.status}`);
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
function exactNativeVersions() {
  if (process.versions.node !== "24.19.0") fail(`Node 24.19.0 is required; found ${process.version}`);
  const npm = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  if (npm !== "11.6.2") fail(`npm 11.6.2 is required; found ${npm}`);
}

async function setup(args: string[]) {
  const runtimeIndex = args.indexOf("--runtime");
  const runtime = args[runtimeIndex + 1];
  const portIndex = args.indexOf("--port");
  const port = portValue(portIndex >= 0 ? args[portIndex + 1] : undefined);
  if (runtime !== "docker" && runtime !== "native") fail("Usage: travelcanary setup --runtime docker|native [--port 3000]");
  if (runtime === "docker") {
    const environmentFile = join(controlDirectory, "docker.env");
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(environmentFile, `TRAVELCANARY_PORT=${port}\n`, { mode: 0o600 });
    run("docker", ["compose", "version"]);
    run("docker", ["compose", "--env-file", environmentFile, "up", "--build", "-d"]);
    writeInstall({ runtime, port, environmentFile });
    console.log(`TravelCanary is starting at http://127.0.0.1:${port}`);
    return;
  }
  if (process.platform !== "linux") fail("Native setup requires Linux with user-level systemd; use Docker on this host");
  exactNativeVersions();
  if (process.env.TRAVELCANARY_DEPENDENCIES_READY !== "true") run("npm", ["ci"]);
  const paths = writeNativeFiles({ home: homedir(), repository, node: process.execPath, port });
  const env = { ...process.env, TRAVELCANARY_RUNTIME: "local", TRAVELCANARY_DATA_DIR: paths.dataDirectory,
    NEXT_PUBLIC_CATALOG_VERSION: "3", NEXT_PUBLIC_DATA_MODE: "live", LOCAL_CONDITIONS_ENABLED: "true" };
  const database = new LocalDatabase(localDatabasePath(env)); initializeLocalRuntime(database, new Date(), env); database.close();
  run("npm", ["run", "build"], { env });
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "travelcanary-web.service", "travelcanary-collector.service"]);
  writeInstall({ runtime, port, dataDirectory: paths.dataDirectory });
  console.log(`TravelCanary is running at http://127.0.0.1:${port}`);
}

async function status() {
  const install = readInstall();
  if (install) {
    try {
      const response = await fetch(`http://127.0.0.1:${install.port}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
      console.log(JSON.stringify(await response.json(), null, 2));
      if (!response.ok) process.exitCode = 1;
      return;
    } catch { fail(`TravelCanary is unavailable at http://127.0.0.1:${install.port}`); }
  }
  const database = new LocalDatabase();
  try { initializeLocalRuntime(database); console.log(JSON.stringify(localHealth(database), null, 2)); } finally { database.close(); }
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

function validateBackup(path: string) {
  const candidate = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = candidate.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (integrity.length !== 1 || integrity[0].quick_check !== "ok") throw new Error("Backup failed SQLite integrity validation");
    const decode = (value: Uint8Array | string) => typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    const select = candidate.prepare("SELECT value FROM objects WHERE namespace=? AND key=?");
    const required = <T>(scope: "private" | "public", key: string, maxBytes: number, parse: (value: unknown) => T) => {
      const row = select.get(scope, key) as { value?: Uint8Array | string } | undefined;
      if (!row?.value) throw new Error(`Backup is missing required ${scope} object ${key}`);
      const raw = decode(row.value);
      if (Buffer.byteLength(raw) > maxBytes) throw new Error(`Backup object ${key} exceeds its size limit`);
      return parse(JSON.parse(raw));
    };
    const state = required("private", "ingestion/state.json", PRIVATE_STATE_HARD_LIMIT_BYTES, parseCatalogState);
    if (state.collection.catalogVersion !== 3) throw new Error("Backup catalog is not supported");
    required("private", "runtime/policy.json", 4096, LocalRuntimePolicySchema.parse);
    required("public", catalogV3Paths.snapshot, publicObjectLimit(catalogV3Paths.snapshot), SnapshotV11Schema.parse);
    required("public", catalogV3Paths.previousSnapshot, publicObjectLimit(catalogV3Paths.previousSnapshot), SnapshotV11Schema.parse);
    for (const countryCode of catalogV3CountryCodes) {
      const key = `${catalogV3Paths.conditions}${countryCode}.json`;
      const conditions = required("public", key, publicObjectLimit(key), ConditionsV3Schema.parse);
      if (conditions.countryCode !== countryCode) throw new Error(`Backup conditions object ${key} has the wrong country`);
    }
  } finally { candidate.close(); }
}

function directRestore(input: string) {
  const target = localDatabasePath(); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(dirname(target), ".restore-"));
  const temp = join(temporaryDirectory, "travelcanary.db");
  try {
    if (input === "-") writeFileSync(temp, readFileSync(0), { mode: 0o600 });
    else copyFileSync(resolve(input), temp);
    chmodSync(temp, 0o600); validateBackup(temp);
    const stamp = new Date().toISOString().replaceAll(":", "-");
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${target}${suffix}`)) renameSync(`${target}${suffix}`, `${target}.pre-restore-${stamp}${suffix}`);
    renameSync(temp, target); chmodSync(target, 0o600);
  } finally { rmSync(temporaryDirectory, { recursive: true, force: true }); }
  console.log(input === "-" ? "TravelCanary database restored." : `TravelCanary restored from private backup ${basename(input)}.`);
}

function restoreCommand(input?: string) {
  if (!input) fail("Usage: travelcanary restore <backup>");
  const install = readInstall();
  if (install?.runtime === "docker" && !process.env.TRAVELCANARY_DATA_DIR) {
    const bytes = readFileSync(resolve(input));
    run("docker", composeArgs(install, ["stop", "web", "collector"]));
    try { run("docker", composeArgs(install, ["run", "--rm", "--no-deps", "-T", "collector", "bin/travelcanary", "restore", "-"]), { input: bytes }); }
    finally { run("docker", composeArgs(install, ["up", "-d"])); }
    return;
  }
  if (install?.runtime === "native") run("systemctl", ["--user", "stop", "travelcanary-web.service", "travelcanary-collector.service"]);
  if (install?.dataDirectory) process.env.TRAVELCANARY_DATA_DIR = install.dataDirectory;
  try { directRestore(input); }
  finally { if (install?.runtime === "native") run("systemctl", ["--user", "start", "travelcanary-web.service", "travelcanary-collector.service"]); }
}

const [command, ...args] = process.argv.slice(2);
if (command === "setup") await setup(args);
else if (command === "status") await status();
else if (command === "policy") policy(args[0]);
else if (command === "backup") await backupCommand(args[0]);
else if (command === "restore") restoreCommand(args[0]);
else fail("Usage: travelcanary setup --runtime docker|native [--port 3000] | status | policy accept-restricted|disable-restricted | backup [output] | restore <backup>");
