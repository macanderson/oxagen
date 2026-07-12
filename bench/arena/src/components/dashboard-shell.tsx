/**
 * Dashboard Shell Component
 *
 * Main layout wrapper for the Arena dashboard — sticky glass header, ember
 * brand lockup, and a footer, all on the graphite + ember design system.
 */

import Link from "next/link";

import { OxagenLogomark } from "./oxagen-logomark";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/configure", label: "Configure" },
  { href: "/compare", label: "Compare" },
  { href: "/tracker", label: "Progress" },
] as const;

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/" className="group flex items-center gap-2.5">
                <OxagenLogomark className="size-8 shrink-0 text-foreground transition-opacity group-hover:opacity-80" />
                <span className="flex items-baseline gap-1.5 text-lg font-bold tracking-tight">
                  oxagen
                  <span className="text-[var(--_ember-flame)]">Arena</span>
                </span>
              </Link>
              <nav className="hidden items-center gap-1 text-sm md:flex">
                {NAV_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="rounded-md px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/oxageninc/oxagen-platform"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-[var(--_ember-flame)]/50 hover:text-foreground"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 .5A11.5 11.5 0 0 0 .5 12.3c0 5.22 3.3 9.65 7.86 11.21.58.11.79-.26.79-.57v-2c-3.2.71-3.87-1.58-3.87-1.58-.53-1.37-1.28-1.74-1.28-1.74-1.05-.74.08-.72.08-.72 1.16.08 1.77 1.22 1.77 1.22 1.03 1.81 2.7 1.29 3.36.98.1-.77.4-1.29.73-1.58-2.55-.3-5.23-1.31-5.23-5.83 0-1.29.45-2.34 1.19-3.17-.12-.3-.52-1.51.11-3.14 0 0 .97-.32 3.17 1.21a10.7 10.7 0 0 1 5.78 0c2.2-1.53 3.17-1.21 3.17-1.21.63 1.63.23 2.84.11 3.14.74.83 1.19 1.88 1.19 3.17 0 4.53-2.69 5.52-5.25 5.81.41.37.78 1.08.78 2.18v3.23c0 .31.2.69.8.57A11.8 11.8 0 0 0 23.5 12.3 11.5 11.5 0 0 0 12 .5Z" />
                </svg>
                GitHub
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-10">{children}</main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="container mx-auto px-4 py-6 text-center text-sm text-muted-foreground">
          <p>
            Arena Benchmark Framework — scientific honesty, provenance tracking,
            fair comparison.
          </p>
        </div>
      </footer>
    </div>
  );
}
