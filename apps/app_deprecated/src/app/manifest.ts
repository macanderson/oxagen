import { HOUSE_INK } from "@oxagen/ui/lib/house-grounds";
import type { MetadataRoute } from "next";

/**
 * Next-native web app manifest route — served at /manifest.webmanifest and
 * auto-linked into <head> by Next's metadata file-convention system, so
 * layout.tsx needs no `metadata.manifest` string.
 *
 * Every icon below is a file the brand sync copies into public/pwa/ from the
 * kit, which ships 192 and 512 and the maskable pair. The grounds come from
 * the kit through @oxagen/ui/lib/house-grounds (#4892).
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
    background_color: HOUSE_INK,
    theme_color: HOUSE_INK,
    categories: ["productivity", "developer", "business"],
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
    // TODO(next PR): add `shortcuts` for "Ask" (/[org]/[ws]/ask) and
    // "Activity" once a per-shortcut icon is designed; add `screenshots`
    // (wide + narrow form factor) once product has a canonical set of
    // dashboard screenshots to ship.
  };
}
