import type { ReactNode } from "react";

/**
 * Landing-group layout. Wraps the temporary marketing page (copied from
 * apps/website) in the dark hero surface so it renders identically without
 * leaking that background onto the fumadocs `/docs` routes.
 */
export default function HomeLayout({ children }: { children: ReactNode }) {
  return <div className="home-hero">{children}</div>;
}
