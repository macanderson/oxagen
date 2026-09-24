import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { getMetadataBase } from "@/shared/app-url";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  // Each page returns its own pages.* title; the template names the product after it.
  return {
    // Every relative URL below resolves against this. Without it Next falls
    // back to http://localhost:3000, which is the origin production advertised
    // in its og:image until #3076 — and again after the rebuild (#3091).
    metadataBase: getMetadataBase(),
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("description"),
    openGraph: {
      type: "website",
      siteName: t("name"),
      title: t("name"),
      description: t("description"),
      url: "/",
      images: [
        {
          url: "/social/og-image-dark-1200x630.png",
          width: 1200,
          height: 630,
          alt: t("name"),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: t("name"),
      description: t("description"),
      images: ["/social/og-image-dark-1200x630.png"],
    },
    icons: {
      icon: [
        { url: "/favicon/favicon.svg", type: "image/svg+xml", sizes: "any" },
        { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/favicon/favicon-16.png", sizes: "16x16", type: "image/png" },
        { url: "/favicon/favicon.ico", sizes: "16x16 32x32 48x48" },
      ],
      apple: [
        {
          url: "/pwa/apple-touch-icon.png",
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the notch and the home indicator so the shell's
  // env(safe-area-inset-*) paddings (topbar, nav drawer, thumb bar, sheets)
  // take effect; without it every inset resolves to 0.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090B" },
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang={await getLocale()} dir="ltr" suppressHydrationWarning>
      <body className="min-h-dvh bg-app-canvas font-sans text-foreground antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
