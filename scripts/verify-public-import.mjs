#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const sourceRepository = process.argv[2] || "../travelcanary-risk";
const sourceCommit = process.argv[3] || "e780697f957de8a072b70c4fe771345bd1315b8d";
const privatePaths = [
  ".agents/",
  ".pad/",
  ".pad.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "PROJECT_AGENT.md",
];
const publicChanges = new Set([
  ".gitignore",
  "README.md",
  "package.json",
  "package-lock.json",
  "scripts/generate-source-inventory.ts",
  "data/source-inventory.json",
]);

const sourcePaths = execFileSync(
  "git",
  ["-C", sourceRepository, "ls-tree", "-r", "--name-only", "-z", sourceCommit],
  { encoding: "utf8" },
).split("\0").filter(Boolean);

const excluded = (path) => privatePaths.some((entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry);
const mismatches = [];
for (const path of sourcePaths) {
  if (excluded(path) || publicChanges.has(path)) continue;
  let local;
  try {
    local = readFileSync(path);
  } catch {
    mismatches.push(`${path}: missing`);
    continue;
  }
  const source = execFileSync("git", ["-C", sourceRepository, "show", `${sourceCommit}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
  if (!local.equals(source)) mismatches.push(`${path}: changed`);
}

if (mismatches.length) {
  console.error(`Public import parity failed (${mismatches.length}):\n${mismatches.slice(0, 30).join("\n")}`);
  process.exit(1);
}
console.log(`Public import parity passed for ${sourcePaths.filter((path) => !excluded(path) && !publicChanges.has(path)).length} unchanged files at ${sourceCommit}.`);
