import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type NativeInstallPaths = {
  configDirectory: string;
  dataDirectory: string;
  privateDirectory: string;
  publicDirectory: string;
  cacheDirectory: string;
  webEnvironmentFile: string;
  environmentFile: string;
  unitDirectory: string;
  webUnit: string;
  collectorUnit: string;
};

function systemdExecQuote(value: string) {
  if (/\r|\n/.test(value)) throw new Error("Systemd paths cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function systemdPath(value: string) {
  if (/\r|\n/.test(value)) throw new Error("Systemd paths cannot contain newlines");
  return value
    .replaceAll("\\", "\\x5c")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09")
    .replaceAll("\"", "\\x22")
    .replaceAll("'", "\\x27")
    .replaceAll("%", "%%");
}

function environmentQuote(value: string) {
  if (/\r|\n/.test(value)) throw new Error("Environment values cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function nativeInstallPaths(home: string, environment: Record<string, string | undefined> = process.env): NativeInstallPaths {
  const configHome = resolve(environment.XDG_CONFIG_HOME || join(home, ".config"));
  const dataHome = resolve(environment.XDG_DATA_HOME || join(home, ".local", "share"));
  const configDirectory = join(configHome, "travelcanary");
  const unitDirectory = join(configHome, "systemd", "user");
  const dataDirectory = join(dataHome, "travelcanary");
  return {
    configDirectory,
    dataDirectory,
    privateDirectory: join(dataDirectory, "private"),
    publicDirectory: join(dataDirectory, "public"),
    cacheDirectory: join(dataDirectory, "cache"),
    webEnvironmentFile: join(configDirectory, "web-environment"),
    environmentFile: join(configDirectory, "collector-environment"),
    unitDirectory,
    webUnit: join(unitDirectory, "travelcanary-web.service"),
    collectorUnit: join(unitDirectory, "travelcanary-collector.service"),
  };
}

export function nativeUnitFiles(options: { repository: string; node: string; dataDirectory: string; environmentFile: string;
  webEnvironmentFile?: string; port: number }) {
  const repository = resolve(options.repository);
  const next = join(repository, "node_modules", "next", "dist", "bin", "next");
  const collector = join(repository, "scripts", "collector.ts");
  const common = (environmentFile: string) => `WorkingDirectory=${systemdPath(repository)}\nEnvironmentFile=${systemdPath(environmentFile)}\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nCapabilityBoundingSet=\nAmbientCapabilities=\nRestrictSUIDSGID=true`;
  const publicDirectory = join(options.dataDirectory, "public");
  return {
    web: `[Unit]\nDescription=TravelCanary web\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${common(options.webEnvironmentFile || options.environmentFile)}\nReadOnlyPaths=${systemdPath(publicDirectory)}\nExecStart=${systemdExecQuote(options.node)} ${systemdExecQuote(next)} start --hostname 127.0.0.1 --port ${options.port}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
    collector: `[Unit]\nDescription=TravelCanary collector\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${common(options.environmentFile)}\nReadWritePaths=${systemdPath(join(options.dataDirectory, "private"))} ${systemdPath(publicDirectory)} ${systemdPath(join(options.dataDirectory, "cache"))}\nExecStart=${systemdExecQuote(options.node)} --import tsx ${systemdExecQuote(collector)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=120\n\n[Install]\nWantedBy=default.target\n`,
  };
}

export function writeNativeFiles(options: { home: string; repository: string; node: string; port: number; environment?: Record<string, string | undefined> }) {
  const paths = nativeInstallPaths(options.home, options.environment);
  for (const path of [paths.configDirectory, paths.dataDirectory, paths.privateDirectory, paths.publicDirectory, paths.cacheDirectory, paths.unitDirectory]) {
    if (/\r|\n/.test(path)) throw new Error("Native install paths cannot contain newlines");
    mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  }
  const collectorVariables = [
    "TRAVELCANARY_RUNTIME=local",
    `TRAVELCANARY_PRIVATE_DATA_DIR=${environmentQuote(paths.privateDirectory)}`,
    `TRAVELCANARY_PUBLIC_DATA_DIR=${environmentQuote(paths.publicDirectory)}`,
    `TRAVELCANARY_CACHE_DIR=${environmentQuote(paths.cacheDirectory)}`,
    "LOCAL_CONDITIONS_ENABLED=true",
  ];
  const webVariables = [
    "TRAVELCANARY_RUNTIME=local",
    `TRAVELCANARY_PUBLIC_DATA_DIR=${environmentQuote(paths.publicDirectory)}`,
  ];
  writeFileSync(paths.webEnvironmentFile, `${webVariables.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(paths.environmentFile, `${collectorVariables.join("\n")}\n`, { mode: 0o600 });
  const units = nativeUnitFiles({ repository: options.repository, node: options.node, dataDirectory: paths.dataDirectory,
    environmentFile: paths.environmentFile, webEnvironmentFile: paths.webEnvironmentFile, port: options.port });
  writeFileSync(paths.webUnit, units.web, { mode: 0o600 });
  writeFileSync(paths.collectorUnit, units.collector, { mode: 0o600 });
  for (const path of [paths.webEnvironmentFile, paths.environmentFile, paths.webUnit, paths.collectorUnit]) chmodSync(path, 0o600);
  return paths;
}
