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
import "./globals.css";
import { ThemeProvider } from "@oxagen/ui";
import { ThemeScript } from "@oxagen/ui/components/theme-script";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Oxagen",
  description: "The Oxagen agent platform",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/*
       * ThemeScript is placed in <head> so React 19's client reconciler never
       * tries to create the <script> DOM node on the client — elements explicitly
       * rendered inside <head> are handled by the browser's head-management path,
       * not the standard HostComponent createInstance path that fires the
       * "Encountered a script tag while rendering React component" warning.
       * The inline IIFE still executes on initial server HTML before first paint,
       * preserving the no-flash guarantee.
       *
       * Font variables (--font-sans / --font-display / --font-mono) are set as
       * CSS custom properties on :root by @oxagen/ui/styles/globals.css and flow
       * through via the Tailwind @theme tokens. No className injection needed here.
       * Add font-sans so Tailwind's utility class applies the correct font-family.
       */}
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <ToastProvider>
            {children}
            <ToastViewport />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
