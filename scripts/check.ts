#!/usr/bin/env node
import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HEAVY_VITEST_FILES = [
  "tests/unit/effis.test.ts",
  "tests/unit/firms.test.ts",
  "tests/unit/context-feeds.test.ts",
  "tests/unit/catalog3-geography.test.ts",
  "tests/unit/catalog3-demo.test.ts",
  "tests/unit/catalog3-conditions-projection.test.ts",
  "tests/unit/catalog3-conditions-serialization.test.ts",
  "tests/unit/catalog3-production-verification.test.ts",
  "tests/unit/catalog-publication.test.ts",
  "tests/unit/legacy-demo-generator.test.ts",
  "tests/unit/avalanche-mapping.test.ts",
  "tests/unit/europe-expansion-capacity.test.ts",
  "tests/unit/europe-populated-capacity.test.ts",
  "tests/unit/warning-expansion.test.ts",
];

export const CATALOG_DIST_DIRS: Record<number, string> = { 2: ".next-c2", 3: ".next-c3" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set<ChildProcess>();

export function gitRevParse(cwd = process.cwd()) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

export function gitDirty(cwd = process.cwd()) {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
  return status.length > 0;
}

export function assertCleanTree(env: NodeJS.Dict<string> = process.env, cwd = process.cwd()) {
  if (env.VERIFY_ALLOW_DIRTY === "1") return;
  if (gitDirty(cwd)) {
    throw new Error("scripts/verify requires a clean git tree. Set VERIFY_ALLOW_DIRTY=1 only for debugging.");
  }
}

export function distDirForCatalog(version: number) {
  const dir = CATALOG_DIST_DIRS[version];
  if (!dir) throw new Error(`Unsupported catalog version ${version}`);
  return dir;
}

export function catalogHtmlMatches(html: string, version: number) {
  return html.includes(`name="travelcanary-catalog-version" content="${version}"`)
    || html.includes(`name="travelcanary-catalog-version" content='${version}'`);
}

export function looksLikeNextDev(html: string) {
  return html.includes("Open Next.js Dev Tools");
}

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

export function elapsed(started: number) {
  return Math.round(performance.now() - started);
}

function killChild(child: ChildProcess) {
  if (!child.pid || child.killed || child.exitCode !== null) return;
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* already exited */
  }
}

export function killAll() {
  for (const child of children) killChild(child);
  children.clear();
}

type RunOptions = {
  cwd?: string;
  env?: NodeJS.Dict<string>;
  stdio?: StdioOptions;
  name?: string;
};

