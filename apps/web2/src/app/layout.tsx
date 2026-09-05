import type { ReactNode } from "react";

/**
 * Root layout. Deliberately thin: it exists to open the `<html>`/`<body>`
 * tags once and nothing else. Marketing/product routes and the `/docs`
 * subtree each bring their own CSS and metadata in their own nested layout,
 * scoped by Next's per-layout CSS bundling — so a docs page never loads the
 * marketing stylesheet and vice versa.
 *
 * `suppressHydrationWarning` on `<html>` is for the docs subtree's
 * `next-themes` provider, which sets a class/attribute on this same element
 * after hydration; it is a no-op for routes that never mount that provider.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
