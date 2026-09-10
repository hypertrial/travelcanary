import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repository, "manifest.json"), "utf8"));
const fail = (message) => { throw new Error(`Omarchy plugin: ${message}`); };
const required = ["schemaVersion", "id", "name", "version", "kinds", "entryPoints"];
for (const field of required) if (!(field in manifest)) fail(`manifest missing ${field}`);
if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id) || manifest.id.includes("..") || manifest.id.startsWith("omarchy.")) fail("invalid or reserved id");
if (!Array.isArray(manifest.kinds) || !manifest.kinds.length) fail("kinds must be a non-empty array");
if (!manifest.entryPoints || typeof manifest.entryPoints !== "object" || Array.isArray(manifest.entryPoints)) fail("entryPoints must be an object");
const expected = { service: "service", "bar-widget": "barWidget" };
for (const kind of manifest.kinds) {
  const key = expected[kind];
  if (!key || !manifest.entryPoints[key]) fail(`unsupported or missing entry point for ${kind}`);
}
for (const entry of Object.values(manifest.entryPoints)) {
  if (typeof entry !== "string" || !entry || entry.startsWith("/") || entry.includes("..") || entry.includes("\n")) fail(`unsafe entry point ${entry}`);
  const target = resolve(repository, entry);
  if (!target.startsWith(`${repository}/`) || !lstatSync(target).isFile()) fail(`missing entry point ${entry}`);
}
if (!manifest.barWidget || manifest.barWidget.defaultSection !== "right" || manifest.barWidget.allowMultiple !== false) fail("bar widget placement contract changed");
if (manifest.barWidget.defaults?.serviceUrl !== "http://127.0.0.1:3000") fail("default service URL must remain loopback-only");
const refresh = manifest.barWidget.defaults?.refreshIntervalSec;
if (!Number.isInteger(refresh) || refresh < 60 || refresh > 3600) fail("default refresh interval is out of bounds");
const trackedModes = execFileSync("git", ["ls-files", "-s"], { cwd: repository, encoding: "utf8" });
if (trackedModes.split("\n").some((line) => line.startsWith("120000 "))) fail("tracked symlinks are not allowed");
const service = readFileSync(resolve(repository, manifest.entryPoints.service), "utf8");
for (const requiredArgument of ["--connect-timeout", "--max-time", "--max-filesize", "--max-redirs", "--noproxy", '"=http"']) {
  if (!service.includes(requiredArgument)) fail(`service is missing bounded curl argument ${requiredArgument}`);
}
const pluginQml = Object.values(manifest.entryPoints).map((entry) => readFileSync(resolve(repository, entry), "utf8")).join("\n")
  + readFileSync(resolve(repository, "omarchy/Panel.qml"), "utf8");
if (/\b(?:sudo|pkexec|apt|dnf|pacman)\b|omarchy-notification-send/.test(pluginQml)) fail("plugin must not install packages, elevate privileges, or send notifications");
console.log(`Omarchy manifest valid: ${manifest.id} (${manifest.kinds.join(", ")})`);
