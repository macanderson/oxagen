import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeProvider } from "@oxagen/ui";

export const metadata: Metadata = {
  title: "Oxagen",
  description: "The agent platform for teams that ship.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // No theme toggle on the marketing site, so the preference is always "system":
  // CSS @media (prefers-color-scheme) themes it with no flash and no inline
  // <script>, keeping this layout statically renderable (no cookie read). If a
  // toggle is ever added here, switch to the cookie-read pattern in
  // apps/app/src/app/layout.tsx. suppressHydrationWarning: the provider adds the
  // OS-resolved class on the client after hydration.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
