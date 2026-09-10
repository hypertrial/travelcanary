import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { chromium } from "@playwright/test";

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a local port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

const distDir = process.env.NEXT_DIST_DIR || ".next";
const inheritedOrigin = process.env.PLAYWRIGHT_BASE_URL;
const ownedServer = !inheritedOrigin;
let port;
let origin;
let server;
let serverOutput = "";

if (inheritedOrigin) {
  origin = inheritedOrigin.replace(/\/$/, "");
} else {
  port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    env: { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_DATA_MODE: "demo", NEXT_DIST_DIR: distDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
  server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
}

async function waitForServer() {
  if (!ownedServer) {
    const response = await fetch(origin);
    if (!response.ok) throw new Error(`Inherited production server at ${origin} is not ready`);
    return;
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Production server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not start:\n${serverOutput}`);
}

function localPath(url) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/_next/")) return path.join(distDir, pathname.slice("/_next/".length));
  return path.join("public", pathname.slice(1));
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const assets = new Map();
  let sequence = 0;
  const catalogRequests = new Map();
  let catalogSequence = Number.POSITIVE_INFINITY;
  let snapshotSequence = Number.POSITIVE_INFINITY;
  let snapshotRequestObserved = false;
  page.on("request", (request) => {
    sequence += 1;
    const url = request.url();
    if (url.startsWith(origin) && new URL(url).pathname.endsWith("/locations.json")) catalogRequests.set(new URL(url).pathname, sequence);
    if (url.includes("demo-snapshot.json") || new URL(url).pathname.endsWith("/latest.json")) {
      snapshotSequence = Math.min(snapshotSequence, sequence);
      snapshotRequestObserved = true;
    }
    if (!url.startsWith(origin)) return;
    const pathname = new URL(url).pathname;
    if (/\.(?:js|mjs|css|woff2)$/.test(pathname)) assets.set(url, sequence);
  });
  await page.goto(origin);
  await page.locator('[data-locations-ready="true"]').waitFor({ timeout: 20_000 });
  await page.locator(".maplibregl-canvas").waitFor({ timeout: 20_000 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (["/maplibre-gl-worker.mjs", "/maplibre-gl-shared.mjs"].every((pathname) => assets.has(`${origin}${pathname}`))) break;
    await page.waitForTimeout(50);
  }
  for (const pathname of ["/maplibre-gl-worker.mjs", "/maplibre-gl-shared.mjs"]) {
    if (!assets.has(`${origin}${pathname}`)) throw new Error(`MapLibre did not request ${pathname}`);
  }
  const catalogVersion = await page.locator('meta[name="travelcanary-catalog-version"]').getAttribute("content");
  if (!["2", "3"].includes(catalogVersion)) throw new Error("Missing or invalid catalog release metadata");
  if (process.env.EXPECTED_CATALOG_VERSION && catalogVersion !== process.env.EXPECTED_CATALOG_VERSION) throw new Error("Built catalog release does not match requested budget check");
  const catalogPath = catalogVersion === "3" ? "/catalogs/3/locations.json" : "/locations.json";
  catalogSequence = catalogRequests.get(catalogPath) ?? Number.POSITIVE_INFINITY;
  if (catalogRequests.size !== 1) throw new Error("Unexpected catalog requests");
  const geographyPath = catalogVersion === "3" ? "/catalogs/3/covered-countries.geojson" : "/covered-countries.geojson";
  const dataAssets = await Promise.all([catalogPath, geographyPath].map(async (pathname) => {
    const body = await readFile(localPath(`${origin}${pathname}`));
    return { path: pathname, bytes: body.byteLength, brotliBytes: brotliCompressSync(body).byteLength };
  }));
  if (dataAssets[0].bytes > 150_000) throw new Error("Public catalog exceeds 150 KB budget");
  if (!Number.isFinite(catalogSequence)) throw new Error("Catalog request was not observed");
  if (!Number.isFinite(snapshotSequence)) throw new Error("Snapshot request was not observed");
  const observedDataSequences = [catalogSequence, snapshotSequence].filter(Number.isFinite);
  const firstDataSequence = Math.min(...observedDataSequences);
  const lastDataSequence = Math.max(...observedDataSequences);
  for (const pathname of ["/maplibre-gl-worker.mjs", "/maplibre-gl-shared.mjs"]) {
    if (assets.get(`${origin}${pathname}`) <= lastDataSequence) {
      throw new Error(`${pathname} loaded before the configured safety-data requests started`);
    }
  }

  await page.waitForTimeout(250);
  const mapReadySequence = sequence;
  const mapReadyFonts = [...assets].filter(([url, requestedAt]) => url.endsWith(".woff2") && requestedAt <= mapReadySequence);
  if (mapReadyFonts.length !== 0) {
    throw new Error(`Expected system UI fonts only at map readiness; observed ${mapReadyFonts.length} font assets`);
  }
  const search = page.getByRole("combobox", { name: "Where are you going?" });
  await search.fill("Klagenfurt");
  await page.getByRole("option", { name: /Klagenfurt/ }).click();
  await page.getByRole("heading", { name: "Klagenfurt am Wörthersee", exact: true }).waitFor();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ([...assets].some(([url, requestedAt]) => url.endsWith(".woff2") && requestedAt > mapReadySequence)) break;
    await page.waitForTimeout(50);
  }
  const selectedFonts = [...assets].filter(([url, requestedAt]) => url.endsWith(".woff2") && requestedAt > mapReadySequence);
  if (selectedFonts.length === 0) throw new Error("Newsreader was not deferred until an editorial destination heading became visible");
  const selectedCode = [...assets].filter(([url, requestedAt]) => /\.(?:js|mjs|css)$/.test(url) && requestedAt > mapReadySequence);
  if (selectedCode.length === 0) throw new Error("Monitoring-detail and local-conditions code was not deferred until selection");

  let mapReadyTotal = 0;
  let selectedTotal = 0;
  let initial = 0;
  let deferred = 0;
  const details = [];
  for (const [url, requestedAt] of assets) {
    const file = localPath(url);
    const bytes = brotliCompressSync(await readFile(file)).byteLength;
    selectedTotal += bytes;
    if (requestedAt <= mapReadySequence) mapReadyTotal += bytes;
    if (requestedAt < firstDataSequence) initial += bytes;
    else deferred += bytes;
    details.push({ file, bytes, phase: requestedAt < firstDataSequence ? "initial" : "deferred" });
  }
  details.sort((a, b) => b.bytes - a.bytes);
  console.log(JSON.stringify({
    catalogVersion: Number(catalogVersion),
    dataAssets,
    mapReadinessBudgetBytes: 600_000,
    selectedExperienceBudgetBytes: 650_000,
    mapReadinessBrotliBytes: mapReadyTotal,
    selectedExperienceBrotliBytes: selectedTotal,
    initialBrotliBytes: initial,
    deferredBrotliBytes: deferred,
    mapReadinessFontAssets: mapReadyFonts.map(([url]) => localPath(url)),
    selectedOnlyFontAssets: selectedFonts.map(([url]) => localPath(url)),
    selectedOnlyCodeAssets: selectedCode.map(([url]) => localPath(url)),
    snapshotRequestObserved,
    assets: details,
  }, null, 2));
  if (mapReadyTotal > 600_000) throw new Error(`Map-readiness assets exceed the 600 KB Brotli budget (${mapReadyTotal} bytes)`);
  if (selectedTotal > 650_000) throw new Error(`Selected-experience assets exceed the 650 KB Brotli budget (${selectedTotal} bytes)`);
} finally {
  await browser?.close();
  if (ownedServer) server?.kill("SIGTERM");
}
