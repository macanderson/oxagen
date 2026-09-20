import type { MetadataRoute } from "next";

/**
 * Next-native web app manifest route — served at /manifest.webmanifest and
 * auto-linked into <head> by Next's metadata file-convention system (no
 * `metadata.manifest` string needed in layout.tsx once this file exists).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Oxagen",
    short_name: "Oxagen",
    description: "Your agents are a workforce now. Manage them like one.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#09090B",
    theme_color: "#09090B",
    categories: ["developer", "productivity", "business"],
    icons: [
      {
        src: "/pwa/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/pwa/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
