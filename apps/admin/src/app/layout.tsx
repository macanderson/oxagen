import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeProvider } from "@oxagen/ui";
import { ThemeScript } from "@oxagen/ui/components/theme-script";

export const metadata: Metadata = {
  title: "Oxagen Admin",
  description: "The agent platform for teams that ship.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/*
       * ThemeScript lives in <head> so React 19's client reconciler never hits
       * the createInstance path for the inline <script>. The IIFE still runs
       * before first paint from the server HTML. See apps/app/src/app/layout.tsx.
       */}
      <head>
        <ThemeScript />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
