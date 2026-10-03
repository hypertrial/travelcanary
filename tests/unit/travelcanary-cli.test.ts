import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseCatalogStateV15 } from "@/lib/domain/catalog-state";
import { disabledLocalPolicy } from "@/lib/local-policy";
import { LocalDatabase } from "@/lib/local-storage";
import { createEmptyState } from "@/lib/risk-state";
import { createLegacyState } from "../fixtures/legacy-state";

const now = new Date("2026-09-18T00:00:00.000Z");
const temporaryRoots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "travelcanary-restore-"));
  temporaryRoots.push(root); return root;
}
afterEach(() => temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function backup(path: string, state: unknown) {
  const database = new LocalDatabase(path);
  database.initialize([
    { namespace: "private", key: "ingestion/state.json", value: JSON.stringify(state), maxBytes: 5 * 1024 * 1024 },
    { namespace: "private", key: "runtime/policy.json", value: JSON.stringify(disabledLocalPolicy()), maxBytes: 4096 },
  ]);
  database.close();
}

function restore(source: string, dataDirectory: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/travelcanary-cli.ts", "restore", source], {
    cwd: process.cwd(), env: { ...process.env, TRAVELCANARY_DATA_DIR: dataDirectory }, encoding: "utf8",
  });
}

describe("private backup restore", () => {
  it("accepts V16 and rejects an obsolete V15 database", () => {
    const root = temporaryRoot();
    const v16 = join(root, "v16.db"); const v15 = join(root, "v15.db");
    backup(v16, createEmptyState(now)); backup(v15, parseCatalogStateV15(createLegacyState(now)));

    const accepted = restore(v16, join(root, "accepted"));
    expect(accepted.status, accepted.stderr).toBe(0);
    const installed = new DatabaseSync(join(root, "accepted/private/travelcanary.db"), { readOnly: true });
    const row = installed.prepare("SELECT value FROM objects WHERE namespace=? AND key=?").get("private", "ingestion/state.json") as { value: Uint8Array | string };
    const raw = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    expect(JSON.parse(raw).schemaVersion).toBe(16); installed.close();

    const rejected = restore(v15, join(root, "rejected"));
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toMatch(/schemaVersion/);
    expect(() => readFileSync(join(root, "rejected/private/travelcanary.db"))).toThrow();
  }, 45_000);

  it("refuses an active collector without replacing its database", () => {
    const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target");
    const target = join(data, "private/travelcanary.db");
    backup(source, createEmptyState(now));
    backup(target, createEmptyState(new Date("2026-09-17T00:00:00Z")));
    const collector = new LocalDatabase(target);
    try {
      collector.acquireCollector("live-collector");
      const before = collector.read("private", "ingestion/state.json")!;
      const result = restore(source, data);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/collector/i);
      expect(collector.read("private", "ingestion/state.json")).toEqual(before);
      const reopened = new LocalDatabase(target);
      try { expect(reopened.read("private", "ingestion/state.json")).toEqual(before); }
      finally { reopened.close(); }
    } finally { collector.close(); }
  }, 15_000);

  it("restores offline without importing the backup collector lease or reusing target revisions", () => {
    const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target");
    const target = join(data, "private/travelcanary.db");
    backup(source, createEmptyState(now)); backup(target, createEmptyState(new Date("2026-09-17T00:00:00Z")));
    const original = new LocalDatabase(target); const saved = new LocalDatabase(source);
    const before = original.read("private", "ingestion/state.json")!;
    original.compareAndSwap("private", "ingestion/state.json", before.value, before.revision, 5 * 1024 * 1024);
    original.close(); saved.acquireCollector("backup-collector"); saved.close();
    const inode = statSync(target).ino;
    const observer = new DatabaseSync(target, { readOnly: true });
    try {
      const result = restore(source, data);
      expect(result.status, result.stderr).toBe(0);
      expect(statSync(target).ino).toBe(inode);
      const row = observer.prepare("SELECT value FROM objects WHERE key='ingestion/state.json'").get() as { value: Uint8Array };
      expect(JSON.parse(Buffer.from(row.value).toString()).updatedAt).toBe(now.toISOString());
    } finally { observer.close(); }
    const preserved = readdirSync(join(data, "private")).find((name) => name.startsWith("travelcanary.db.pre-restore-"))!;
    expect(statSync(join(data, "private", preserved)).mode & 0o777).toBe(0o600);
    const previous = new LocalDatabase(join(data, "private", preserved));
    try { expect(previous.read("private", "ingestion/state.json")?.value).toBe(before.value); }
    finally { previous.close(); }
    const restored = new LocalDatabase(target);
    try {
      const state = restored.read("private", "ingestion/state.json")!;
      expect(JSON.parse(state.value).updatedAt).toBe(now.toISOString());
      expect(state.revision).toBeGreaterThan(before.revision + 1);
      expect(() => restored.acquireCollector("new-collector")).not.toThrow();
    } finally { restored.close(); }
  }, 15_000);

  it("rolls back replacement failure and preserves the pre-restore database", () => {
    const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target");
    const target = join(data, "private/travelcanary.db");
    backup(source, createEmptyState(now)); backup(target, createEmptyState(new Date("2026-09-17T00:00:00Z")));
    const database = new DatabaseSync(target);
    const before = database.prepare("SELECT key, value, revision FROM objects ORDER BY key").all();
    database.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT, 'replacement failure'); END;");
    database.close();
    const result = restore(source, data);
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/replacement failure/);
    const reopened = new DatabaseSync(target);
    try { expect(reopened.prepare("SELECT key, value, revision FROM objects ORDER BY key").all()).toEqual(before); }
    finally { reopened.close(); }
    expect(readdirSync(join(data, "private")).some((name) => name.startsWith("travelcanary.db.pre-restore-"))).toBe(true);
  }, 15_000);

  for (const entry of ["bin/travelcanary", "scripts/travelcanary-cli.ts"]) {
    function dockerFixture(status = 0) {
      const root = temporaryRoot();
      for (const directory of ["bin", "scripts", ".travelcanary", "fakebin"]) mkdirSync(join(root, directory));
      for (const path of ["bin/travelcanary", "scripts/travelcanary-cli.ts", "scripts/fetch-health.mjs", "package.json", "tsconfig.json"]) copyFileSync(path, join(root, path));
      for (const path of ["src", "node_modules"]) symlinkSync(join(process.cwd(), path), join(root, path), "dir");
      writeFileSync(join(root, ".travelcanary/install.json"), JSON.stringify({ runtime: "docker", port: 3000, environmentFile: join(root, "docker.env") }));
      writeFileSync(join(root, "docker.env"), "TRAVELCANARY_PORT=3000\n");
      const docker = join(root, "fakebin/docker");
      writeFileSync(docker, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nappendFileSync(process.env.TC_DOCKER_LOG, JSON.stringify(args)+'\\n');\nif(args.includes('run')) { writeFileSync(process.env.TC_DOCKER_INPUT, readFileSync(0), {mode:0o600}); process.exit(${status}); }\n`);
      chmodSync(docker, 0o755);
      const source = join(root, "backup.db"); backup(source, createEmptyState(now));
      const environment: NodeJS.ProcessEnv & { TC_DOCKER_LOG: string; TC_DOCKER_INPUT: string } = { ...process.env, PATH: `${join(root, "fakebin")}:${process.env.PATH}`, TC_DOCKER_LOG: join(root, "calls.jsonl"), TC_DOCKER_INPUT: join(root, "received.db") };
      delete environment.TRAVELCANARY_DATA_DIR;
      const result = spawnSync(process.execPath, [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry, "restore", source], { cwd: root, env: environment, encoding: "utf8", timeout: 10_000 });
      const calls = readFileSync(environment.TC_DOCKER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      return { result, calls, received: readFileSync(environment.TC_DOCKER_INPUT), expected: readFileSync(source) };
    }

    it(`${entry} forwards binary Docker restore input and restarts services`, () => {
      const { result, calls, received, expected } = dockerFixture();
      expect(result.status, result.stderr).toBe(0);
      expect(received.byteLength).toBe(expected.byteLength);
      expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
      expect(calls.some((args) => args.includes("stop"))).toBe(true);
      expect(calls.at(-1)).toContain("up");
    }, 15_000);

    it(`${entry} restarts services after inner restore failure and exits nonzero`, () => {
      const { result, calls } = dockerFixture(17);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/docker exited with status 17/);
      expect(calls.some((args) => args.includes("stop"))).toBe(true);
      expect(calls.at(-1)).toContain("up");
    }, 15_000);
  }
});
