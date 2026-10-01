import { HOUSE_INK } from "@oxagen/ui/lib/house-grounds";
import type { MetadataRoute } from "next";

/**
 * Next-native web app manifest route — served at /manifest.webmanifest and
 * auto-linked into <head> by Next's metadata file-convention system (no
 * `metadata.manifest` string needed in layout.tsx once this file exists).
 *
 * The grounds come from the brand kit through the generated
 * @oxagen/ui/lib/house-grounds, so a kit colour change reaches the installed
 * app with the next sync (#4892).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Oxagen docs",
    short_name: "Oxagen docs",
    description:
      "Documentation for Oxagen, workforce management for the agents an enterprise runs, autonomous and supervised alike. It governs them and does not run them.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: HOUSE_INK,
    theme_color: HOUSE_INK,
    categories: ["developer", "productivity", "education"],
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
