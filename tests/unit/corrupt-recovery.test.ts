import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoPendingRecovery, recoverCorruptDatabase } from "@/lib/corrupt-recovery";
import { disabledLocalPolicy } from "@/lib/local-policy";
import { initializeLocalRuntime, LocalDatabase } from "@/lib/local-storage";
import { createEmptyState } from "@/lib/risk-state";

const roots: string[] = [];
const now = new Date("2026-09-18T00:00:00.000Z");
const suffixes = ["", "-wal", "-shm"];
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "travelcanary-corrupt-recovery-"));
  roots.push(root);
  const target = join(root, "travelcanary.db"); const candidate = join(root, "backup.db");
  const state = createEmptyState(now);
  state.ingestionFence = 7;
  state.ingestionLease = { owner: "embedded-backup-writer", fence: 7, expiresAt: "2026-09-18T00:01:00.000Z" };
  const backup = new LocalDatabase(candidate);
  backup.initialize([
    { namespace: "private", key: "ingestion/state.json", value: JSON.stringify(state), maxBytes: 5 * 1024 * 1024 },
    { namespace: "private", key: "runtime/policy.json", value: JSON.stringify(disabledLocalPolicy()), maxBytes: 4096 },
    { namespace: "private", key: "runtime/extra.json", value: '{"private":"retained"}', maxBytes: 4096 },
  ]);
  backup.acquireCollector("sqlite-backup-writer"); backup.close();
  writeFileSync(target, Buffer.from("not a SQLite database\u0000private-original-bytes"), { mode: 0o600 });
  return { root, target, candidate, state };
}
function originals(target: string) {
  return suffixes.map((suffix) => ({ suffix, bytes: existsSync(`${target}${suffix}`) ? readFileSync(`${target}${suffix}`) : null }));
}
function expectOriginals(target: string, files: ReturnType<typeof originals>) {
  for (const { suffix, bytes } of files) {
    expect(existsSync(`${target}${suffix}`), suffix || "database").toBe(bytes !== null);
    if (bytes !== null) expect(readFileSync(`${target}${suffix}`), suffix || "database").toEqual(bytes);
  }
}
function expectArchive(root: string, target: string, files: ReturnType<typeof originals>) {
  const archive = readdirSync(root).find((name) => name.startsWith("travelcanary.db.pre-recovery-"));
  expect(archive).toBeDefined();
  const path = join(root, archive!);
  expect(statSync(path).mode & 0o777).toBe(0o700);
  for (const { suffix, bytes } of files) {
    const preserved = join(path, "originals", `travelcanary.db${suffix}`);
    expect(existsSync(preserved), suffix || "database").toBe(bytes !== null);
    if (bytes !== null) {
      expect(readFileSync(preserved)).toEqual(bytes);
      expect(statSync(preserved).mode & 0o777).toBe(0o600);
    }
  }
  expect(existsSync(`${target}.recovery`)).toBe(false);
  return path;
}
function interruptRecovery(target: string, candidate: string, phase: string) {
  const script = `import { recoverCorruptDatabase } from ${JSON.stringify(resolve("src/lib/corrupt-recovery.ts"))};\nawait recoverCorruptDatabase(process.env.TC_TEST_TARGET, process.env.TC_TEST_CANDIDATE, (phase) => { if (phase === process.env.TC_TEST_PHASE) process.kill(process.pid, 'SIGKILL'); });`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, TC_TEST_TARGET: target, TC_TEST_CANDIDATE: candidate, TC_TEST_PHASE: phase }, encoding: "utf8", timeout: 15_000,
  });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}
