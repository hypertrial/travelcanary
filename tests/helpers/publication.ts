import { runConditions as runConditionsCore } from "@/lib/conditions/worker";
import type { Conditions } from "@/lib/domain/conditions";
import { acquireIngestionLease, releaseIngestionLease } from "@/lib/ingestion-lease";
import { publicationSha256, readCurrentPublication, readPublishedObject, type PublicationStore } from "@/lib/publication-store";
import { randomUUID } from "node:crypto";

export class MemoryPublicationStore implements PublicationStore {
  private objects = new Map<string, { body: string; etag: string; uploadedAt: Date }>();

  async read(pathname: string, maxBytes: number) {
    const value = this.objects.get(pathname);
    if (!value) return null;
    if (Buffer.byteLength(value.body) > maxBytes) throw new Error("Invalid publication object size");
    return { body: value.body, etag: value.etag, updatedAt: value.uploadedAt };
  }

  async putImmutable(pathname: string, body: string) {
    const existing = this.objects.get(pathname);
    if (existing && existing.body !== body) throw new Error("Immutable object conflict");
    if (!existing) this.objects.set(pathname, { body, etag: publicationSha256(body), uploadedAt: new Date() });
    return {};
  }

  async replacePointer(body: string, expectedEtag: string | null) {
    const pathname = "catalogs/3/publication/latest.json";
    const current = this.objects.get(pathname);
    if ((current?.etag ?? null) !== expectedEtag) throw new Error("Pointer conflict");
    const etag = publicationSha256(body);
    this.objects.set(pathname, { body, etag, uploadedAt: new Date() });
    return { etag, url: `memory://publication/${pathname}` };
  }

  async list(prefix: string, limit: number) {
    return [...this.objects.entries()].filter(([pathname]) => pathname.startsWith(prefix)).slice(0, limit)
      .map(([pathname, value]) => ({ pathname, uploadedAt: value.uploadedAt }));
  }

  async deleteMany(pathnames: string[]) { for (const pathname of pathnames) this.objects.delete(pathname); }

  remove(pathname: string) { this.objects.delete(pathname); }
  replaceForTest(pathname: string, body: string) {
    this.objects.set(pathname, { body, etag: publicationSha256(body), uploadedAt: new Date() });
  }
}

type RunOptions = Omit<Parameters<typeof runConditionsCore>[0], "catalogPublication" | "lease"> & {
  publish?: (files: Conditions[]) => Promise<unknown>;
};

export async function runTestConditions(options: RunOptions) {
  const publicationStore = new MemoryPublicationStore();
  const owner = `test-conditions-owner:${randomUUID()}`;
  const lease = await acquireIngestionLease(options.stateStore, owner, options.now || new Date(), 330_000);
  if (!lease) return { status: "skipped" as const, code: "ingestion_lease_held" };
  try {
    const { publish, ...workerOptions } = options;
    const result = await runConditionsCore({ ...workerOptions, catalogPublication: { publicationStore }, lease });
    if (publish) {
      const current = await readCurrentPublication(publicationStore);
      if (!current) return result;
      const files = await Promise.all(current.manifest.conditions.map(async (item) =>
        JSON.parse(await readPublishedObject(publicationStore, item)) as Conditions));
      await publish(files);
    }
    return result;
  } finally {
    await releaseIngestionLease(options.stateStore, lease);
  }
}
