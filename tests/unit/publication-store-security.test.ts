import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
});
