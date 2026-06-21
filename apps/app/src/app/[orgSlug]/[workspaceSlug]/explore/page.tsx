/**
 * page.tsx — Workspace → Explore.
 *
 * The read-only knowledge-graph explorer, mounted as a sibling tab of Ask. The
 * surrounding workspace layout has already asserted membership and mounted the
 * TenantProvider, so this page is thin: it renders the Ask/Explore tab strip and
 * the (client) explorer, which streams graph data from `/api/v1/graph/explore`.
 */
import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { GraphExplorer } from "@/components/knowledge/graph-explorer";

export const dynamic = "force-dynamic";

export default async function ExplorePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const tabs = [
    { label: "Ask", href: workspace.ask(ctx) },
    { label: "Explore", href: workspace.explore(ctx) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTabs tabs={tabs} className="mb-3 shrink-0" />
      <div className="min-h-0 flex-1">
        <GraphExplorer />
      </div>
    </div>
  );
}
