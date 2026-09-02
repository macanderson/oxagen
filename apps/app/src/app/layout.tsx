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
 * Optional: migrate to next/font/local for automatic preload +
 * size-adjust fallback metrics. Not required — the variable fonts are already
 * self-hosted and active via the shared CSS.
 */
import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider, MotionProvider } from "@oxagen/ui";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppearanceBootstrap } from "@/components/appearance-bootstrap";
import { PwaSplash } from "@/components/pwa/pwa-splash";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { RouteTransitionLoader } from "@/components/pwa/route-transition-loader";
import { SwRegister } from "@/components/pwa/sw-register";

export const metadata: Metadata = {
  title: "Oxagen",
  description: "Enterprise agent ontologies as a service",
  // No explicit `manifest` string here — apps/app/src/app/manifest.ts (Next's
  // native metadata-route convention) is auto-detected and linked at
  // /manifest.webmanifest.
  icons: {
    icon: [
      { url: "/favicon/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon/favicon.ico", sizes: "any" },
      { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/pwa/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  // iOS standalone mode: `capable` tells iOS Safari to allow full-screen launch;
  // `black-translucent` extends content under the status bar (edge-to-edge on
  // devices with a notch when combined with the `viewportFit: "cover"` viewport).
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Oxagen",
  },
  openGraph: {
    title: "Oxagen",
    description: "The Oxagen agent platform",
    images: [
      {
        url: "/social/og-image-dark-1200x630.png",
        width: 1200,
        height: 630,
        alt: "Oxagen — governed context infrastructure for enterprise agents",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Oxagen",
    description: "The Oxagen agent platform",
    images: ["/social/og-image-dark-1200x630.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Disable pinch-zoom so the standalone app feels native. WCAG 2.1 SC 1.4.4
  // technically requires reflow to work at 320 CSS px, but disabling user
  // scaling is acceptable for an installed PWA shell. Revisit if WCAG AA
  // compliance is a hard requirement.
  maximumScale: 1,
  userScalable: false,
  // `cover` extends the viewport into the safe-area / notch, enabling true
  // edge-to-edge rendering. Pair with CSS `env(safe-area-inset-*)` in layouts
  // that need to respect device insets.
  viewportFit: "cover",
  // Match the browser/OS chrome to the active theme: warm charcoal on dark,
  // ivory paper on light. (Manifest theme_color is a single value for the
  // standalone PWA toolbar — kept on the charcoal.)
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0A0A0C" },
    { media: "(prefers-color-scheme: light)", color: "#F7F4ED" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Cache Components: the root layout is part of the prerendered static shell,
  // so it must not read runtime data (cookies/headers) — per-request <html>
  // attributes are incompatible with a build-time shell. The shell renders
  // neutral defaults ("system" theme = no class, resolved by CSS
  // @media (prefers-color-scheme); medium/comfortable appearance) and
  // <AppearanceBootstrap/> — an inline script INSIDE the shell — applies the
  // user's cookie preferences to <html> before first paint. No flash.
  // Keep suppressHydrationWarning: the bootstrap script (and, post-mount, the
  // ThemeProvider) legitimately mutates the class/data-* attributes away from
  // the prerendered values.
  return (
    <html
      lang="en"
      data-font-size="medium"
      data-density="comfortable"
      suppressHydrationWarning
    >
      {/*
       * Font variables (--font-sans / --font-display / --font-mono) are set as
       * CSS custom properties on :root by @oxagen/ui/styles/globals.css and flow
       * through via the Tailwind @theme tokens. font-sans applies the family.
       */}
      <body className="min-h-dvh font-sans antialiased">
        {/*
         * Pre-paint appearance sync: applies theme/font-size/density cookies
         * to <html> before anything paints. Must stay the first child of
         * <body> so the parser executes it ahead of visible content.
         */}
        <AppearanceBootstrap />
        {/*
         * PWA splash: renders instantly in standalone mode before any JS runs.
         * Gate is pure CSS (display-mode: standalone / minimal-ui) so browser
         * users incur zero layout cost. JS dismisses it after hydration.
         */}
        <PwaSplash />
        {/*
         * No initialTheme: the provider adopts the theme cookie in a mount
         * effect (its documented no-initialTheme mode), converging with what
         * AppearanceBootstrap already applied pre-paint.
         */}
        <ThemeProvider>
          {/*
           * MotionProvider sets framer-motion's reducedMotion="user" so every
           * motion.* element across the app honours the OS reduce-motion setting
           * (framer-motion does NOT do this by default), matching the global CSS
           * prefers-reduced-motion kill-switch in @oxagen/ui globals.
           */}
          <MotionProvider>
            <TooltipProvider>
              <ToastProvider>
                {children}
                <ToastViewport />
              </ToastProvider>
            </TooltipProvider>
            {/*
             * Route-transition loader: spinner during navigation, mobile-only
             * (gated at max-width:768px). Respects prefers-reduced-motion.
             * Suspense: usePathname() is uncached request data under
             * cacheComponents — without a boundary it blocks every page's
             * prerender ("Uncached data was accessed outside of <Suspense>").
             */}
            <Suspense fallback={null}>
              <RouteTransitionLoader />
            </Suspense>
            {/*
             * Install prompt: deferred install CTA for Chrome/Android; manual
             * instructions for iOS. Never shown when already installed or
             * dismissed. Suspense: reads usePathname() (route suppression),
             * which is uncached request data under cacheComponents — same
             * boundary requirement as RouteTransitionLoader above.
             */}
            <Suspense fallback={null}>
              <InstallPrompt />
            </Suspense>
            {/*
             * Service worker: app-shell/static-asset caching only (never
             * offline mode — see sw.js). Production only; renders nothing.
             */}
            <SwRegister />
          </MotionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
