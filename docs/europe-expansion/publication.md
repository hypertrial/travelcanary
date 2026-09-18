# Catalog 3 publication

Catalog 3 is the only active catalog. TravelCanary publishes one atomic generation containing the 679-destination Snapshot V11 and exactly 45 Conditions V3 country objects. Catalog 2, dual publication, build-time catalog selection, and activation commands are retired.

The collector reads one committed V16 private-state revision, serializes content-addressed objects, writes an immutable manifest, revalidates the lease, fence, state revision, and collection revision, then compare-and-swaps `catalogs/3/publication/latest.json`. Readers never discover a partial generation. Filesystem publication uses durable temporary writes and atomic linking; Vercel Blob uses immutable objects and ETag preconditions.

Every conditions run republishes all 45 country objects. A failed provider preserves the original evidence timestamps and records its limitation; publication never makes retained evidence look newly observed. Maintenance retains the current generation, the newest valid rollback generation, and generations younger than 48 hours.

See [Architecture](../ARCHITECTURE.md) for the pointer and manifest contracts and [Operations](../OPERATIONS.md) for deployment, verification, recovery, and rollback.
