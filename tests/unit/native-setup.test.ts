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
    const dockerfile = await import("node:fs/promises").then(({ readFile }) => readFile("Dockerfile", "utf8"));
    const cli = await import("node:fs/promises").then(({ readFile }) => readFile("bin/travelcanary", "utf8"));
    const [innerCli, collector] = await import("node:fs/promises").then(({ readFile }) => Promise.all(["scripts/travelcanary-cli.ts", "scripts/collector.ts"].map((path) => readFile(path, "utf8"))));
    const packageJson = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8")));
    expect(compose).toContain('"127.0.0.1:${TRAVELCANARY_PORT:-3000}:3000"');
    expect(compose).toContain("command: npm run start:container");
    expect(compose).toContain('command: ["node", "--import", "tsx", "scripts/collector.ts"]');
    expect(compose).toContain("stop_grace_period: 60s");
    expect(compose.match(/image: travelcanary:local/g)).toHaveLength(2);
    expect(compose.match(/travelcanary-data:\/data/g)).toHaveLength(2);
    expect(compose).not.toMatch(/network_mode:\s*host|privileged:\s*true/);
    expect(packageJson.scripts["start:container"]).toBe("next start --hostname 0.0.0.0");
    expect(dockerfile).toContain("node:24.19.0-bookworm-slim");
    expect(dockerfile).toContain('CMD ["npm", "run", "start:container"]');
    expect(cli).toMatch(/plugin\.status === 0[\s\S]+docker-compose/);
    expect(cli).toContain('current?.runtime === "docker" && !process.env.TRAVELCANARY_DATA_DIR');
    expect(innerCli.match(/install\?\.runtime === "docker" && !process\.env\.TRAVELCANARY_DATA_DIR/g)).toHaveLength(3);
    expect(collector).toContain('void scheduler.start(completedAt); status("idle");');
  });
});
