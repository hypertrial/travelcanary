import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installInstructions, installPlatform, isStandaloneDisplay } from "@/lib/install-presentation";

describe("install presentation", () => {
  it.each([
    ["public/brand/app-icon-192.png", 192],
    ["public/brand/app-icon-512.png", 512],
    ["public/brand/app-icon-maskable-512.png", 512],
    ["src/app/apple-icon.png", 180],
  ])("ships %s at its declared square size", (path, size) => {
    const png = readFileSync(resolve(path));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });

  it("detects iOS, Android, and other browsers", () => {
    expect(installPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
    expect(installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("other");
  });

  it("recognizes CSS and legacy iOS standalone modes", () => {
    const standalone = vi.fn(() => ({ matches: true }));
    expect(isStandaloneDisplay(standalone)).toBe(true);
    expect(standalone).toHaveBeenCalledWith("(display-mode: standalone)");
    expect(isStandaloneDisplay(() => ({ matches: false }), true)).toBe(true);
    expect(isStandaloneDisplay(() => ({ matches: false }), false)).toBe(false);
  });

  it("provides platform-specific native installation steps", () => {
    expect(installInstructions("ios")).toContain("Share");
    expect(installInstructions("android")).toContain("Install app");
    expect(installInstructions("other")).toContain("Add to Home Screen");
  });
});