export function run(command: string, args: string[] = [], options: RunOptions = {}) {
  const started = performance.now();
  const name = options.name || [command, ...args].join(" ");
  log(`→ ${name}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...options.env },
      stdio: options.stdio || "inherit",
    });
    children.add(child);
    child.on("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      children.delete(child);
      const ms = elapsed(started);
      if (code === 0) {
        log(`✓ ${name} (${ms}ms)`);
        resolve({ name, ms, code: 0 });
        return;
      }
      reject(new Error(`${name} failed (${signal || `exit ${code}`}) after ${ms}ms`));
    });
  });
}

function npmRun(script: string, extraArgs: string[] = [], options: RunOptions = {}) {
  return run(npmBin, ["run", script, ...extraArgs], { ...options, name: options.name || `npm run ${script}` });
}

export async function runParallel(tasks: Array<() => Promise<unknown>>) {
  const results: unknown[] = [];
  const wrapped = tasks.map((task) => task().then((result) => {
    results.push(result);
    return result;
  }));
  try {
    await Promise.all(wrapped);
    return results;
  } catch (error) {
    killAll();
    throw error;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a local port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForUrl(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server for ${url} exited before becoming ready`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become ready at ${url}`);
}

async function startProductionServer({ distDir, port, catalogVersion }: { distDir: string; port: number; catalogVersion: number }) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_DIST_DIR: distDir,
      NEXT_PUBLIC_DATA_MODE: "demo",
      NEXT_PUBLIC_CATALOG_VERSION: String(catalogVersion),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const html = await waitForUrl(origin, child);
    if (!catalogHtmlMatches(html, catalogVersion)) {
      throw new Error(`Production server at ${origin} is not catalog ${catalogVersion}`);
    }
    if (looksLikeNextDev(html)) {
      throw new Error(`Refusing to attach browser checks to a development server at ${origin}`);
    }
    return { child, origin };
  } catch (error) {
    killChild(child);
    children.delete(child);
    throw new Error(`${error instanceof Error ? error.message : error}\n${output}`);
  }
}

async function typegen() {
  return run(process.execPath, ["node_modules/next/dist/bin/next", "typegen"], { name: "next typegen" });
}

async function tsc() {
  mkdirSync(path.join(root, ".cache/tsc"), { recursive: true });
  return run(path.join(root, "node_modules/.bin/tsc"), ["--noEmit"], { name: "tsc --noEmit" });
}

async function vitestLight() {
  return npmRun("test", ["--", "--maxWorkers", process.env.VITEST_LIGHT_WORKERS || "4"], {
    name: "vitest light",
    env: { VITEST_POOL: "light", VITEST_LIGHT_WORKERS: process.env.VITEST_LIGHT_WORKERS || "4" },
  });
}

async function vitestHeavy() {
  return npmRun("test", ["--", "--maxWorkers", process.env.VITEST_HEAVY_WORKERS || "1"], {
    name: "vitest heavy",
    env: { VITEST_POOL: "heavy", VITEST_HEAVY_WORKERS: process.env.VITEST_HEAVY_WORKERS || "1" },
  });
}

async function fastLane() {
  await typegen();
  await runParallel([
    () => npmRun("lint"),
    () => tsc(),
    () => npmRun("data:validate"),
    () => npmRun("catalog:check"),
    () => npmRun("coverage:check"),
    () => npmRun("sources:check"),
    () => npmRun("conditions:check"),
    () => vitestLight(),
  ]);
  await vitestHeavy();
}

async function catalogPipeline(version: number) {
  const distDir = distDirForCatalog(version);
  const buildEnv = {
    NEXT_PUBLIC_CATALOG_VERSION: String(version),
    NEXT_PUBLIC_DATA_MODE: "demo",
    VERCEL_ENV: "preview",
    NEXT_DIST_DIR: distDir,
  };
  await npmRun("build", [], { name: `next build catalog ${version}`, env: buildEnv });
  const port = await availablePort();
  const server = await startProductionServer({ distDir, port, catalogVersion: version });
  try {
    await npmRun("perf:assets", [], {
      name: `perf:assets catalog ${version}`,
      env: {
        PLAYWRIGHT_BASE_URL: server.origin,
        NEXT_DIST_DIR: distDir,
        EXPECTED_CATALOG_VERSION: String(version),
      },
    });
    const playwrightArgs = ["exec", "playwright", "test"];
    await run(npmBin, playwrightArgs, {
      name: `playwright catalog ${version}`,
      env: {
        PLAYWRIGHT_REUSE_SERVER: "1",
        PLAYWRIGHT_PORT: String(port),
        PLAYWRIGHT_USE_BUILD: "true",
        PLAYWRIGHT_CATALOG_VERSION: String(version),
        PLAYWRIGHT_DIST_DIR: distDir,
        PLAYWRIGHT_STRICT: "1",
      },
    });
  } finally {
    killChild(server.child);
    children.delete(server.child);
  }
}

function installedPlaywrightVersion(cwd: string) {
  return JSON.parse(readFileSync(path.join(cwd, "node_modules/@playwright/test/package.json"), "utf8")).version as string;
}

export function serializeEvidence(mode: string, started: number, cwd = process.cwd()) {
  return {
    commit: gitRevParse(cwd),
    dirty: gitDirty(cwd),
    host: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    npm: execFileSync(npmBin, ["-v"], { encoding: "utf8" }).trim(),
    playwright: installedPlaywrightVersion(cwd),
    mode,
    durationMs: elapsed(started),
  };
}

function printEvidence(mode: string, started: number) {
  const evidence = serializeEvidence(mode, started);
  log(`verify-evidence ${JSON.stringify(evidence)}`);
  return evidence;
}

export async function runCheck(mode: "fast" | "full", env: NodeJS.Dict<string> = process.env) {
  process.chdir(root);
  const started = performance.now();
  log(`verify ${mode} commit=${gitRevParse()} dirty=${gitDirty()} arch=${os.arch()} node=${process.version}`);
  if (mode === "full") assertCleanTree(env);
  try {
    await fastLane();
    if (mode === "full") {
      const audit = npmRun("check:audit", [], { name: "npm audit" });
      const catalog2 = catalogPipeline(2);
      await Promise.all([audit, catalog2]);
      await npmRun("perf:bench");
      await catalogPipeline(3);
    }
    return printEvidence(mode, started);
  } finally {
    killAll();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const mode = process.argv.includes("--full") ? "full" : "fast";
  process.on("SIGINT", () => { killAll(); process.exit(130); });
  process.on("SIGTERM", () => { killAll(); process.exit(143); });
  runCheck(mode).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`);
    process.exit(1);
  });
}
