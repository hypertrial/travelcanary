import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import { PublicationManifestV1Schema, PublicationPointerV1Schema, publicationPointerPath,
} from "./domain/publication";
import { ConcurrencyError } from "./state-store";

export const publicationSha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const immutableKey = /^catalogs\/3\/(?:objects\/sha256\/[a-f0-9]{64}\.json|generations\/[a-f0-9]{64}\/manifest\.json)$/;
const readableKey = /^catalogs\/3\/(?:objects\/sha256\/[a-f0-9]{64}\.json|generations\/[a-f0-9]{64}\/manifest\.json|publication\/latest\.json)$/;

export type PublicationRead = { body: string; etag: string; url?: string; updatedAt?: Date };
export interface PublicationStore {
  read(pathname: string, maxBytes: number): Promise<PublicationRead | null>;
  putImmutable(pathname: string, body: string): Promise<{ url?: string }>;
  replacePointer(body: string, expectedEtag: string | null): Promise<{ etag: string; url?: string }>;
  list(prefix: string, limit: number): Promise<Array<{ pathname: string; uploadedAt: Date }>>;
  deleteMany(pathnames: string[]): Promise<void>;
}

function assertReadableKey(pathname: string) {
  if (!readableKey.test(pathname)) throw new Error("Publication object key is not allowlisted");
  return pathname;
}

function assertImmutableKey(pathname: string) {
  if (!immutableKey.test(pathname)) throw new Error("Immutable publication key is not allowlisted");
  return pathname;
}

function assertSafeRoot(pathname: string, create: boolean) {
  const root = resolve(pathname);
  if (!isAbsolute(root)) throw new Error("Publication root must be absolute");
  if (create) mkdirSync(root, { recursive: true, mode: 0o750 });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Publication root must be a real directory without symlinks");
  return realpathSync(root);
}

