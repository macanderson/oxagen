/**
 * Root layout — font strategy
 *
 * Aeonik (CoType Foundry, licensed) is ACTIVE. Self-hosted variable woff2 live
 * in packages/ui/src/styles/fonts/ and the @font-face declarations in
 *   packages/ui/src/styles/fonts/aeonik.css
 * are wired into every app through @oxagen/ui/styles/globals.css → globals.css.
 * The shared globals binds the three families to --font-sans / --font-display /
 * --font-mono on :root, so the `font-sans` utility on <body> below and the base
 * heading rules render in Aeonik with no per-app font config. Each stack keeps
 * a system fallback if a woff2 fails to load.
 *
 * Optional (OXA-1508): migrate to next/font/local for automatic preload +
 * size-adjust fallback metrics. Not required — the variable fonts are already
 * self-hosted and active via the shared CSS.
 */
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { ThemeProvider, THEME_COOKIE_NAME, parseTheme, themeClass, MotionProvider } from "@oxagen/ui";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Oxagen",
  description: "The Oxagen agent platform",
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
    title: "Oxagen",
    description: "The Oxagen agent platform",
    images: [{ url: "/og/og-default.png", width: 1200, height: 630, alt: "Oxagen" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Oxagen",
    description: "The Oxagen agent platform",
    images: ["/og/og-default.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#4926a6",
};

/** Valid font-size cookie values; default 'medium' when absent/invalid. */
function parseFontSize(raw: string | undefined): "small" | "medium" | "large" {
  if (raw === "small" || raw === "medium" || raw === "large") return raw;
  return "medium";
}

/** Valid density cookie values; default 'comfortable' when absent/invalid. */
function parseDensity(raw: string | undefined): "compact" | "comfortable" | "spacious" {
  if (raw === "compact" || raw === "comfortable" || raw === "spacious") return raw;
  return "comfortable";
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // No-flash theming with no inline <script>: read the preference cookie on the
  // server and render the resolved class straight onto <html>. "system" renders
  // no class and is resolved by CSS @media (prefers-color-scheme) — see
  // @oxagen/ui ThemeProvider / styles/tokens.css. Keep suppressHydrationWarning:
  // for "system" the provider adds the OS-resolved class after hydration.
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE_NAME)?.value);
  // Appearance: font-size and density are read from their own cookies and
  // applied as data-* attributes on <html> so CSS can respond flash-free,
  // matching the no-inline-script theming pattern.
  const fontSize = parseFontSize(cookieStore.get("pref-font-size")?.value);
  const density = parseDensity(cookieStore.get("pref-density")?.value);

  return (
    <html
      lang="en"
      className={themeClass(theme)}
      data-font-size={fontSize}
      data-density={density}
      suppressHydrationWarning
    >
      {/*
       * Font variables (--font-sans / --font-display / --font-mono) are set as
       * CSS custom properties on :root by @oxagen/ui/styles/globals.css and flow
       * through via the Tailwind @theme tokens. font-sans applies the family.
       */}
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider initialTheme={theme}>
          {/*
           * MotionProvider sets framer-motion's reducedMotion="user" so every
           * motion.* element across the app honours the OS reduce-motion setting
           * (framer-motion does NOT do this by default), matching the global CSS
           * prefers-reduced-motion kill-switch in @oxagen/ui globals.
           */}
          <MotionProvider>
            <ToastProvider>
              {children}
              <ToastViewport />
            </ToastProvider>
          </MotionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
