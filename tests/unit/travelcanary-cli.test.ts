import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
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
afterEach(async () => {
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  // Let Vitest receive worker RPC replies between synchronous subprocess tests.
  await setImmediate();
});

function backup(path: string, state: unknown) {
  const database = new LocalDatabase(path);
  database.initialize([
    { namespace: "private", key: "ingestion/state.json", value: JSON.stringify(state), maxBytes: 5 * 1024 * 1024 },
    { namespace: "private", key: "runtime/policy.json", value: JSON.stringify(disabledLocalPolicy()), maxBytes: 4096 },
  ]);
  database.close();
}

function restore(source: string, dataDirectory: string, flags: string[] = [], entry = "scripts/travelcanary-cli.ts", input?: Buffer) {
  return spawnSync(process.execPath, [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry, "restore", source, ...flags], {
    cwd: process.cwd(), env: { ...process.env, TRAVELCANARY_DATA_DIR: dataDirectory }, encoding: "utf8", input,
  });
}

describe("private backup restore", () => {
  for (const entry of ["bin/travelcanary", "scripts/travelcanary-cli.ts"]) {
    it(`${entry} recovers a corrupt target only with the explicit offline flags and preserves public files`, () => {
      const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target");
      const target = join(data, "private/travelcanary.db");
      backup(source, createEmptyState(now)); mkdirSync(join(data, "private"), { recursive: true });
      writeFileSync(target, Buffer.from("corrupt target\u0000original-private-data"));
      mkdirSync(join(data, "public/catalogs/3/publication"), { recursive: true });
      const publication = join(data, "public/catalogs/3/publication/latest.json");
      writeFileSync(publication, '{"public":"do not touch"}');
      const before = readFileSync(target);
      const missingAssertion = restore(source, data, ["--recover-corrupt"], entry);
      expect(missingAssertion.status).not.toBe(0); expect(missingAssertion.stderr).toMatch(/collector-stopped/);
      expect(readFileSync(target)).toEqual(before);
      expect(existsSync(`${target}.recovery`)).toBe(false);
      const recovered = restore(source, data, ["--recover-corrupt", "--collector-stopped"], entry);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(publication, "utf8")).toBe('{"public":"do not touch"}');
      const archive = readdirSync(join(data, "private")).find((name) => name.startsWith("travelcanary.db.pre-recovery-"))!;
      expect(readFileSync(join(data, "private", archive, "originals/travelcanary.db"))).toEqual(before);
      const database = new LocalDatabase(target);
      try { expect(JSON.parse(database.read("private", "ingestion/state.json")!.value).updatedAt).toBe(now.toISOString()); }
      finally { database.close(); }
    }, 25_000);

    it(`${entry} accepts binary stdin recovery without text transcoding`, () => {
      const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target");
      const target = join(data, "private/travelcanary.db");
      backup(source, createEmptyState(now)); mkdirSync(join(data, "private"), { recursive: true }); writeFileSync(target, "corrupt SQLite file");
      const result = restore("-", data, ["--recover-corrupt", "--collector-stopped"], entry, readFileSync(source));
      expect(result.status, result.stderr).toBe(0);
      const database = new LocalDatabase(target);
      try { expect(JSON.parse(database.read("private", "ingestion/state.json")!.value).schemaVersion).toBe(16); }
      finally { database.close(); }
    }, 15_000);

    for (const flags of [["--unknown"], ["--recover-corrupt", "--recover-corrupt", "--collector-stopped"], ["--collector-stopped"], ["--recover-corrupt", "--collector-stopped", "--collector-stopped"], ["--recover-corrupt", "--collector-stopped", "extra-argument"]]) {
      it(`${entry} rejects incompatible restore arguments ${flags.join(" ")} before touching the target`, () => {
        const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target");
        const target = join(data, "private/travelcanary.db");
        backup(source, createEmptyState(now)); mkdirSync(join(data, "private"), { recursive: true }); writeFileSync(target, "corrupt but retain");
        const before = readFileSync(target);
        const result = restore(source, data, flags, entry);
        expect(result.status).not.toBe(0);
        expect(readFileSync(target)).toEqual(before);
        expect(readdirSync(join(data, "private"))).toEqual(["travelcanary.db"]);
      }, 15_000);
    }
  }

  for (const kind of ["non-SQLite", "V15", "invalid-policy", "invalid-key", "invalid-namespace", "oversized-object"]) {
    it(`rejects a ${kind} recovery backup before acquiring the target guard`, () => {
      const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target"); const target = join(data, "private/travelcanary.db");
      backup(source, kind === "V15" ? parseCatalogStateV15(createLegacyState(now)) : createEmptyState(now));
      if (kind === "non-SQLite") writeFileSync(source, "not a backup");
      else if (kind !== "V15") {
        const malformed = new DatabaseSync(source);
        try {
          if (kind === "invalid-policy") malformed.prepare("UPDATE objects SET value=? WHERE key='runtime/policy.json'").run(Buffer.from('{"schemaVersion":99}'));
          else {
            malformed.exec("PRAGMA ignore_check_constraints=ON");
            malformed.prepare("INSERT INTO objects(namespace,key,value,revision,updated_at) VALUES(?,?,?,1,?)").run(
              kind === "invalid-namespace" ? "public" : "private", kind === "invalid-key" ? "../outside" : "runtime/extra.json",
              Buffer.from(kind === "oversized-object" ? "x".repeat(5 * 1024 * 1024 + 1) : "{}"), now.toISOString());
          }
        } finally { malformed.close(); }
      }
      mkdirSync(join(data, "private"), { recursive: true }); writeFileSync(target, "corrupt-original");
      const before = readFileSync(target);
      const result = restore(source, data, ["--recover-corrupt", "--collector-stopped"]);
      expect(result.status).not.toBe(0);
      expect(readFileSync(target)).toEqual(before);
      expect(readdirSync(join(data, "private"))).toEqual(["travelcanary.db"]);
    }, 15_000);
  }

  for (const args of [["restore", "-"], ["restore", "-", "--recover-corrupt", "--collector-stopped"], ["backup", "-"], ["policy", "disable-restricted"]]) {
    it(`refuses ${args.join(" ")} while recovery is pending`, () => {
      const root = temporaryRoot(); const source = join(root, "backup.db"); const data = join(root, "target"); const target = join(data, "private/travelcanary.db");
      backup(source, createEmptyState(now)); mkdirSync(join(data, "private"), { recursive: true }); writeFileSync(target, "corrupt-original"); mkdirSync(`${target}.recovery`, { mode: 0o700 });
      const before = readFileSync(target);
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/travelcanary-cli.ts", ...args], {
        cwd: process.cwd(), env: { ...process.env, TRAVELCANARY_DATA_DIR: data }, input: args[0] === "restore" ? readFileSync(source) : undefined, encoding: "utf8",
      });
      expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/recovery|pending/i);
      expect(readFileSync(target)).toEqual(before); expect(existsSync(`${target}.recovery`)).toBe(true);
      if (args[0] === "backup") expect(result.stdout).toBe("");
    }, 15_000);
  }

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
    function dockerFixture(status = 0, flags: string[] = [], scenario = "success") {
      const root = temporaryRoot();
      for (const directory of ["bin", "scripts", ".travelcanary", "fakebin"]) mkdirSync(join(root, directory));
      for (const path of ["bin/travelcanary", "scripts/travelcanary-cli.ts", "scripts/fetch-health.mjs", "scripts/restore-options.mjs", "package.json", "tsconfig.json"]) copyFileSync(path, join(root, path));
      for (const path of ["src", "node_modules"]) symlinkSync(join(process.cwd(), path), join(root, path), "dir");
      writeFileSync(join(root, ".travelcanary/install.json"), JSON.stringify({ runtime: "docker", port: 3000, environmentFile: join(root, "docker.env") }));
      writeFileSync(join(root, "docker.env"), "TRAVELCANARY_PORT=3000\n");
      const docker = join(root, "fakebin/docker");
      writeFileSync(docker, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TC_DOCKER_LOG, JSON.stringify(args) + '\\n');
const scenario = process.env.TC_DOCKER_CASE;
if (args.includes('config')) {
  console.log(JSON.stringify(scenario === 'unknown-installation' ? {} : {name:'test-project',volumes:{'travelcanary-private':{name:'test-private'}}}));
} else if (args[0] === 'ps') {
  const count = readFileSync(process.env.TC_DOCKER_LOG, 'utf8').split('\\n').filter((line) => line.startsWith('["ps"')).length;
  console.log(['aaaaaaaaaaaa','bbbbbbbbbbbb','cccccccccccc','dddddddddddd',...(scenario === 'new-writer' && count > 1 ? ['eeeeeeeeeeee'] : [])].join('\\n'));
} else if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
  if (scenario === 'inspect-failure') process.exit(23);
  console.log(JSON.stringify([{RW:args.at(-1) !== 'aaaaaaaaaaaa',Name:'test-private'}]));
} else if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
  console.log((scenario === 'still-running' && args.at(-1) === 'cccccccccccc') || args.at(-1) === 'eeeeeeeeeeee' ? 'true' : 'false');
} else if (args.includes('stop') && scenario === 'stop-failure') {
  process.exit(21);
} else if (args.includes('run')) {
  writeFileSync(process.env.TC_DOCKER_INPUT, readFileSync(0), {mode:0o600}); process.exit(${status});
}
`);
      chmodSync(docker, 0o755);
      const source = join(root, "backup.db"); backup(source, createEmptyState(now));
      const environment: NodeJS.ProcessEnv & { TC_DOCKER_LOG: string; TC_DOCKER_INPUT: string } = { ...process.env, PATH: `${join(root, "fakebin")}:${process.env.PATH}`, TC_DOCKER_LOG: join(root, "calls.jsonl"), TC_DOCKER_INPUT: join(root, "received.db"), TC_DOCKER_CASE: scenario };
      delete environment.TRAVELCANARY_DATA_DIR;
      const result = spawnSync(process.execPath, [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry, "restore", source, ...flags], { cwd: root, env: environment, encoding: "utf8", timeout: 10_000 });
      const calls = existsSync(environment.TC_DOCKER_LOG) ? readFileSync(environment.TC_DOCKER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
      return { result, calls, received: existsSync(environment.TC_DOCKER_INPUT) ? readFileSync(environment.TC_DOCKER_INPUT) : undefined, expected: readFileSync(source) };
    }

    it(`${entry} forwards binary Docker restore input and restarts services`, () => {
      const { result, calls, received, expected } = dockerFixture();
      expect(result.status, result.stderr).toBe(0);
      expect(received!.byteLength).toBe(expected.byteLength);
      expect(createHash("sha256").update(received!).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
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

    it(`${entry} stops all regular, one-shot and one-off Docker writers before forwarding recovery stdin`, () => {
      const { result, calls, received, expected } = dockerFixture(0, ["--recover-corrupt"]);
      expect(result.status, result.stderr).toBe(0);
      expect(received).toEqual(expected);
      const regularStop = calls.findIndex((args) => args.includes("stop") && args.includes("collector-once"));
      const oneOffStop = calls.findIndex((args) => args[0] === "stop" && args.includes("dddddddddddd"));
      const run = calls.findIndex((args) => args.includes("run"));
      expect(regularStop).toBeGreaterThanOrEqual(0);
      expect(oneOffStop).toBeGreaterThan(regularStop);
      expect(calls[oneOffStop]).toEqual(expect.arrayContaining(["stop", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]));
      expect(run).toBeGreaterThan(oneOffStop);
      expect(calls[run].slice(-4)).toEqual(["restore", "-", "--recover-corrupt", "--collector-stopped"]);
      const inactivity = calls.slice(oneOffStop + 1, run).filter((args) => args[0] === "inspect" && args.includes("{{.State.Running}}"));
      for (const writer of ["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]) expect(inactivity.some((args) => args.includes(writer))).toBe(true);
      expect(calls.at(-1)?.slice(-4)).toEqual(["up", "-d", "web", "collector"]);
    }, 15_000);

    it(`${entry} keeps Docker services stopped after recovery failure`, () => {
      const { result, calls } = dockerFixture(17, ["--recover-corrupt"]);
      expect(result.status).not.toBe(0);
      expect(calls.some((args) => args.includes("run"))).toBe(true);
      expect(calls.some((args) => args.includes("up"))).toBe(false);
    }, 15_000);

    for (const scenario of ["stop-failure", "inspect-failure", "still-running", "new-writer", "unknown-installation"]) {
      it(`${entry} fails closed on Docker ${scenario} without starting restore or restarting services`, () => {
        const { result, calls, received } = dockerFixture(0, ["--recover-corrupt", "--collector-stopped"], scenario);
        expect(result.status).not.toBe(0);
        expect(calls.some((args) => args.includes("run"))).toBe(false);
        expect(calls.some((args) => args.includes("up"))).toBe(false);
        expect(received).toBeUndefined();
      }, 15_000);
    }

    for (const flags of [["--recover-corrupt", "--unknown"], ["--recover-corrupt", "--recover-corrupt"], ["--collector-stopped"]]) {
      it(`${entry} rejects invalid Docker recovery flags before querying or stopping services: ${flags.join(" ")}`, () => {
        const { result, calls } = dockerFixture(0, flags);
        expect(result.status).not.toBe(0); expect(calls).toEqual([]);
      }, 15_000);
    }
  }
});
