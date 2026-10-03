import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
const consumerPath = nextRequire.resolve("./utils/get-root-dirs");
const { getRootDirs } = require(consumerPath) as {
  getRootDirs: (context: { cwd: string; settings: { next?: { rootDir: unknown } } }) => string[];
};
const adapter = nextRequire("fast-glob") as { globSync: (pattern: unknown, options?: unknown) => string[] };
const physical = (paths: string[]) => [...new Set(paths.map((path) => realpathSync(path)))].sort();
let directory: string;

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "travelcanary-next-roots-")));
  for (const path of ["apps/blog/nested", "apps/shop", "apps/.hidden", "outside/target/pages"]) {
    mkdirSync(join(directory, path), { recursive: true });
  }
  writeFileSync(join(directory, "apps/not-a-directory.txt"), "file");
  symlinkSync(join(directory, "outside/target"), join(directory, "apps/linked"), "dir");
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const roots = (rootDir: unknown) => getRootDirs({ cwd: directory, settings: { next: { rootDir } } });

describe("Next.js ESLint directory-root adapter", () => {
  it("uses the real Next consumer and defaults to its context cwd", () => {
    expect(getRootDirs({ cwd: directory, settings: {} })).toEqual([directory]);
    expect(roots(null)).toEqual([directory]);
    expect(roots([join(directory, "apps/blog"), 0, false, null, {}, join(directory, "apps/shop")]))
      .toEqual([join(directory, "apps/blog"), join(directory, "apps/shop")]);
  });

  it("resolves relative and absolute literal directories without including their children", () => {
    for (const pattern of [relative(process.cwd(), join(directory, "apps/blog")), join(directory, "apps/blog"), join(directory, "apps/blog/"),
      join(directory, "apps/blog").replaceAll("/", "\\")]) {
      expect(physical(roots(pattern))).toEqual(physical([join(directory, "apps/blog")]));
    }
  });

  it("matches wildcard and brace directory roots while excluding files and hidden directories", () => {
    expect(physical(roots(join(directory, "apps/*"))))
      .toEqual(physical([join(directory, "apps/blog"), join(directory, "apps/shop"), join(directory, "outside/target")]));
    expect(physical(roots(join(directory, "apps/{blog,shop}"))))
      .toEqual(physical([join(directory, "apps/blog"), join(directory, "apps/shop")]));
    expect(physical(roots(join(directory, "apps/.*")))).toEqual(physical([join(directory, "apps/.hidden")]));
    expect(roots(join(directory, "apps/not-a-directory.txt"))).toEqual([]);
    expect(roots(join(directory, "missing-*"))).toEqual([]);
  });

  it("follows literal and globbed symlink directories, including nested matches", () => {
    for (const suffix of ["linked", "link*"]) {
      expect(physical(roots(join(directory, "apps", suffix)))).toEqual(physical([join(directory, "outside/target")]));
    }
    expect(physical(roots(join(directory, "apps/**/pages")))).toEqual(physical([join(directory, "outside/target/pages")]));
  });

  it.each(["**", "**/"])("includes descendant directories for a trailing globstar %s", (suffix) => {
    expect(physical(roots(join(directory, "apps/blog", suffix)))).toEqual(physical([join(directory, "apps/blog/nested")]));
    const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e",
      "const {getRootDirs}=require(process.argv[1]);console.log(JSON.stringify(getRootDirs({cwd:process.cwd(),settings:{next:{rootDir:process.argv[2]}}})));",
      consumerPath, suffix], { cwd: join(directory, "apps/blog"), encoding: "utf8", timeout: 5_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(physical(JSON.parse(child.stdout))).toEqual(physical([join(directory, "apps/blog/nested")]));
  });

  it("distinguishes a negative-only pattern from a leading negative extglob", () => {
    expect(roots("!" + join(directory, "apps/*"))).toEqual([]);
    const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e",
      "const {getRootDirs}=require(process.argv[1]);console.log(JSON.stringify(getRootDirs({cwd:process.cwd(),settings:{next:{rootDir:'!(blog|shop)'}}})));",
      consumerPath], { cwd: join(directory, "apps"), encoding: "utf8", timeout: 5_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(physical(JSON.parse(child.stdout))).toEqual(physical([join(directory, "outside/target")]));
  });

  it.each([null, undefined, 1, [], {}])("rejects a non-string pattern %j at the adapter boundary", (pattern) => {
    expect(() => adapter.globSync(pattern, { onlyDirectories: true })).toThrow(TypeError);
  });

  it.each([undefined, {}, { onlyDirectories: false }, { onlyDirectories: true, absolute: true }, { onlyDirectories: true, ignore: [] }])
    ("rejects unsupported options %j", (options) => {
      expect(() => adapter.globSync(directory, options)).toThrow(TypeError);
    });

  it("exposes only the supported synchronous directory API and rejects empty patterns", () => {
    expect(Object.keys(adapter)).toEqual(["globSync"]);
    expect(() => adapter.globSync("", { onlyDirectories: true })).toThrow(TypeError);
  });

  it("accepts the 10000-character limit and rejects the next character before globbing", () => {
    expect(physical(adapter.globSync("./".repeat(5000), { onlyDirectories: true }))).toEqual(physical([process.cwd()]));
    expect(() => adapter.globSync("./".repeat(5000) + "x", { onlyDirectories: true })).toThrow(RangeError);
  });

  it("accepts 64 nested braces and rapidly rejects 65 or extremely deep nesting", () => {
    const nested = (depth: number) => join(directory, "apps", "{".repeat(depth) + "blog" + "}".repeat(depth));
    expect(() => adapter.globSync(nested(64), { onlyDirectories: true })).not.toThrow();
    expect(() => adapter.globSync(nested(65), { onlyDirectories: true })).toThrow(RangeError);
    const started = performance.now();
    expect(() => adapter.globSync("{".repeat(4000) + "x" + "}".repeat(4000), { onlyDirectories: true })).toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("bounds huge numeric brace ranges through the actual adapter without exhausting heap", () => {
    const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=commonjs", "-e",
      "const {globSync}=require(process.argv[1]);console.log(JSON.stringify(globSync('no-dir-{1..1000000000}',{onlyDirectories:true})));",
      nextRequire.resolve("fast-glob")], { cwd: directory, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([]);
  }, 12_000);

  it("limits the override to the Next plugin and resolves its actual package identity", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };
    expect(Object.entries(lock.packages).filter(([path, record]) => path && record.dependencies?.["fast-glob"])
      .map(([path]) => path)).toEqual(["node_modules/@next/eslint-plugin-next"]);
    expect(nextRequire("fast-glob/package.json").name).toBe("@travelcanary/next-eslint-glob");
  });

  it("preserves all 22 Next 16 rules in the application ESLint configuration", async () => {
    const warningRules = ["google-font-display", "google-font-preconnect", "next-script-for-ga", "no-async-client-component",
      "no-before-interactive-script-outside-document", "no-css-tags", "no-head-element", "no-img-element",
      "no-location-assign-relative-destination", "no-page-custom-font", "no-styled-jsx-in-document", "no-title-in-document-head",
      "no-typos", "no-unwanted-polyfillio"];
    const errorRules = ["inline-script-id", "no-assign-module-variable", "no-document-import-in-page", "no-duplicate-head",
      "no-head-import-in-document", "no-html-link-for-pages", "no-script-component-in-head", "no-sync-scripts"];
    const expected = [...warningRules, ...errorRules];
    expect(Object.keys(nextRequire("@next/eslint-plugin-next").rules).sort()).toEqual(expected.sort());
    const config = await new ESLint().calculateConfigForFile(resolve("src/app/page.tsx"));
    for (const [rules, severity] of [[warningRules, 1], [errorRules, 2]] as const) {
      for (const rule of rules) expect(config.rules[`@next/next/${rule}`][0], rule).toBe(severity);
    }
  });
});
