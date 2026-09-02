/**
 * page.tsx — Workspace → Workbench → Agent Tools → All Tools.
 *
 * Human-legible, read-only catalog of every agent tool available in this
 * workspace (the same list `agent.tool.list` surfaces to the Agent Builder's
 * Equip step). Data is loaded server-side via `resolveWorkbenchScope` +
 * `listAgentTools`; the client panel (`ToolsCatalog`) owns search, filtering,
 * and the row detail Sheet. No mutations happen on this tab — Skills, MCP
 * Servers, and Capabilities are managed in their sibling tabs; NEW tools are
 * installed from the Marketplace (Agent Tools side).
 */
import type { Metadata } from "next";
import { logger } from "@oxagen/handlers/logger";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { listAgentTools, type AgentToolRow } from "@/lib/workbench/tools";
import { workspace } from "@/lib/routes";
import { ToolsCatalog } from "./tools-catalog";

export const metadata: Metadata = {
  title: "Agent Tools | Workbench",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkbenchToolsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx } = await resolveWorkbenchScope(orgSlug, workspaceSlug);

  let tools: AgentToolRow[] = [];
  try {
    tools = await listAgentTools(ctx);
  } catch (err) {
    // Degrade gracefully — the catalog renders its empty state — but never
    // silently: an invisible broken catalog looks like "no tools installed".
    logger.error(
      { err, orgSlug, workspaceSlug },
      "workbench/tools: agent.tool.list failed — rendering an empty catalog",
    );
    tools = [];
  }

  const marketplaceHref = workspace.marketplace.agentTools({
    orgSlug,
    workspaceSlug,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">All Tools</h2>
        <p className="text-sm text-muted-foreground">
          Every tool available to agents in this workspace — from skills, MCP
          servers, and capabilities — after allowlist and risk filtering. Equip
          tools in the Agent Builder; install more from the Marketplace.
        </p>
      </div>
      <ToolsCatalog tools={tools} marketplaceHref={marketplaceHref} />
    </div>
  );
}
