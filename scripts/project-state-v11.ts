import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import { IngestionStateSchema, downgradeIngestionStateV12 } from "../src/lib/domain/schemas";

if (process.env.INGESTION_WRITERS_STOPPED !== "true") throw new Error("Stop all alert and conditions writers first; acknowledge with INGESTION_WRITERS_STOPPED=true");
const token = process.env.PRIVATE_INGESTION_BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error("Private state token required");
const current = await get("ingestion-state.json", { token, access: "private", useCache: false });
if (!current?.stream || current.statusCode !== 200) throw new Error("Latest state unavailable");
const raw = await new Response(current.stream).text();
if (Buffer.byteLength(raw) > 5_000_000) throw new Error("Oversized state");
const state = IngestionStateSchema.parse(JSON.parse(raw));
if (state.conditions.lease && Date.parse(state.conditions.lease.expiresAt) > Date.now()) throw new Error("Conditions lease still active; wait for writer shutdown");
const projected = downgradeIngestionStateV12(state);
const digest = createHash("sha256").update(raw).digest("hex");
const backup = `ingestion-state-v12-before-rollback-${digest}.json`;
if (process.argv.includes("--apply")) {
  try { await put(backup, raw, { token, access: "private", allowOverwrite: false, contentType: "application/json" }); }
  catch { /* A retried projection may already have its content-addressed backup; verify it below. */ }
  const saved = await get(backup, { token, access: "private", useCache: false });
  if (!saved?.stream || createHash("sha256").update(await new Response(saved.stream).text()).digest("hex") !== digest) throw new Error("Rollback backup verification failed");
  await put("ingestion-state.json", JSON.stringify(projected), { token, access: "private", allowOverwrite: true, ifMatch: current.blob.etag.replace(/^W\//, ""), contentType: "application/json" });
}
console.log(JSON.stringify({ applied: process.argv.includes("--apply"), backup, from: 12, to: 11, preservedEvents: projected.events.length, preservedCandidates: projected.candidates.length, bytes: Buffer.byteLength(JSON.stringify(projected)) }));