function interruptAutomaticRollback(target: string, candidate: string) {
  const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const target = process.env.TC_TEST_TARGET;
const originalLink = fs.linkSync;
let installFailed = false;
fs.linkSync = (source, destination) => {
  if (destination === target && basename(source) === 'staged.db' && !installFailed) {
    installFailed = true;
    throw Object.assign(new Error('TC_INJECTED_INSTALL_FAILURE'), {code:'EIO'});
  }
  const result = originalLink(source, destination);
  if (installFailed && destination === target) {
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
syncBuiltinESMExports();
const { recoverCorruptDatabase } = await import(${JSON.stringify(resolve("src/lib/corrupt-recovery.ts"))});
await recoverCorruptDatabase(target, process.env.TC_TEST_CANDIDATE);
`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, TC_TEST_TARGET: target, TC_TEST_CANDIDATE: candidate }, encoding: "utf8", timeout: 15_000,
  });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}
function manualRecovery(target: string, outcome: string) {
  const documentation = readFileSync("docs/SELF_HOSTING.md", "utf8");
  const snippet = documentation.match(/\/\/ manual-private-recovery\n([\s\S]*?)\nJS\n/);
  expect(snippet, "The tested manual recovery procedure must remain in SELF_HOSTING.md").not.toBeNull();
  return spawnSync(process.execPath, ["--input-type=module", "--eval", snippet![1]], {
    cwd: process.cwd(), env: { ...process.env, RECOVERY_DIR: `${target}.recovery`, RECOVERY_OUTCOME: outcome }, encoding: "utf8", timeout: 10_000,
  });
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("guarded corrupt-database recovery", () => {
  it("preserves the complete original file set and imports objects without the SQLite collector lease", async () => {
    const { root, target, candidate, state } = fixture();
    writeFileSync(`${target}-wal`, Buffer.from("original WAL\u0000\u00ff"), { mode: 0o600 });
    writeFileSync(`${target}-shm`, Buffer.from("original SHM\u0000\u00fe"), { mode: 0o600 });
    const before = originals(target); const candidateHash = hash(candidate);
    await recoverCorruptDatabase(target, candidate);
    const archive = expectArchive(root, target, before);
    expect(hash(candidate)).toBe(candidateHash);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(archive, "manifest.json")).mode & 0o777).toBe(0o600);
    const installed = new DatabaseSync(target, { readOnly: true });
    try {
      expect(installed.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(installed.prepare("SELECT count(*) AS count FROM collector_lease").get()).toEqual({ count: 0 });
      const read = (key: string) => Buffer.from((installed.prepare("SELECT value FROM objects WHERE key=?").get(key) as { value: Uint8Array }).value).toString();
      expect(JSON.parse(read("ingestion/state.json"))).toEqual(state);
      expect(read("runtime/extra.json")).toBe('{"private":"retained"}');
      const revisions = installed.prepare("SELECT revision FROM objects").all() as Array<{ revision: number }>;
      expect(new Set(revisions.map(({ revision }) => revision)).size).toBe(revisions.length);
      expect(revisions.every(({ revision }) => revision > 0)).toBe(true);
    } finally { installed.close(); }
  });

  it("restores a healthy target transactionally with its inode unchanged", async () => {
    const { root, target, candidate } = fixture(); rmSync(target);
    const healthy = new LocalDatabase(target); initializeLocalRuntime(healthy, new Date("2026-09-17T00:00:00Z"));
    const before = healthy.read("private", "ingestion/state.json")!;
    healthy.compareAndSwap("private", "ingestion/state.json", before.value, before.revision, 5 * 1024 * 1024); healthy.close();
    const inode = statSync(target).ino;
    await recoverCorruptDatabase(target, candidate);
    expect(statSync(target).ino).toBe(inode);
    expect(existsSync(`${target}.recovery`)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith("travelcanary.db.pre-recovery-"))).toBe(false);
    const restored = new LocalDatabase(target);
    try {
      const state = restored.read("private", "ingestion/state.json")!;
      expect(JSON.parse(state.value).updatedAt).toBe(now.toISOString());
      expect(state.revision).toBeGreaterThan(before.revision + 1);
    } finally { restored.close(); }
  });

  it("rejects a healthy target's active SQLite lease even with the offline assertion", async () => {
    const { target, candidate } = fixture(); rmSync(target);
    const healthy = new LocalDatabase(target); initializeLocalRuntime(healthy); healthy.acquireCollector("live-collector-writer"); healthy.close();
    const before = originals(target);
    await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow(/collector/i);
    expectOriginals(target, before); expect(existsSync(`${target}.recovery`)).toBe(false);
  });

  it("does not classify a healthy unrelated SQLite schema as corrupt", async () => {
    const { target, candidate } = fixture(); rmSync(target);
    const unrelated = new DatabaseSync(target); unrelated.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('retain');"); unrelated.close();
    const before = originals(target);
    await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow();
    expectOriginals(target, before);
  });

  it("refuses a missing target rather than manufacturing evidence of corruption", async () => {
    const { target, candidate } = fixture(); rmSync(target);
    await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("does not turn an unreadable target into corruption evidence or replace it", async () => {
    const { target, candidate } = fixture(); const before = readFileSync(target);
    chmodSync(target, 0o000);
    try { await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow(); }
    finally { chmodSync(target, 0o600); }
    expect(readFileSync(target)).toEqual(before);
  });

  for (const failure of ["setup", "preservation", "changed-during-setup"]) {
    it(`handles an ordinary ${failure} failure without stranding an unchanged target behind the guard`, () => {
      const { target, candidate } = fixture(); const before = originals(target);
      const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const target = process.env.TC_TEST_TARGET;
const failure = process.env.TC_TEST_FAILURE;
const originalMkdir = fs.mkdirSync;
const originalOpen = fs.openSync;
const refuse = () => { throw Object.assign(new Error('TC_INJECTED_ORDINARY_FAILURE'), {code:'EACCES'}); };
fs.mkdirSync = (path, ...args) => {
  if (String(path) === target + '.recovery/originals' && failure !== 'preservation') {
    if (failure === 'changed-during-setup') fs.writeFileSync(target, 'new writer bytes during failed setup');
    refuse();
  }
  return originalMkdir(path, ...args);
};
fs.openSync = (path, ...args) => {
  if (String(path) === target + '.recovery/originals/travelcanary.db' && failure === 'preservation') refuse();
  return originalOpen(path, ...args);
};
syncBuiltinESMExports();
const { recoverCorruptDatabase } = await import(${JSON.stringify(resolve("src/lib/corrupt-recovery.ts"))});
await recoverCorruptDatabase(target, process.env.TC_TEST_CANDIDATE);
`;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(), env: { ...process.env, TC_TEST_TARGET: target, TC_TEST_CANDIDATE: candidate, TC_TEST_FAILURE: failure }, encoding: "utf8", timeout: 15_000,
      });
      expect(child.status).not.toBe(0); expect(child.stderr).toMatch(/TC_INJECTED_ORDINARY_FAILURE/);
      if (failure === "changed-during-setup") {
        expect(readFileSync(target, "utf8")).toBe("new writer bytes during failed setup");
        expect(existsSync(`${target}.recovery`)).toBe(true);
      } else {
        expectOriginals(target, before);
        expect(existsSync(`${target}.recovery`)).toBe(false);
        expect(() => assertNoPendingRecovery(target)).not.toThrow();
      }
    }, 20_000);
  }

  for (const kind of ["file", "symlink"] as const) {
    it(`refuses a pending guard that is a ${kind} without removing it`, async () => {
      const { root, target, candidate } = fixture(); const guard = `${target}.recovery`; const evidence = join(root, "operator-evidence");
      writeFileSync(evidence, "retain");
      if (kind === "file") writeFileSync(guard, "guard evidence");
      else symlinkSync(evidence, guard);
      const before = originals(target);
      expect(() => assertNoPendingRecovery(target)).toThrow();
      await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow();
      expectOriginals(target, before); expect(existsSync(guard)).toBe(true);
      expect(readFileSync(evidence, "utf8")).toBe("retain");
    });
  }

  for (const suffix of suffixes) {
    for (const kind of ["symlink", "hardlink", "directory"] as const) {
      it(`refuses a ${kind} at the original ${suffix || "database"} path`, async () => {
        const { root, target, candidate } = fixture();
        const suspicious = `${target}${suffix}`; const victim = join(root, "unrelated-private-file");
        writeFileSync(victim, "do not change", { mode: 0o600 });
        if (existsSync(suspicious)) rmSync(suspicious);
        if (kind === "symlink") symlinkSync(victim, suspicious);
        else if (kind === "hardlink") linkSync(victim, suspicious);
        else mkdirSync(suspicious);
        await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow();
        expect(readFileSync(victim, "utf8")).toBe("do not change");
        expect(existsSync(suspicious)).toBe(true);
      });
    }
  }

  it("never takes over an existing guard or edits its evidence", async () => {
    const { target, candidate } = fixture(); const guard = `${target}.recovery`;
    mkdirSync(guard, { mode: 0o700 }); writeFileSync(join(guard, "operator-evidence"), "retain");
    const before = originals(target);
    await expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow(/recovery|pending/i);
    expectOriginals(target, before); expect(readFileSync(join(guard, "operator-evidence"), "utf8")).toBe("retain");
  });

  it("blocks every ordinary LocalDatabase opener while a recovery is pending", () => {
    const { target } = fixture(); mkdirSync(`${target}.recovery`, { mode: 0o700 });
    const before = originals(target);
    expect(() => assertNoPendingRecovery(target)).toThrow(/recovery|pending/i);
    expect(() => new LocalDatabase(target)).toThrow(/recovery|pending/i);
    expectOriginals(target, before);
  });

  it("excludes a second recovery while the first owns the guard", async () => {
    const { target, candidate } = fixture(); let competing: Promise<unknown> | undefined;
    await recoverCorruptDatabase(target, candidate, (phase) => {
      if (phase === "preserved") competing = expect(recoverCorruptDatabase(target, candidate)).rejects.toThrow(/recovery|pending/i);
    });
    expect(competing).toBeDefined(); await competing;
  });

  for (const phase of ["preserved", "prepared", "cutover", "installed"]) {
    it(`preserves or verifies rollback of original bytes after a ${phase} failure`, async () => {
      const { target, candidate } = fixture(); const before = originals(target);
      let reached = false;
      await expect(recoverCorruptDatabase(target, candidate, (observed) => {
        if (observed === phase) { reached = true; throw new Error(`injected ${phase} failure`); }
      })).rejects.toThrow();
      expect(reached).toBe(true);
      expectOriginals(target, before);
      if (existsSync(`${target}.recovery`)) expect(() => assertNoPendingRecovery(target)).toThrow();
    });
  }

  it("retains a changed original and its guard instead of silently cutting over", async () => {
    const { target, candidate } = fixture(); const changed = Buffer.from("a writer changed the original");
    await expect(recoverCorruptDatabase(target, candidate, (phase) => {
      if (phase === "prepared") writeFileSync(target, changed);
    })).rejects.toThrow();
    expect(readFileSync(target)).toEqual(changed);
    expect(existsSync(`${target}.recovery`)).toBe(true);
  });

  it("never overwrites an unidentified file that appears at cutover", async () => {
    const { target, candidate } = fixture(); const unknown = Buffer.from("unknown replacement written by another process");
    await expect(recoverCorruptDatabase(target, candidate, (phase) => {
      if (phase === "cutover") { rmSync(target); writeFileSync(target, unknown, { flag: "wx", mode: 0o600 }); }
    })).rejects.toThrow();
    expect(readFileSync(target)).toEqual(unknown);
    expect(existsSync(`${target}.recovery`)).toBe(true);
  });

  it("refuses an unidentified sidecar that appears after the original inventory was checked", async () => {
    const { target, candidate } = fixture(); const unknown = Buffer.from("new unknown writer WAL");
    await expect(recoverCorruptDatabase(target, candidate, (phase) => {
      if (phase === "cutover") writeFileSync(`${target}-wal`, unknown, { flag: "wx", mode: 0o600 });
    })).rejects.toThrow();
    expect(readFileSync(`${target}-wal`)).toEqual(unknown);
    expect(existsSync(`${target}.recovery`)).toBe(true);
  });

  for (const phase of ["prepared", "cutover", "installed"]) {
    it(`leaves durable originals and a fail-closed guard after SIGKILL at ${phase}`, () => {
      const { target, candidate } = fixture(); const before = originals(target);
      interruptRecovery(target, candidate, phase);
      const guard = `${target}.recovery`;
      expect(existsSync(guard)).toBe(true);
      expect(() => assertNoPendingRecovery(target)).toThrow();
      expect(statSync(guard).mode & 0o777).toBe(0o700);
      const manifest = JSON.parse(readFileSync(join(guard, "manifest.json"), "utf8"));
      expect(manifest.version).toBe(1);
      for (const { suffix, bytes } of before) if (bytes !== null) {
        expect(readFileSync(join(guard, "originals", `travelcanary.db${suffix}`))).toEqual(bytes);
      }
    }, 20_000);
  }
});

