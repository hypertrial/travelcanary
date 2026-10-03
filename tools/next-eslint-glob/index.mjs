import { statSync } from "node:fs";
import { globSync as globDirectories } from "glob/raw";

// ponytail: support only Next's directory-root lookup; remove the override when upstream replaces its vulnerable glob dependency.
export const globSync = (pattern, options) => {
  if (typeof pattern !== "string" || !pattern.length || options?.onlyDirectories !== true
    || Object.keys(options).some((key) => key !== "onlyDirectories")) {
    throw new TypeError("Only Next.js directory-root globbing is supported");
  }
  if (pattern.length > 10_000) throw new RangeError("Directory glob is too long");
  let depth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "\\") { index += 1; continue; }
    if (pattern[index] === "{" && ++depth > 64) throw new RangeError("Directory glob is too deeply nested");
    if (pattern[index] === "}") depth = Math.max(0, depth - 1);
  }
  if (pattern.startsWith("!") && !pattern.startsWith("!(")) return [];
  return globDirectories(pattern.replace(/(^|\/)\*\*\/?$/, "$1**/*"), {
    absolute: true,
    follow: true,
    nocase: false,
    dot: false,
  }).filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());
};
