import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingHeroPage } from "@oxagen/ui";

export default function HomePage(): ReactNode {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="mb-12">
        <MarketingHeroPage />
      </div>

      <div className="flex-1 px-6 py-12 max-w-7xl mx-auto w-full">
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
          <Link href="/docs" className="group">
            <div className="rounded-lg border border-border p-6 hover:border-primary hover:bg-muted/50 transition-colors">
              <h3 className="font-semibold text-lg mb-2 group-hover:text-primary">Documentation</h3>
              <p className="text-sm text-muted-foreground">Complete guide to Oxagen platform, features, and best practices.</p>
            </div>
          </Link>

          <Link href="/docs/getting-started" className="group">
            <div className="rounded-lg border border-border p-6 hover:border-primary hover:bg-muted/50 transition-colors">
              <h3 className="font-semibold text-lg mb-2 group-hover:text-primary">Getting Started</h3>
              <p className="text-sm text-muted-foreground">Sign up, create your workspace, and send your first message.</p>
            </div>
          </Link>

          <Link href="/docs/api/overview" className="group">
            <div className="rounded-lg border border-border p-6 hover:border-primary hover:bg-muted/50 transition-colors">
              <h3 className="font-semibold text-lg mb-2 group-hover:text-primary">API Reference</h3>
              <p className="text-sm text-muted-foreground">REST API endpoints, authentication, and streaming capabilities.</p>
            </div>
          </Link>

          <Link href="/docs/agent/overview" className="group">
            <div className="rounded-lg border border-border p-6 hover:border-primary hover:bg-muted/50 transition-colors">
              <h3 className="font-semibold text-lg mb-2 group-hover:text-primary">Agent Platform</h3>
              <p className="text-sm text-muted-foreground">AI agents, tools, memory, plan mode, and code execution.</p>
            </div>
          </Link>

          <Link href="/docs/mcp/overview" className="group">
            <div className="rounded-lg border border-border p-6 hover:border-primary hover:bg-muted/50 transition-colors">
              <h3 className="font-semibold text-lg mb-2 group-hover:text-primary">MCP Server</h3>
              <p className="text-sm text-muted-foreground">Model Context Protocol integration, tools, and connections.</p>
            </div>
          </Link>

          <Link href="/docs/security/overview" className="group">
            <div className="rounded-lg border border-border p-6 hover:border-primary hover:bg-muted/50 transition-colors">
              <h3 className="font-semibold text-lg mb-2 group-hover:text-primary">Security</h3>
              <p className="text-sm text-muted-foreground">Tenant isolation, audit logging, SOC 2, and governance controls.</p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
