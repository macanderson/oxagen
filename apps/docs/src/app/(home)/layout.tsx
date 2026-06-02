import type { ReactNode } from "react";

/**
 * Landing-group layout. Wraps the home marketing page without leaking
 * any background styling onto the fumadocs /docs routes.
 */
export default function HomeLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
