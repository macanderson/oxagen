/**
 * Root layout — font strategy
 *
 * Aeonik is a licensed typeface (CoType Foundry). The .woff2 binaries are NOT
 * in this repository. @font-face declarations live in:
 *   packages/ui/src/styles/fonts/aeonik.css
 * and are loaded transitively via @oxagen/ui/styles/globals.css → globals.css.
 *
 * While binaries are absent, the @font-face rules are inert and the system-font
 * fallback stacks (defined as CSS variables in packages/ui/src/styles/globals.css)
 * keep the app fully functional.
 *
 * TODO (OXA-1508 — activate after binaries arrive):
 *   Replace the CSS-variable approach below with next/font/local declarations
 *   (see packages/ui/src/styles/fonts/aeonik.css for the exact migration code).
 *   next/font/local will error at build time if referenced .woff2 paths are
 *   missing, which is why we intentionally defer it until assets are in place.
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
