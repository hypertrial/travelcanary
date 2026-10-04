import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoPendingRecovery, LocalDatabase, validateLocalBackup } from "./local-storage";

export { assertNoPendingRecovery } from "./local-storage";
const suffixes = ["", "-wal", "-shm"] as const;
type FileRecord = { suffix: string; sha256: string; dev: number; ino: number };
type Phase = "preserved" | "prepared" | "cutover" | "installed";

function present(path: string) {
  try { return lstatSync(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
function flush(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function fingerprint(path: string, destination?: string): Omit<FileRecord, "suffix"> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Recovery requires regular files without symlinks or hardlinks");
    if (destination) output = openSync(destination, "wx", 0o600);
    const hash = createHash("sha256"); const bytes = Buffer.alloc(64 * 1024);
    for (let length; (length = readSync(fd, bytes, 0, bytes.length, null)) > 0;) {
      hash.update(bytes.subarray(0, length));
      if (output !== undefined) {
        let written = 0;
        while (written < length) written += writeSync(output, bytes, written, length - written);
      }
    }
    if (output !== undefined) fsyncSync(output);
    return { sha256: hash.digest("hex"), dev: stat.dev, ino: stat.ino };
  } finally { closeSync(fd); if (output !== undefined) closeSync(output); }
}
function unchanged(target: string, files: FileRecord[]) {
  return suffixes.every((suffix) => {
    const expected = files.find((file) => file.suffix === suffix);
    if (!present(`${target}${suffix}`)) return !expected;
    if (!expected) return false;
    const actual = fingerprint(`${target}${suffix}`);
    return actual.sha256 === expected.sha256 && actual.dev === expected.dev && actual.ino === expected.ino;
  });
}
function corrupt(path: string) {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout=0");
    const checks = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    return checks.length !== 1 || checks[0].quick_check !== "ok";
  } catch (error) {
    const code = error instanceof Error && "errcode" in error ? Number(error.errcode) & 255 : 0;
    if (code === 11 || code === 26) return true;
    throw error;
  } finally { database?.close(); }
}

/** Offline only: the caller must stop every process using this database. */
export async function recoverCorruptDatabase(target: string, candidatePath: string, hook?: (phase: Phase) => void) {
  validateLocalBackup(candidatePath);
  assertNoPendingRecovery(target);
  for (const suffix of suffixes) {
    const stat = present(`${target}${suffix}`);
    if (!stat && !suffix) throw new Error("Recovery target does not exist; use normal restore");
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("Recovery requires regular files without symlinks or hardlinks");
  }
  // A baseline before claiming the guard lets ordinary copy/setup failures release
  // it safely, without mistaking an unrelated target change for our own failure.
  const files: FileRecord[] = suffixes.filter((suffix) => present(`${target}${suffix}`)).map((suffix) => ({ suffix, ...fingerprint(`${target}${suffix}`) }));
  const guard = `${target}.recovery`;
  mkdirSync(guard, { mode: 0o700 });
  const originals = join(guard, "originals");
  const probe = join(guard, "probe");
  const stage = join(guard, "staged.db");
  const archive = `${target}.pre-recovery-${randomUUID()}`;
  const restored: FileRecord[] = [];
  let preserved = false; let cutover = false; let staged: Omit<FileRecord, "suffix"> | undefined;
  const manifest = (phase: Phase, announce = true) => {
    const temporary = join(guard, "manifest.tmp");
    writeFileSync(temporary, JSON.stringify({ version: 1, target: basename(target), phase, files, stagedSha256: staged?.sha256, staged, restored }) + "\n", { mode: 0o600 });
    flush(temporary); renameSync(temporary, join(guard, "manifest.json")); flush(guard); flush(dirname(target));
    if (announce) hook?.(phase);
  };
  try {
    mkdirSync(originals, { mode: 0o700 }); mkdirSync(probe, { mode: 0o700 });
    for (const file of files) {
      const copied = fingerprint(`${target}${file.suffix}`, join(originals, `${basename(target)}${file.suffix}`));
      if (copied.sha256 !== file.sha256 || copied.ino !== file.ino || copied.dev !== file.dev) throw new Error("Recovery target changed during preservation");
    }
    flush(originals);
    if (!unchanged(target, files)) throw new Error("Recovery target changed during preservation");
    preserved = true; manifest("preserved");
    for (const file of files) copyFileSync(join(originals, `${basename(target)}${file.suffix}`), join(probe, `${basename(target)}${file.suffix}`), constants.COPYFILE_EXCL);
    if (!corrupt(join(probe, basename(target)))) {
      validateLocalBackup(join(probe, basename(target)));
      if (!unchanged(target, files)) throw new Error("Recovery target changed during diagnosis");
      rmSync(guard, { recursive: true });
      const database = new LocalDatabase(target);
      const previous = `${target}.pre-restore-${randomUUID()}`;
      try { await database.restoreBackup(candidatePath, previous); } finally { database.close(); }
      return previous;
    }
    const database = new LocalDatabase(stage);
    try { await database.restoreBackup(candidatePath, join(guard, "staging-preimage.db")); } finally { database.close(); }
    const checkpoint = new DatabaseSync(stage);
    try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;"); } finally { checkpoint.close(); }
    validateLocalBackup(stage);
    staged = fingerprint(stage); flush(stage);
    manifest("prepared");
    if (!unchanged(target, files)) throw new Error("Recovery target changed before cutover");
    cutover = true; manifest("cutover");
    if (!unchanged(target, files)) throw new Error("Recovery target changed at cutover");
    for (const file of files) {
      const actual = fingerprint(`${target}${file.suffix}`);
      if (actual.dev !== file.dev || actual.ino !== file.ino || actual.sha256 !== file.sha256) throw new Error("Recovery refuses an unidentified target file");
      unlinkSync(`${target}${file.suffix}`);
    }
    if (suffixes.some((suffix) => present(`${target}${suffix}`))) throw new Error("Recovery refuses an unidentified target file");
    linkSync(stage, target); unlinkSync(stage);
    // No SQLite open here: WAL-aware reads may create sidecars.
    const installed = fingerprint(target);
    if (present(`${target}-wal`) || present(`${target}-shm`)) throw new Error("Unidentified recovery sidecar");
    if (installed.sha256 !== staged.sha256 || installed.ino !== staged.ino || installed.dev !== staged.dev) throw new Error("Installed recovery database changed");
    flush(target); flush(dirname(target)); manifest("installed");
    renameSync(guard, archive); flush(dirname(target));
    return archive;
  } catch (error) {
    // A healthy fallback may already have removed the guard. Its restore owns rollback.
    if (!present(guard)) throw error;
    try {
      if (!cutover && unchanged(target, files)) { renameSync(guard, archive); flush(dirname(target)); }
      else if (cutover && preserved) {
        for (const suffix of suffixes) {
          const existing = present(`${target}${suffix}`);
          const original = files.find((file) => file.suffix === suffix);
          if (existing) {
            const actual = fingerprint(`${target}${suffix}`);
            if (original && actual.sha256 === original.sha256 && actual.ino === original.ino && actual.dev === original.dev) continue;
            if (!suffix && staged && actual.ino === staged.ino && actual.dev === staged.dev && actual.sha256 === staged.sha256) unlinkSync(target);
            else throw new Error("Unidentified file prevents rollback");
          }
          if (original) {
            const replacement = join(guard, `rollback${suffix}.db`);
            const copied = fingerprint(join(originals, `${basename(target)}${suffix}`), replacement);
            if (copied.sha256 !== original.sha256) throw new Error("Rollback source hash mismatch");
            restored.push({ suffix, ...fingerprint(replacement) });
            // Record the replacement identity before publishing it, so manual
            // recovery can recognize a partial rollback after interruption.
            manifest("cutover", false);
            linkSync(replacement, `${target}${suffix}`); unlinkSync(replacement);
            if (fingerprint(`${target}${suffix}`).sha256 !== original.sha256) throw new Error("Rollback hash mismatch");
          }
        }
        flush(guard); flush(dirname(target));
        renameSync(guard, archive); flush(dirname(target));
      }
    } catch { /* Preserve the pending guard for manual resolution; never overwrite unknown files. */ }
    throw new Error(`Corruption recovery failed; keep all writers stopped. Inspect ${present(guard) ? guard : archive} and follow docs/SELF_HOSTING.md.`, { cause: error });
  }
}
