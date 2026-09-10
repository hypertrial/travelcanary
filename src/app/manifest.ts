import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "TravelCanary — Europe location risk",
    short_name: "TravelCanary",
    description: "Current, source-backed hazards for destinations across Europe.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f1eee4",
    theme_color: "#012f62",
    categories: ["travel", "utilities"],
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
