import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { HEAVY_VITEST_FILES } from "./scripts/check";

const pool = process.env.VITEST_POOL === "heavy" ? "heavy" : process.env.VITEST_POOL === "light" ? "light" : "all";
const lightWorkers = Number(process.env.VITEST_LIGHT_WORKERS || 4);
const heavyWorkers = Number(process.env.VITEST_HEAVY_WORKERS || 1);

export default defineConfig({
  test: {
    environment: "node",
    name: pool,
    maxWorkers: pool === "heavy" ? heavyWorkers : lightWorkers,
    include: pool === "heavy"
      ? HEAVY_VITEST_FILES
      : ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: pool === "light" ? HEAVY_VITEST_FILES : [],
    coverage: { reporter: ["text", "json"] },
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
