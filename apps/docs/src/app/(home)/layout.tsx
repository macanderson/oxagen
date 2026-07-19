import type { ReactNode } from "react";
import Link from "next/link";
import { OxagenLockup, OxagenLogomark } from "@oxagen/ui";

/**
 * Landing-group layout. Wraps the home marketing page with a lightweight,
 * brand-styled header and footer. The Fumadocs /docs routes have their own
 * DocsLayout chrome, so this header is scoped to the (home) group only and
 * never leaks onto the documentation pages.
 */

const APP_URL = "https://app.oxagen.sh";

/**
 * The copyright year is isolated behind a `use cache` boundary. Cache Components
 * forbid reading the current time in a Server Component during prerender (the
 * output would freeze at build time); inside a cache scope the value is allowed
 * and evaluated once at build/revalidate — exactly right for a copyright year.
 */
async function CopyrightYear() {
  "use cache";
  return <>{new Date().getFullYear()}</>;
}

const NAV = [
  { label: "Docs", href: "/docs" },
  { label: "Install", href: "/install" },
  { label: "CLI", href: "/docs/cli" },
  { label: "API", href: "/docs/api/overview" },
  { label: "MCP", href: "/docs/mcp/overview" },
  { label: "Security", href: "/docs/security/overview" },
];

const FOOTER = [
  {
    heading: "Product",
    links: [
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Agent platform", href: "/docs/agent/overview" },
      { label: "Plugins", href: "/docs/plugins/overview" },
      { label: "Governance", href: "/docs/governance/overview" },
    ],
  },
  {
    heading: "Build",
    links: [
      { label: "CLI", href: "/docs/cli" },
      { label: "REST API", href: "/docs/api/overview" },
      { label: "MCP server", href: "/docs/mcp/overview" },
      { label: "Connections", href: "/docs/connections/github" },
    ],
  },
  {
    heading: "Trust",
    links: [
      { label: "Security", href: "/docs/security/overview" },
      {
        label: "Tenant isolation",
        href: "/docs/security/tenant-isolation-rls",
      },
      { label: "SOC 2", href: "/docs/security/soc2" },
      { label: "Enterprise", href: "/docs/enterprise/overview" },
    ],
  },
];

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
          <Link href="/" aria-label="Oxagen home" className="flex items-center">
            <OxagenLockup />
            <span className="ml-2 hidden text-sm font-medium text-muted-foreground sm:inline">
              Docs
            </span>
          </Link>

          <nav className="hidden items-center gap-7 md:flex">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Read the docs
            </Link>
            <a
              href={APP_URL}
              className="lp-grad-surface inline-flex h-9 items-center rounded-lg px-4 text-sm font-semibold text-ink-dark shadow-sm transition-transform hover:scale-[1.03] active:scale-100"
            >
              Open Oxagen
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border bg-muted/20">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2">
              <OxagenLogomark className="size-6" />
              <span className="ox-wordmark text-lg text-foreground">
                oxagen
              </span>
            </div>
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              Governed, auditable, tenant-isolated AI — every model call through
              one metered, IAM-gated, audit-logged chokepoint.
            </p>
          </div>
          {FOOTER.map((col) => (
            <div key={col.heading}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                {col.heading}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
            <span>
              © <CopyrightYear /> Oxagen. All rights reserved.
            </span>
            <span className="font-mono">
              app.oxagen.sh · api.oxagen.sh · mcp.oxagen.sh
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
