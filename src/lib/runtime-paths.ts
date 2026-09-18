import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type RuntimePaths = { privateRoot: string; publicRoot: string; cacheRoot: string };

function configuredRoot(value: string | undefined, fallback: string) {
  const configured = value?.trim();
  if (configured && !isAbsolute(configured)) throw new Error("Runtime data roots must be absolute");
  return resolve(configured || fallback);
}

function nested(left: string, right: string) {
  const path = relative(left, right);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function secureDirectory(pathname: string, create: boolean) {
  if (create) mkdirSync(pathname, { recursive: true, mode: 0o700 });
  const stat = lstatSync(pathname);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Runtime data roots must be real directories without symlinks");
  }
  return realpathSync(pathname);
}

function configuredRuntimePaths(environment: Record<string, string | undefined>): RuntimePaths {
  const legacy = configuredRoot(environment.TRAVELCANARY_DATA_DIR, resolve(".travelcanary"));
  const result = {
    privateRoot: configuredRoot(environment.TRAVELCANARY_PRIVATE_DATA_DIR, resolve(legacy, "private")),
    publicRoot: configuredRoot(environment.TRAVELCANARY_PUBLIC_DATA_DIR, resolve(legacy, "public")),
    cacheRoot: configuredRoot(environment.TRAVELCANARY_CACHE_DIR, resolve(legacy, "cache")),
  };
  const roots = Object.values(result);
  if (new Set(roots).size !== roots.length || roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && nested(root, other)))) {
    throw new Error("Private, public, and cache roots must be distinct and non-nested");
  }
  return result;
}

export function runtimePaths(environment: Record<string, string | undefined> = process.env, create = false): RuntimePaths {
  const configured = configuredRuntimePaths(environment);
  if (create) secureDirectory(dirname(configured.privateRoot), true);
  const result = {
    privateRoot: secureDirectory(configured.privateRoot, create),
    publicRoot: secureDirectory(configured.publicRoot, create),
    cacheRoot: secureDirectory(configured.cacheRoot, create),
  };
  const roots = Object.values(result);
  if (new Set(roots).size !== roots.length || roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && nested(root, other)))) {
    throw new Error("Private, public, and cache roots must be distinct and non-nested");
  }
  return result;
}

export function publicRuntimeRoot(environment: Record<string, string | undefined> = process.env) {
  const root = configuredRuntimePaths(environment).publicRoot;
  return secureDirectory(root, false);
}
