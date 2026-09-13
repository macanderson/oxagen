import type { Metadata } from "next";
import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { ensureAgentSummaries, listAgents } from "@/lib/workbench/agents";
import { getAssignedAgentRoles } from "@/lib/workbench/agent-roles";
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

  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  const agents = await ensureAgentSummaries(ctx, await listAgents(ctx));

  // Role badge per agent (Agent RBAC Phase 5a): parallel list_agent_roles
  // lookups, fail-open — a failed lookup means no badge, never a failed list.
  const rolesByAgent = await getAssignedAgentRoles(
    ctx,
    agents.map((agent) => agent.publicId),
  );

  // Route targets are resolved server-side so the client grid stays a pure
  // presenter with no dependency on the scope context.
  const rows: AgentGridRow[] = agents.map((agent) => ({
    ...agent,
    roleName: rolesByAgent.get(agent.publicId) ?? null,
    detailHref: workspace.workbench.agent(routeCtx, agent.publicId),
    launchHref:
      agent.deploymentStatus === "active"
        ? `${workspace.sessions(routeCtx)}?agent=${encodeURIComponent(agent.publicId)}`
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
      {agents.length === 0 ? (
        <EmptyState
          variant="dashed"
          icon={<Bot />}
          title="No agents in this workspace yet"
          description="Describe an agent in plain language and the builder drafts its full configuration — prompt, tools, and graph access."
          data-testid="agents-empty-state"
          action={
            canManage ? (
              <Button
                variant="outline"
                size="sm"
                startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                render={<Link href={workspace.workbench.agentNew(routeCtx)} />}
              >
                Build your first agent
              </Button>
            ) : undefined
          }
        />
      ) : (
        <AgentsGrid agents={rows} />
      )}
    </div>
  );
}
