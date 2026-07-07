/**
 * page.tsx — Workspace → Studio → Tools.
 *
 * Human-legible, read-only catalog of every agent tool available in this
 * workspace (the same list `agent.tool.list` surfaces to the Agent Builder's
 * Equip step). Data is loaded server-side via `resolveStudioScope` +
 * `listAgentTools`; the client panel (`ToolsCatalog`) owns search, filtering,
 * and the row detail Sheet. No mutations happen on this page — installing new
 * tools happens in the Marketplace, and grants are managed under Access →
 * Roles.
 */
import type { Metadata } from "next";
import { resolveStudioScope } from "@/lib/studio/scope";
import { listAgentTools, type AgentToolRow } from "@/lib/studio/tools";
import { workspace } from "@/lib/routes";
import { ToolsCatalog } from "./tools-catalog";

export const metadata: Metadata = {
  title: "Tools | Studio",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function StudioToolsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx } = await resolveStudioScope(orgSlug, workspaceSlug);

  let tools: AgentToolRow[] = [];
  try {
    tools = await listAgentTools(ctx);
  } catch {
    // Degrade gracefully — the catalog renders its empty state.
    tools = [];
  }

  const marketplaceHref = workspace.marketplace.root({ orgSlug, workspaceSlug });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Agent Tools</h2>
        <p className="text-sm text-muted-foreground">
          Every capability available to agents in this workspace, after allowlist and risk
          filtering. Equip tools in the Agent Builder — manage who can grant them under
          Access → Roles.
        </p>
      </div>
      <ToolsCatalog tools={tools} marketplaceHref={marketplaceHref} />
    </div>
  );
}
