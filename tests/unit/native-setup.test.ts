import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeUnitFiles, writeNativeFiles } from "@/lib/native-setup";

describe("native self-host setup", () => {
  it("generates rootless loopback user services in an isolated home", () => {
    const home = mkdtempSync(join(tmpdir(), "travelcanary-home-"));
    const paths = writeNativeFiles({ home, repository: "/opt/travelcanary", node: "/opt/node/bin/node", port: 3456, environment: {} });
    const web = readFileSync(paths.webUnit, "utf8");
    const collector = readFileSync(paths.collectorUnit, "utf8");
    expect(web).toContain("--hostname 127.0.0.1 --port 3456");
    expect(web).toContain("NoNewPrivileges=true");
    expect(collector).toContain("scripts/collector.ts");
    expect(collector).not.toMatch(/sudo|apt|dnf|pacman/);
    expect(readFileSync(paths.environmentFile, "utf8")).toContain(`TRAVELCANARY_DATA_DIR="${paths.dataDirectory}"`);
    expect(statSync(paths.environmentFile).mode & 0o777).toBe(0o600);
  });

  it("quotes paths and rejects newline injection", () => {
    expect(nativeUnitFiles({ repository: "/opt/Travel Canary", node: "/opt/node", dataDirectory: "/tmp/data", environmentFile: "/tmp/env", port: 3000 }).web)
      .toContain("WorkingDirectory=/opt/Travel\\x20Canary");
    expect(() => nativeUnitFiles({ repository: "/opt/bad\npath", node: "/opt/node", dataDirectory: "/tmp/data", environmentFile: "/tmp/env", port: 3000 })).toThrow(/newlines/);
  });

  it("keeps Docker on loopback with one image and one shared named volume", async () => {
    const compose = await import("node:fs/promises").then(({ readFile }) => readFile("compose.yaml", "utf8"));
    expect(compose).toContain('"127.0.0.1:${TRAVELCANARY_PORT:-3000}:3000"');
    expect(compose.match(/image: travelcanary:local/g)).toHaveLength(2);
    expect(compose.match(/travelcanary-data:\/data/g)).toHaveLength(2);
    expect(compose).not.toMatch(/network_mode:\s*host|privileged:\s*true/);
    expect(await import("node:fs/promises").then(({ readFile }) => readFile("Dockerfile", "utf8"))).toContain("node:24.19.0-bookworm-slim");
  });
});
