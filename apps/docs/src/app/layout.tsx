import "./global.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";

export const metadata: Metadata = {
  title: "Oxagen Docs",
  description: "Documentation for the Oxagen agent platform.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/icon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/icons/icon-180x180.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    title: "Oxagen Docs",
    description: "Documentation for the Oxagen agent platform.",
    images: [{ url: "/og/og-default.png", width: 1200, height: 630, alt: "Oxagen Docs" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Oxagen Docs",
    description: "Documentation for the Oxagen agent platform.",
    images: ["/og/og-default.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
