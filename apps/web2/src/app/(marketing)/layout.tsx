import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";

/**
 * Chrome for the marketing + product routes (`/`, `/product/*`).
 *
 * These pages are migrated near-verbatim from apps/web's static HTML (see
 * src/content/marketing/README.md): same markup, same
 * `public/assets/oxagen.css` stylesheet, same `public/assets/oxagen.js`
 * vanilla-JS behaviour (nav state, the products dropdown, the mobile
 * drawer, reveal-on-scroll, typewriters, copy buttons, lead forms). That
 * script expects to run once against the whole page rather than be
 * React-owned, so it loads here — scoped to this route group only, never on
 * `/docs/*` — via `next/script` with `afterInteractive`, matching the
 * original `<script defer>`.
 */
export const viewport: Viewport = {
  themeColor: "#0A0A0C",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://oxagen.sh"),
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
};

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-css-tags -- oxagen.css is the
          untouched public/ stylesheet from apps/web (plain CSS, no build
          step there); routing it through a bundled import would move it out
          of public/ and change how it's served for no benefit here. */}
      <link rel="stylesheet" href="/assets/oxagen.css" />
      <link
        rel="preload"
        href="/fonts/Aeonik-VF.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
      <link
        rel="preload"
        href="/fonts/AeonikMono-VF.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
      {children}
      <Script src="/assets/oxagen.js" strategy="afterInteractive" />
    </>
  );
}
