import Link from "next/link";
import { Bot, Plus, Rocket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveStudioScope } from "@/lib/studio/scope";
import { listAgents, type AgentListRow } from "@/lib/studio/agents";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

function statusVariant(
  status: AgentListRow["status"],
): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "archived") return "outline";
  return "secondary";
}

/**
 * Studio → Agents list. Server component: resolves the Studio scope and lists
 * the workspace's agent definitions. Rows link into the Agent Builder;
 * deployed agents also get a Launch link into the Ask surface bound to the
 * agent via `?agent=<publicId>` (the contract other surfaces consume).
 */
export default async function StudioAgentsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const { ctx, canManage } = await resolveStudioScope(orgSlug, workspaceSlug);
  const agents = await listAgents(ctx);

  return (
    <div className="flex flex-col gap-6">
      {/* Header + primary action */}
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-muted-foreground">
          {agents.length} agent{agents.length !== 1 ? "s" : ""}
        </div>
        {canManage ? (
          <Button
            variant="gradient"
            size="sm"
            startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            data-testid="agents-new-button"
            render={<Link href={workspace.studio.agentNew(routeCtx)} />}
          >
            New agent
          </Button>
        ) : null}
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
              render={<Link href={workspace.studio.agentNew(routeCtx)} />}
            >
              Build your first agent
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className="rounded-md border bg-card overflow-x-auto"
          data-testid="agents-table"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Deployment
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Version
                </th>
                <th className="px-4 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent, idx) => {
                const launchable = agent.deploymentStatus === "active";
                return (
                  <tr
                    key={agent.agentId}
                    className={`border-b last:border-0 hover:bg-muted/20 transition-colors${idx % 2 === 1 ? " bg-muted/5" : ""}`}
                    data-testid={`agent-row-${agent.slug}`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={workspace.studio.agent(routeCtx, agent.publicId)}
                        className="flex flex-col gap-0.5"
                        data-testid={`agent-link-${agent.slug}`}
                      >
                        <span className="font-medium text-foreground inline-flex items-center gap-2">
                          {agent.name}
                          {agent.managed ? (
                            <Badge variant="outline" className="text-[10px]">
                              Managed
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {agent.slug}
                        </span>
                      </Link>
                      {/* Globally-unique agent key — copyable for API calls and
                          A2A routing. Rendered outside the row Link so the copy
                          button isn't a nested interactive control. */}
                      {agent.agentKey ? (
                        <div className="mt-1.5">
                          <CopyableId
                            value={agent.agentKey}
                            label="key"
                            max={40}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={statusVariant(agent.status)}
                        className="text-xs capitalize"
                      >
                        {agent.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={
                          agent.deploymentStatus === "active"
                            ? "default"
                            : "secondary"
                        }
                        className="text-xs capitalize"
                      >
                        {agent.deploymentStatus}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground text-xs">
                      {agent.latestVersion ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {launchable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          endIcon={
                            <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                          }
                          data-testid={`agent-launch-${agent.slug}`}
                          render={
                            <Link
                              href={`${workspace.ask(routeCtx)}?agent=${encodeURIComponent(agent.publicId)}`}
                            />
                          }
                        >
                          Launch
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          data-testid={`agent-edit-${agent.slug}`}
                          render={
                            <Link
                              href={workspace.studio.agent(
                                routeCtx,
                                agent.publicId,
                              )}
                            />
                          }
                        >
                          {agent.managed ? "View" : "Edit"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
