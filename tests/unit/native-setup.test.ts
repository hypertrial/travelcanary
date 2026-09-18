import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Shared JavaScript CLI helper has no declaration file.
import { fetchHealth } from "../../scripts/fetch-health.mjs";

describe("native self-host setup", () => {
  it("runs web and collector system services under distinct operating-system identities", () => {
    const web = readFileSync("deploy/systemd/travelcanary-web.service", "utf8");
    const collector = readFileSync("deploy/systemd/travelcanary-collector.service", "utf8");
    const once = readFileSync("deploy/systemd/travelcanary-collector-once.service", "utf8");
    expect(web).toContain("--hostname 127.0.0.1 --port @PORT@");
    expect(web).toContain("NoNewPrivileges=true");
    expect(web).toContain("User=travelcanary-web");
    expect(web).toContain("Group=travelcanary-public");
    expect(collector).toContain("User=travelcanary-collector");
    expect(once).toContain("User=travelcanary-collector");
    expect(web).not.toContain("User=travelcanary-collector");
    expect(web).toContain("InaccessiblePaths=@PRIVATE_DIRECTORY@ @CACHE_DIRECTORY@ @COLLECTOR_ENVIRONMENT_FILE@");
    expect(collector).toContain("scripts/collector.ts");
  });

  it("refuses the legacy same-user native installer", () => {
    const cli = readFileSync("scripts/travelcanary-cli.ts", "utf8");
    expect(cli).toContain("Native Linux requires the dedicated-user system services");
    expect(cli).not.toContain('systemctl", ["--user"');
  });

  it("disables every live source in the system-service smoke fixture", () => {
    const renderer = readFileSync("scripts/render-systemd-smoke.ts", "utf8");
    expect(renderer).toContain("INGESTION_DISABLED_SOURCES=${sourceIds.join");
    expect(renderer).toContain("CONDITIONS_DISABLED_SOURCES=${conditionSourceIds.join");
  });

  it("keeps Docker on loopback with one image and isolated private/public/cache volumes", async () => {
    const compose = await import("node:fs/promises").then(({ readFile }) => readFile("compose.yaml", "utf8"));
    const dockerfile = await import("node:fs/promises").then(({ readFile }) => readFile("Dockerfile", "utf8"));
    const cli = await import("node:fs/promises").then(({ readFile }) => readFile("bin/travelcanary", "utf8"));
    const [innerCli, collector] = await import("node:fs/promises").then(({ readFile }) => Promise.all(["scripts/travelcanary-cli.ts", "scripts/collector.ts"].map((path) => readFile(path, "utf8"))));
    const packageJson = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8")));
    expect(compose).toContain('"127.0.0.1:${TRAVELCANARY_PORT:-3000}:3000"');
    expect(compose).toContain("command: npm run start:container");
    expect(compose).toContain("http://127.0.0.1:3000/api/healthz");
    expect(compose).toContain("if(!r.ok)process.exit(1)");
    expect(compose).toContain('command: ["node", "--import", "tsx", "scripts/collector.ts"]');
    expect(compose).toContain("stop_grace_period: 60s");
    expect(compose.match(/image: travelcanary:local/g)).toHaveLength(3);
    expect(compose).toContain("travelcanary-private:/data/private");
    expect(compose).toContain("travelcanary-public:/data/public:ro");
    expect(compose).toContain("travelcanary-cache:/data/cache");
    expect(compose).not.toMatch(/network_mode:\s*host|privileged:\s*true/);
    expect(packageJson.scripts["start:container"]).toBe("next start --hostname 0.0.0.0");
    expect(dockerfile).toContain("node:24.19.0-bookworm-slim");
    expect(dockerfile).toContain('CMD ["npm", "run", "start:container"]');
    expect(cli).toMatch(/plugin\.status === 0[\s\S]+docker-compose/);
    expect(cli).toContain('current?.runtime === "docker" && !process.env.TRAVELCANARY_DATA_DIR');
    expect(cli).toContain("const response = await fetchHealth(current.port)");
    expect(innerCli.match(/install\?\.runtime === "docker" && !process\.env\.TRAVELCANARY_DATA_DIR/g)).toHaveLength(3);
    expect(innerCli).toContain("const response = await fetchHealth(install.port)");
    expect(collector).toContain('void scheduler.start(completedAt); status("idle");');
  });

  it("retries through delayed startup and returns strict degraded health", async () => {
    let attempts = 0;
    const response = await fetchHealth(3000, { deadlineMs: 1_000, retryMs: 1, fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Server is starting");
      return Response.json({ schemaVersion: 1, status: "degraded" }, { status: 503 });
    } });
    expect(attempts).toBe(3);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ schemaVersion: 1, status: "degraded" });
  });

  it("bounds retries when the local server remains unavailable", async () => {
    const startedAt = Date.now();
    let attempts = 0;
    await expect(fetchHealth(3000, { deadlineMs: 100, retryMs: 20, fetchImpl: async () => {
      attempts += 1;
      throw new Error("Server is unavailable");
    } })).rejects.toThrow("Server is unavailable");
    expect(attempts).toBeGreaterThan(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
