import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("maplibre-gl/package.json")));
const outputDirectory = path.join(process.cwd(), "public");
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  copyFile(path.join(packageRoot, "dist", "maplibre-gl-worker.mjs"), path.join(outputDirectory, "maplibre-gl-worker.mjs")),
  copyFile(path.join(packageRoot, "dist", "maplibre-gl-shared.mjs"), path.join(outputDirectory, "maplibre-gl-shared.mjs")),
]);
console.log("Prepared MapLibre worker assets in public/");
