import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("dependency lockfile", () => {
  it("closes the dependency and peer graph, including optional platform packages", () => {
    const result = spawnSync("npm", ["ls", "--all", "--package-lock-only", "--json", "--offline"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 25_000);
});
