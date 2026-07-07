import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

/**
 * Marketplace layout — the Extend surface: browse + install plugins, manage
 * installed plugins and registries, and connect MCP servers.
 *
 * Promoted out of Settings → Plugins so marketplace browsing and MCP-server
 * connection are first-class workspace surfaces rather than buried in
 * settings. `/settings/plugins` redirects here (see settings/plugins/page.tsx).
 */
export default async function MarketplaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Browse", href: workspace.marketplace.browse(ctx) },
    { label: "Installed", href: workspace.marketplace.installed(ctx) },
    { label: "MCP Servers", href: workspace.marketplace.mcp(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Marketplace"
        description="Browse and install plugins, and connect MCP servers."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
