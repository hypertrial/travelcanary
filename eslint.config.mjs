import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-c2/**", ".next-c3/**", ".cache/**", "playwright-report/**", "test-results/**", "public/locations.json", "public/maplibre-gl-*.mjs"]),
]);
