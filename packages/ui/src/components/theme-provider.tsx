"use client";
/**
 * Shared ThemeProvider for all Oxagen Next.js apps.
 *
 * Wraps `next-themes` with class-based theming and system-preference detection.
 *
 * Usage (app layout.tsx):
 *   import { ThemeProvider } from "@oxagen/ui";
 *
 * Peer dep: next-themes must be installed in the consuming app.
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
