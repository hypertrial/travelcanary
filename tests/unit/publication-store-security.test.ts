import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilePublicationStore, publicationSha256 } from "@/lib/publication-store";

const keyFor = (body: string) => `catalogs/3/objects/sha256/${publicationSha256(body)}.json`;

describe("filesystem publication boundary", () => {
  it("writes immutable objects and rejects overwrite, traversal, absolute paths, and oversized reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "travelcanary-public-")); const store = new FilePublicationStore(root, true);
    const key = keyFor("{}"); await store.putImmutable(key, "{}"); await expect(store.putImmutable(key, "{}")).resolves.toEqual({});
    await expect(store.putImmutable(key, "different")).rejects.toThrow(/different content/);
    for (const invalid of ["../private/state.json", "/etc/passwd", "catalogs/3/objects/sha256/%2f.json", "catalogs\\3\\publication\\latest.json", ""]) {
      await expect(store.read(invalid, 100)).rejects.toThrow(/allowlisted/);
    }
    await expect(store.read(key, 1)).rejects.toThrow(/Invalid publication object/);
  });

  it("rejects symlink and hardlink objects", async () => {
    const root = mkdtempSync(join(tmpdir(), "travelcanary-public-")); const store = new FilePublicationStore(root, true);
    const outside = join(mkdtempSync(join(tmpdir(), "travelcanary-outside-")), "object.json"); writeFileSync(outside, "{}");
    const symlinkKey = keyFor("symlink"); const symlinkPath = join(root, ...symlinkKey.split("/"));
    mkdirSync(dirname(symlinkPath), { recursive: true }); symlinkSync(outside, symlinkPath);
    await expect(store.read(symlinkKey, 100)).rejects.toThrow(/symlinks/);

    const hardlinkKey = keyFor("hardlink"); const hardlinkPath = join(root, ...hardlinkKey.split("/"));
    linkSync(outside, hardlinkPath);
    await expect(store.read(hardlinkKey, 100)).rejects.toThrow(/Invalid publication object/);
  });

  it("rejects a symlinked pointer lock without creating its target outside the public root", async () => {
    const root = mkdtempSync(join(tmpdir(), "travelcanary-public-")); const store = new FilePublicationStore(root, true);
    const outside = join(mkdtempSync(join(tmpdir(), "travelcanary-outside-")), "pointer-lock.sqlite");
    const publication = join(root, "catalogs/3/publication"); mkdirSync(publication, { recursive: true });
    symlinkSync(outside, join(publication, "latest.json.lock.sqlite"));
    await expect(store.replacePointer('{"version":1}', null)).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it("allows only one pointer replacement for the same ETag", async () => {
    const root = mkdtempSync(join(tmpdir(), "travelcanary-public-")); const store = new FilePublicationStore(root, true);
    const first = await store.replacePointer('{"version":1}', null);
    const results = await Promise.allSettled([
      store.replacePointer('{"version":2}', first.etag),
      store.replacePointer('{"version":3}', first.etag),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("fails closed while another process holds the pointer lock and recovers after that process crashes", async () => {
    const root = mkdtempSync(join(tmpdir(), "travelcanary-public-"));
    const store = new FilePublicationStore(root, true);
    const first = await store.replacePointer('{"version":1}', null);
    const lockPath = join(root, "catalogs/3/publication/latest.json.lock.sqlite");
    const worker = `const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]); database.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", worker, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolveReady, reject) => {
      child.once("error", reject); child.stdout.setEncoding("utf8");
      child.stdout.once("data", (chunk) => chunk.includes("locked") ? resolveReady() : reject(new Error(String(chunk))));
    });
    await expect(store.replacePointer('{"version":2}', first.etag)).rejects.toThrow(/being replaced/);
    child.kill("SIGKILL"); await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    await expect(store.replacePointer('{"version":2}', first.etag)).resolves.toEqual({ etag: publicationSha256('{"version":2}') });
  }, 10_000);
});
