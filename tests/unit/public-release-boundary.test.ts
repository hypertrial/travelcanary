import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public release boundary", () => {
  it("uses the public package identity and MIT license", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.name).toBe("travelcanary");
    expect(packageJson.private).toBeUndefined();
    expect(await readFile("LICENSE", "utf8")).toContain("MIT License");
  });

  it("does not track private workflow or operator state", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
    const forbidden = [
      /^\.agents\//,
      /^\.pad(?:\/|\.toml$)/,
      /^(?:CLAUDE|PROJECT_AGENT)\.md$/,
      /(?:^|\/)travelcanary\.db(?:-|$)/,
      /(?:^|\/)backups?\//,
      /(?:^|\/)playwright-report\//,
      /(?:^|\/)test-results\//,
      /(?:^|\/)\.env(?!\.example$)/,
    ];
    expect(tracked.filter((path) => forbidden.some((pattern) => pattern.test(path)))).toEqual([]);
  });

  it("classifies every inventoried source", async () => {
    const inventory = JSON.parse(await readFile("data/source-inventory.json", "utf8"));
    const policies = new Set(["open", "restricted", "gated", "blocked"]);
    expect(inventory.schemaVersion).toBe(3);
    expect(inventory.localConditions.every((source: { policy: string }) => policies.has(source.policy))).toBe(true);
    expect(inventory.providers.every((source: { policy: string }) => policies.has(source.policy))).toBe(true);
    expect(inventory.nationalWarningPartitions.flatMap((country: { systems: { policy: string }[] }) => country.systems)
      .every((source: { policy: string }) => policies.has(source.policy))).toBe(true);
  });

  it("uses the public repository for generated catalog provenance", async () => {
    const locations = JSON.parse(await readFile("data/locations.json", "utf8"));
    const repositoryProvenance = locations.map((location: { provenance?: { name?: string } }) => location.provenance?.name)
      .filter((name: unknown) => typeof name === "string" && name.includes("github.com/hypertrial/"));
    expect(repositoryProvenance).toHaveLength(56);
    expect(new Set(repositoryProvenance)).toEqual(new Set(["https://github.com/hypertrial/travelcanary/blob/main/data/locations.json"]));
  });
});
