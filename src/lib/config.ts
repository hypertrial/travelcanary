export type DataMode = "demo" | "live" | "unavailable";

export function getPublicDataConfig(environment: Record<string, string | undefined> = process.env): { mode: DataMode; snapshotUrl: string | null; catalogVersion: 3 } {
  const local = environment.TRAVELCANARY_RUNTIME === "local";
  if (local) return { mode: "live", snapshotUrl: "/api/v1/data", catalogVersion: 3 };
  // Preview and Development are always demo-only, even if production-looking
  // values are accidentally injected into those environments.
  if (environment.VERCEL_ENV !== "production") return { mode: "demo", snapshotUrl: "/api/v1/data", catalogVersion: 3 };
  return environment.TRAVELCANARY_PUBLICATION_URL?.trim()
    ? { mode: "live", snapshotUrl: "/api/v1/data", catalogVersion: 3 }
    : { mode: "unavailable", snapshotUrl: null, catalogVersion: 3 };
}
