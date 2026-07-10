import type { Metadata } from "next";
import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
// import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import {
  ensureAgentSummaries,
  listAgents,
} from "@/lib/workbench/agents";
import { AgentsGrid, type AgentGridRow } from "./agents-grid";

export const metadata: Metadata = {
  title: "Agents | Workbench",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Workbench → Agents list. Server component: resolves the Workbench scope,
 * lists the workspace's agent definitions, and lazily backfills missing
 * LLM-inferred summaries (bounded, fail-open) before handing the rows to the
 * card grid. Cards link into the Agent Builder; deployed agents also get a
 * Launch link into the Ask surface bound via `?agent=<publicId>` (the
 * contract other surfaces consume).
 */
export default async function WorkbenchAgentsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const { ctx, canManage } = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  const agents = await ensureAgentSummaries(ctx, await listAgents(ctx));

  // Route targets are resolved server-side so the client grid stays a pure
  // presenter with no dependency on the scope context.
  const rows: AgentGridRow[] = agents.map((agent) => ({
    ...agent,
    detailHref: workspace.workbench.agent(routeCtx, agent.publicId),
    launchHref:
      agent.deploymentStatus === "active"
        ? `${workspace.ask(routeCtx)}?agent=${encodeURIComponent(agent.publicId)}`
        : null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Build interactive agents and equip them with skills, MCP servers, and capabilities."
        className="pb-0"
        actions={
          canManage ? (
            <Button
              variant="gradient"
              size="sm"
              startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              data-testid="agents-new-button"
              render={<Link href={workspace.workbench.agentNew(routeCtx)} />}
            >
              New agent
            </Button>
          ) : undefined
        }
      />
      <div className="text-sm text-muted-foreground">
        {agents.length} agent{agents.length !== 1 ? "s" : ""}
      </div>

      {agents.length === 0 ? (
        <div
          className="flex flex-col items-center gap-3 rounded-md border bg-card py-16 text-center text-muted-foreground"
          data-testid="agents-empty-state"
        >
          <Bot className="h-8 w-8 opacity-40" aria-hidden="true" />
          <p className="text-sm">No agents in this workspace yet.</p>
          {canManage ? (
            <Button
              variant="outline"
              size="sm"
              startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              render={<Link href={workspace.workbench.agentNew(routeCtx)} />}
            >
              Build your first agent
            </Button>
          ) : null}
        </div>
      ) : (
        <AgentsGrid agents={rows} />
      )}
    </div>
  );
}
