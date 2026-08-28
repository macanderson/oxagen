import "./global.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import { InstallCliButton } from "@/components/install/install-cli-button";
import { SwRegister } from "@/components/pwa/sw-register";

export const metadata: Metadata = {
  title: "Oxagen Docs",
  description: "Documentation for the Oxagen agent platform.",
  // No explicit `manifest` string here — apps/docs/src/app/manifest.ts
  // (Next's native metadata-route convention) is auto-detected and linked at
  // /manifest.webmanifest. The old static apps/docs/public/pwa/manifest.json
  // stays on disk, unreferenced, for backward compatibility only.
  icons: {
    icon: [
      { url: "/favicon/favicon.ico", sizes: "any" },
      { url: "/favicon/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/pwa/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  // iOS standalone mode: `capable` allows full-screen launch from the home
  // screen. `default` (not `black-translucent` like apps/app) keeps the
  // status bar opaque — this is a reading surface, so text near the top of
  // the viewport must not run under the status bar.
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Oxagen Docs",
  },
  openGraph: {
    title: "Oxagen Docs",
    description: "Documentation for the Oxagen agent platform.",
    images: [
      {
        url: "/social/og-image-dark-1200x630.png",
        width: 1200,
        height: 630,
        alt: "Oxagen Docs",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Oxagen Docs",
    description: "Documentation for the Oxagen agent platform.",
    images: ["/social/og-image-dark-1200x630.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0A0A0C" },
    { media: "(prefers-color-scheme: light)", color: "#F7F4ED" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
        <InstallCliButton />
        <SwRegister />
      </body>
    </html>
  );
}
