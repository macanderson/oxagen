"use client";
/**
 * Shared ThemeProvider for all Oxagen Next.js apps.
 *
 * Wraps `next-themes` with Oxagen defaults: class-based attribute, dark as the
 * default theme, and system preference detection enabled.
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
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
