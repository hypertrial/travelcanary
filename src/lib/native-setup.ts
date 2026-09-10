import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type NativeInstallPaths = {
  configDirectory: string;
  dataDirectory: string;
  environmentFile: string;
  unitDirectory: string;
  webUnit: string;
  collectorUnit: string;
};

function systemdQuote(value: string) {
  if (/\r|\n/.test(value)) throw new Error("Systemd paths cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
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
  return {
    configDirectory,
    dataDirectory: join(dataHome, "travelcanary"),
    environmentFile: join(configDirectory, "environment"),
    unitDirectory,
    webUnit: join(unitDirectory, "travelcanary-web.service"),
    collectorUnit: join(unitDirectory, "travelcanary-collector.service"),
  };
}

export function nativeUnitFiles(options: { repository: string; node: string; dataDirectory: string; environmentFile: string; port: number }) {
  const repository = resolve(options.repository);
  const next = join(repository, "node_modules", "next", "dist", "bin", "next");
  const collector = join(repository, "scripts", "collector.ts");
  const common = `WorkingDirectory=${systemdQuote(repository)}\nEnvironmentFile=${systemdQuote(options.environmentFile)}\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nReadWritePaths=${systemdQuote(options.dataDirectory)}`;
  return {
    web: `[Unit]\nDescription=TravelCanary web\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${common}\nExecStart=${systemdQuote(options.node)} ${systemdQuote(next)} start --hostname 127.0.0.1 --port ${options.port}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
    collector: `[Unit]\nDescription=TravelCanary collector\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${common}\nExecStart=${systemdQuote(options.node)} --import tsx ${systemdQuote(collector)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=120\n\n[Install]\nWantedBy=default.target\n`,
  };
}

export function writeNativeFiles(options: { home: string; repository: string; node: string; port: number; environment?: Record<string, string | undefined> }) {
  const paths = nativeInstallPaths(options.home, options.environment);
  for (const path of [paths.configDirectory, paths.dataDirectory, paths.unitDirectory]) {
    if (/\r|\n/.test(path)) throw new Error("Native install paths cannot contain newlines");
    mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  }
  const variables = [
    "TRAVELCANARY_RUNTIME=local",
    `TRAVELCANARY_DATA_DIR=${environmentQuote(paths.dataDirectory)}`,
    "NEXT_PUBLIC_CATALOG_VERSION=3",
    "NEXT_PUBLIC_DATA_MODE=live",
    "LOCAL_CONDITIONS_ENABLED=true",
  ];
  writeFileSync(paths.environmentFile, `${variables.join("\n")}\n`, { mode: 0o600 });
  const units = nativeUnitFiles({ repository: options.repository, node: options.node, dataDirectory: paths.dataDirectory, environmentFile: paths.environmentFile, port: options.port });
  writeFileSync(paths.webUnit, units.web, { mode: 0o600 });
  writeFileSync(paths.collectorUnit, units.collector, { mode: 0o600 });
  for (const path of [paths.environmentFile, paths.webUnit, paths.collectorUnit]) chmodSync(path, 0o600);
  return paths;
}
