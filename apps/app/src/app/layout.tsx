import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  // Each page returns its own pages.* title; the template names the product after it.
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("description"),
    icons: {
      icon: [
        { url: "/favicon/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon/favicon.ico", sizes: "any" },
        { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/favicon/favicon-16.png", sizes: "16x16", type: "image/png" },
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
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang={await getLocale()} dir="ltr" suppressHydrationWarning>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