function safePath(root: string, pathname: string) {
  assertReadableKey(pathname);
  const target = resolve(root, ...pathname.split("/"));
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) throw new Error("Publication path escaped its root");
  let current = root;
  for (const component of pathname.split("/")) {
    current = resolve(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Publication paths cannot contain symlinks");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

function ensureWriteParent(root: string, target: string) {
  const components = relative(root, dirname(target)).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    mkdirSync(current, { recursive: true, mode: 0o750 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) throw new Error("Publication directory is unsafe");
  }
}

function syncDirectory(pathname: string) {
  const fd = openSync(pathname, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class FilePublicationStore implements PublicationStore {
  readonly root: string;
  constructor(root: string, private readonly writable = false) { this.root = assertSafeRoot(root, writable); }

  async read(pathname: string, maxBytes: number): Promise<PublicationRead | null> {
    const target = safePath(this.root, pathname);
    let fd: number;
    try { fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw new Error("Invalid publication object");
      const body = readFileSync(fd, "utf8");
      return { body, etag: publicationSha256(body), updatedAt: stat.mtime };
    } finally { closeSync(fd); }
  }

  async putImmutable(pathname: string, body: string) {
    if (!this.writable) throw new Error("Publication store is read-only");
    assertImmutableKey(pathname);
    const target = safePath(this.root, pathname);
    ensureWriteParent(this.root, target);
    const existing = await this.read(pathname, Math.max(1, Buffer.byteLength(body)));
    if (existing) {
      if (existing.body !== body) throw new ConcurrencyError("Immutable publication object already exists with different content");
      return {};
    }
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o640);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const raced = await this.read(pathname, Math.max(1, Buffer.byteLength(body)));
      if (raced?.body !== body) throw new ConcurrencyError("Immutable publication race");
    } finally { try { unlinkSync(temporary); } catch {} }
    syncDirectory(dirname(target));
    return {};
  }

  async replacePointer(body: string, expectedEtag: string | null) {
    if (!this.writable) throw new Error("Publication store is read-only");
    const target = safePath(this.root, publicationPointerPath);
    ensureWriteParent(this.root, target);
    const lockPath = `${target}.lock.sqlite`;
    const lockFd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o640);
    try {
      const stat = fstatSync(lockFd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Publication pointer lock is unsafe");
    } finally { closeSync(lockFd); }
    const lockDatabase = new DatabaseSync(lockPath);
    let transaction = false;
    try {
      try { lockDatabase.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); transaction = true; }
      catch (error) {
        if (error instanceof Error && /busy|locked/i.test(error.message)) throw new ConcurrencyError("Publication pointer is being replaced");
        throw error;
      }
      const current = await this.read(publicationPointerPath, 64_000);
      if ((current?.etag ?? null) !== expectedEtag) throw new ConcurrencyError("Publication pointer changed");
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o640);
      try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, target); syncDirectory(dirname(target));
      lockDatabase.exec("COMMIT"); transaction = false;
      return { etag: publicationSha256(body) };
    } finally {
      if (transaction) try { lockDatabase.exec("ROLLBACK"); } catch {}
      lockDatabase.close();
    }
  }

  async list(prefix: string, limit: number) {
    if (!/^catalogs\/3\/(?:objects\/sha256|generations)\/?$/.test(prefix) || !Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid publication listing");
    const base = resolve(this.root, ...prefix.replace(/\/$/, "").split("/"));
    if (!existsSync(base)) return [];
    const result: Array<{ pathname: string; uploadedAt: Date }> = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (result.length >= limit || entry.isSymbolicLink()) continue;
        const child = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) result.push({ pathname: relative(this.root, child).split(sep).join("/"), uploadedAt: lstatSync(child).mtime });
      }
    };
    visit(base); return result;
  }

  async deleteMany(pathnames: string[]) {
    if (!this.writable) throw new Error("Publication store is read-only");
    for (const pathname of pathnames) {
      assertImmutableKey(pathname);
      try { unlinkSync(safePath(this.root, pathname)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
}

export class BlobPublicationStore implements PublicationStore {
  constructor(private readonly token: string) { if (!token.trim()) throw new Error("Public Blob token is required"); }
  async read(pathname: string, maxBytes: number): Promise<PublicationRead | null> {
    assertReadableKey(pathname);
    const result = await get(pathname, { token: this.token, access: "public", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    if (result.blob.size < 1 || result.blob.size > maxBytes) throw new Error("Invalid publication object size");
    const body = await new Response(result.stream).text();
    return { body, etag: result.blob.etag.replace(/^W\//, ""), url: result.blob.url, updatedAt: result.blob.uploadedAt };
  }
  async putImmutable(pathname: string, body: string) {
    assertImmutableKey(pathname);
    try {
      const result = await put(pathname, body, { token: this.token, access: "public", allowOverwrite: false,
        contentType: "application/json", cacheControlMaxAge: 31536000 });
      return { url: result.url };
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError)) throw error;
      const existing = await this.read(pathname, Math.max(1, Buffer.byteLength(body)));
      if (existing?.body !== body) throw new ConcurrencyError("Immutable publication race");
      return { url: existing.url };
    }
  }
  async replacePointer(body: string, expectedEtag: string | null) {
    try {
      const result = await put(publicationPointerPath, body, { token: this.token, access: "public",
        allowOverwrite: expectedEtag !== null, ...(expectedEtag ? { ifMatch: expectedEtag } : {}),
        contentType: "application/json", cacheControlMaxAge: 60 });
      return { etag: result.etag, url: result.url };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConcurrencyError("Publication pointer changed");
      throw error;
    }
  }
  async list(prefix: string, limit: number) {
    if (!/^catalogs\/3\/(?:objects\/sha256|generations)\/$/.test(prefix)
      || !Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid publication listing");
    const result = await list({ token: this.token, prefix, limit });
    return result.blobs.map(({ pathname, uploadedAt }) => ({ pathname, uploadedAt }));
  }
  async deleteMany(pathnames: string[]) {
    if (pathnames.length > 10_000) throw new Error("Publication deletion is too large");
    for (const pathname of pathnames) assertImmutableKey(pathname);
    if (pathnames.length) await del(pathnames, { token: this.token });
  }
}

export async function readCurrentPublication(store: PublicationStore) {
  const pointerObject = await store.read(publicationPointerPath, 64_000);
  if (!pointerObject) return null;
  const pointer = PublicationPointerV1Schema.parse(JSON.parse(pointerObject.body));
  const manifestObject = await store.read(pointer.manifestPath, 512_000);
  if (!manifestObject || publicationSha256(manifestObject.body) !== pointer.manifestSha256) throw new Error("Publication manifest digest mismatch");
  const manifest = PublicationManifestV1Schema.parse(JSON.parse(manifestObject.body));
  if (manifest.producerCommitSha !== pointer.producerCommitSha || manifest.stateRevision !== pointer.stateRevision
    || manifest.collectionRevision !== pointer.collectionRevision || manifest.ingestionFence !== pointer.ingestionFence) {
    throw new Error("Publication pointer and manifest disagree");
  }
  return { pointer, pointerEtag: pointerObject.etag, pointerUrl: pointerObject.url, manifest };
}

export async function readPublishedObject(store: PublicationStore, object: { path: string; sha256: string; bytes: number }) {
  const stored = await store.read(object.path, object.bytes);
  if (!stored || Buffer.byteLength(stored.body) !== object.bytes || publicationSha256(stored.body) !== object.sha256) {
    throw new Error("Published object digest mismatch");
  }
  return stored.body;
}
