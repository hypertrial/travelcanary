import { catalogV2Paths, catalogV2SnapshotUrl, catalogV3LocalSnapshotPath, catalogV3Paths, catalogV3SnapshotUrl } from "./catalog-paths";

export type DataMode = "demo" | "live" | "unavailable";

export function getPublicDataConfig(environment: Record<string, string | undefined> = process.env): { mode: DataMode; snapshotUrl: string | null; catalogVersion: 2 | 3 } {
  const requestedVersion = environment.NEXT_PUBLIC_CATALOG_VERSION;
  const local = environment.TRAVELCANARY_RUNTIME === "local";
  const catalogVersion = requestedVersion === "3" || (local && requestedVersion === undefined) ? 3 : 2;
  if (requestedVersion && !["2", "3"].includes(requestedVersion)) return { mode: "unavailable", snapshotUrl: null, catalogVersion };
  if (local) return catalogVersion === 3
    ? { mode: "live", snapshotUrl: catalogV3LocalSnapshotPath, catalogVersion }
    : { mode: "unavailable", snapshotUrl: null, catalogVersion };
  const paths = catalogVersion === 3 ? catalogV3Paths : catalogV2Paths;
  const parseUrl = catalogVersion === 3 ? catalogV3SnapshotUrl : catalogV2SnapshotUrl;
  const requested = environment.NEXT_PUBLIC_DATA_MODE;
  const isProduction = environment.VERCEL_ENV === "production";
  const snapshotUrl = parseUrl(environment.NEXT_PUBLIC_SNAPSHOT_URL)?.toString() ?? null;

  if (requested === "live" && snapshotUrl) return { mode: "live", snapshotUrl, catalogVersion };
  if (!isProduction && requested !== "live") return { mode: "demo", snapshotUrl: paths.demoSnapshot, catalogVersion };
  return { mode: "unavailable", snapshotUrl: null, catalogVersion };
}
