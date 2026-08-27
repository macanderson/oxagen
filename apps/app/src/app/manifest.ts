import type { MetadataRoute } from "next";

/**
 * Next-native web app manifest route — served at /manifest.webmanifest and
 * auto-linked into <head> by Next's metadata file-convention system (no
 * `metadata.manifest` string needed in layout.tsx once this file exists).
 *
 * Mirrors the icon set formerly hand-maintained in the static
 * apps/app/public/pwa/manifest.json (left on disk, unreferenced, purely for
 * backward compatibility with anything that bookmarked that URL directly).
 * Reuses every existing public/pwa/* icon — no new image assets needed.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Oxagen",
    short_name: "Oxagen",
    description: "Governed context infrastructure for enterprise agents.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#0A0A0C",
    theme_color: "#0A0A0C",
    categories: ["productivity", "developer", "business"],
    icons: [
      {
        src: "/pwa/icon-72.png",
        sizes: "72x72",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-96.png",
        sizes: "96x96",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-128.png",
        sizes: "128x128",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-144.png",
        sizes: "144x144",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-152.png",
        sizes: "152x152",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-256.png",
        sizes: "256x256",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa/icon-384.png",
        sizes: "384x384",
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