describe("documented manual recovery procedure", () => {
  for (const outcome of ["complete", "rollback"]) {
    it(`refuses an unidentified rollback alias before manual ${outcome} changes the target set`, () => {
      const { target, candidate } = fixture();
      writeFileSync(`${target}-wal`, "preserved rollback WAL", { mode: 0o600 });
      writeFileSync(`${target}-shm`, "preserved rollback SHM", { mode: 0o600 });
      interruptAutomaticRollback(target, candidate);
      const guard = `${target}.recovery`; const alias = join(guard, "rollback.db");
      const replacement = join(guard, "unidentified-alias.db");
      writeFileSync(replacement, readFileSync(alias), { mode: 0o600 }); renameSync(replacement, alias);
      const before = originals(target); const aliasIdentity = statSync(alias);
      const result = manualRecovery(target, outcome);
      expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/Unknown rollback alias/);
      expectOriginals(target, before);
      expect(statSync(alias).ino).toBe(aliasIdentity.ino);
      expect(existsSync(guard)).toBe(true); expect(() => assertNoPendingRecovery(target)).toThrow();
    }, 20_000);
  }

  for (const outcome of ["complete", "rollback"]) {
    it(`verifies manual ${outcome} after SIGKILL during partial automatic rollback`, async () => {
      const { root, target, candidate } = fixture();
      writeFileSync(`${target}-wal`, "preserved rollback WAL", { mode: 0o600 });
      writeFileSync(`${target}-shm`, "preserved rollback SHM", { mode: 0o600 });
      const before = originals(target);
      interruptAutomaticRollback(target, candidate);
      const guard = `${target}.recovery`;
      expect(existsSync(guard)).toBe(true); expect(() => assertNoPendingRecovery(target)).toThrow();
      const manifest = JSON.parse(readFileSync(join(guard, "manifest.json"), "utf8"));
      const restored = manifest.restored.find((file: { suffix: string }) => file.suffix === "");
      expect(restored).toBeDefined();
      expect(restored).toMatchObject({ ino: statSync(target).ino, dev: statSync(target).dev, sha256: hash(target) });
      expect(readFileSync(target)).toEqual(before[0].bytes);
      expect(existsSync(`${target}-wal`)).toBe(false); expect(existsSync(`${target}-shm`)).toBe(false);
      const result = manualRecovery(target, outcome);
      expect(result.status, result.stderr).toBe(0);
      expectArchive(root, target, before);
      if (outcome === "rollback") expectOriginals(target, before);
      else expect(hash(target)).toBe(manifest.stagedSha256);
      for (const suffix of suffixes) if (existsSync(`${target}${suffix}`)) expect(statSync(`${target}${suffix}`).nlink).toBe(1);
      await expect(recoverCorruptDatabase(target, candidate)).resolves.toEqual(expect.any(String));
    }, 20_000);
  }

  for (const interrupted of ["prepared", "cutover", "installed", "partial-cutover", "linked-stage"]) {
    for (const outcome of ["complete", "rollback"]) {
      it(`verifies ${outcome} after interruption at ${interrupted} using the exact documentation snippet`, () => {
        const { root, target, candidate, state } = fixture();
        writeFileSync(`${target}-wal`, "preserved original WAL", { mode: 0o600 });
        writeFileSync(`${target}-shm`, "preserved original SHM", { mode: 0o600 });
        const before = originals(target);
        interruptRecovery(target, candidate, interrupted === "partial-cutover" || interrupted === "linked-stage" ? "cutover" : interrupted);
        const guard = `${target}.recovery`;
        const manifest = JSON.parse(readFileSync(join(guard, "manifest.json"), "utf8"));
        if (interrupted === "partial-cutover") rmSync(target);
        if (interrupted === "linked-stage") {
          for (const suffix of suffixes) rmSync(`${target}${suffix}`);
          linkSync(join(guard, "staged.db"), target);
        }
        const result = manualRecovery(target, outcome);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/verified.*archive retained.*Services remain stopped/);
        expectArchive(root, target, before);
        if (outcome === "rollback") expectOriginals(target, before);
        else {
          expect(hash(target)).toBe(manifest.stagedSha256);
          expect(existsSync(`${target}-wal`)).toBe(false);
          expect(existsSync(`${target}-shm`)).toBe(false);
          const installed = new DatabaseSync(target, { readOnly: true });
          try {
            const row = installed.prepare("SELECT value FROM objects WHERE key='ingestion/state.json'").get() as { value: Uint8Array };
            expect(JSON.parse(Buffer.from(row.value).toString())).toEqual(state);
          } finally { installed.close(); }
        }
        expect(statSync(target).mode & 0o777).toBe(0o600);
      }, 20_000);
    }
  }

  for (const corruption of ["missing-manifest", "malformed-manifest", "wrong-version", "wrong-target", "duplicate-original", "unsafe-suffix", "bad-original-hash", "modified-original-evidence", "unidentified-target", "unidentified-sidecar", "modified-stage", "missing-stage"]) {
    for (const outcome of ["complete", "rollback"]) {
      if ((corruption === "modified-stage" || corruption === "missing-stage") && outcome === "rollback") continue;
      it(`refuses manual ${outcome} with ${corruption} before changing any target file`, () => {
        const { target, candidate } = fixture();
        interruptRecovery(target, candidate, "prepared");
        const guard = `${target}.recovery`; const manifestPath = join(guard, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (corruption === "missing-manifest") rmSync(manifestPath);
        else if (corruption === "malformed-manifest") writeFileSync(manifestPath, "{invalid");
        else if (corruption === "modified-original-evidence") writeFileSync(join(guard, "originals/travelcanary.db"), "evidence changed");
        else if (corruption === "unidentified-target") {
          const replacement = join(guard, "unidentified-target.db");
          writeFileSync(replacement, readFileSync(target), { mode: 0o600 }); renameSync(replacement, target);
        }
        else if (corruption === "unidentified-sidecar") writeFileSync(`${target}-wal`, "unknown writer WAL", { mode: 0o600 });
        else if (corruption === "modified-stage") writeFileSync(join(guard, "staged.db"), "changed stage");
        else if (corruption === "missing-stage") rmSync(join(guard, "staged.db"));
        else {
          if (corruption === "wrong-version") manifest.version = 2;
          if (corruption === "wrong-target") manifest.target = "different.db";
          if (corruption === "duplicate-original") manifest.files.push({ ...manifest.files[0] });
          if (corruption === "unsafe-suffix") manifest.files[0].suffix = "/../../outside";
          if (corruption === "bad-original-hash") manifest.files[0].sha256 = "0".repeat(64);
          writeFileSync(manifestPath, JSON.stringify(manifest));
        }
        const before = originals(target);
        const result = manualRecovery(target, outcome);
        expect(result.status).not.toBe(0);
        expectOriginals(target, before);
        expect(existsSync(guard)).toBe(true);
        expect(() => assertNoPendingRecovery(target)).toThrow();
      }, 20_000);
    }
  }
});
