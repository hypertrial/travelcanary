import { mkdir, readFile, writeFile } from "node:fs/promises";
import { catalogLocationsV3 } from "../src/lib/catalog-data";
import { PublicCatalogV3Schema } from "../src/lib/domain/catalog-public";

const output = new URL("../public/catalogs/3/locations.json", import.meta.url);
const body = `${JSON.stringify(PublicCatalogV3Schema.parse(catalogLocationsV3))}\n`;
if (Buffer.byteLength(body) > 150_000) throw new Error("Catalog 3 exceeds 150 KB publication limit");
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== body) throw new Error("Catalog 3 public artifact is out of date");
} else {
  await mkdir(new URL("./", output), { recursive: true });
  await writeFile(output, body);
}
console.log(`Catalog 3: ${catalogLocationsV3.length} destinations, ${Buffer.byteLength(body)} bytes (inactive)`);
