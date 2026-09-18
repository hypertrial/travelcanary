import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseCatalogStateV15 } from "@/lib/domain/catalog-state";
import { disabledLocalPolicy } from "@/lib/local-policy";
import { LocalDatabase } from "@/lib/local-storage";
import { createEmptyState } from "@/lib/risk-state";
import { createLegacyState } from "../fixtures/legacy-state";

const now = new Date("2026-09-18T00:00:00.000Z");

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
    const root = mkdtempSync(join(tmpdir(), "travelcanary-restore-"));
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
});
