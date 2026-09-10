import { TravelCanaryApp } from "@/components/TravelCanaryApp";
import { getPublicDataConfig } from "@/lib/config";

export const dynamic = "force-static";

export default function Home() {
  const config = getPublicDataConfig();
  return <TravelCanaryApp catalogVersion={config.catalogVersion} mode={config.mode} snapshotUrl={config.snapshotUrl} conditionsEnabled={config.mode === "demo" || process.env.LOCAL_CONDITIONS_ENABLED === "true"} />;
}
