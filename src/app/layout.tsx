import type { Metadata, Viewport } from "next";
import { Newsreader } from "next/font/google";
import { getPublicDataConfig } from "@/lib/config";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const newsreader = Newsreader({
  weight: "600",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
  variable: "--font-newsreader",
});

const publicData = getPublicDataConfig();
const releaseSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim().toLowerCase();

export const metadata: Metadata = {
  metadataBase: new URL("https://travelcanary.org"),
  applicationName: "TravelCanary",
  title: "TravelCanary — Europe location risk",
  description: "Source-backed destination hazards across Europe, with clear monitoring gaps and update times.",
  alternates: { canonical: "/" },
  appleWebApp: {
    capable: true,
    title: "TravelCanary",
    statusBarStyle: "default",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "TravelCanary",
    title: "TravelCanary — Europe location risk",
    description: "Source-backed destination hazards across Europe, with clear monitoring gaps and update times.",
  },
  other: {
    "travelcanary-data-mode": publicData.mode,
    "travelcanary-catalog-version": String(publicData.catalogVersion),
    "travelcanary-local-conditions": process.env.LOCAL_CONDITIONS_ENABLED === "true" ? "enabled" : "disabled",
    "travelcanary-noncommercial": process.env.NONCOMMERCIAL_DATA_ENABLED === "true" ? "enabled" : "disabled",
    ...(publicData.snapshotUrl ? { "travelcanary-snapshot": publicData.snapshotUrl } : {}),
    ...(releaseSha && /^[a-f0-9]{40}$/.test(releaseSha) ? { "travelcanary-release": releaseSha } : {}),
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#012f62",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={newsreader.variable}><body>{children}</body></html>;
}
