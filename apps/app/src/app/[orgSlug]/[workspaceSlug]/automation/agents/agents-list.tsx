"use client";
/**
 * agents-list.tsx — workspace agents table with empty state.
 *
 * Presentational client component. Columns: name, status, deployment, latest
 * version, trigger count. Rows link to the agent detail page. A "New agent"
 * action routes to the create flow (owners/admins only).
 */
import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { workspace } from "@/lib/routes";
import { LIFECYCLE_BADGE, DEPLOYMENT_BADGE } from "./agent-ui";
import type { AgentLifecycleStatus, AgentDeploymentStatus } from "./agent-ui";

export interface AgentRow {
  agentId: string;
  publicId: string;
  slug: string;
  name: string;
  description: string | null;
  status: AgentLifecycleStatus;
  deploymentStatus: AgentDeploymentStatus;
  latestVersion: number | null;
  triggerCount: number;
}

export interface AgentsListProps {
  agents: AgentRow[];
  canEdit: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

export function AgentsList({ agents, canEdit, orgSlug, workspaceSlug }: AgentsListProps) {
  const ctx = { orgSlug, workspaceSlug };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-end">
        {canEdit && (
          <Button
            render={<Link href={workspace.agents.create(ctx)} />}
            variant="gradient"
            size="sm"
            startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            New agent
          </Button>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/40 px-6 py-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/60 bg-muted/60">
            <Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold text-foreground">No agents yet</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Create your first agent definition. It starts as a draft — publish a version, then deploy
            it to make its triggers live.
          </p>
          {canEdit && (
            <Button
              render={<Link href={workspace.agents.create(ctx)} />}
              variant="outline"
              size="sm"
              startIcon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              Create agent
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 text-xs">
                <th className="px-4 py-2 text-left font-medium">Agent</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Deployment</th>
                <th className="px-4 py-2 text-left font-medium">Version</th>
                <th className="px-4 py-2 text-left font-medium">Triggers</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const lifecycle = LIFECYCLE_BADGE[agent.status];
                const deployment = DEPLOYMENT_BADGE[agent.deploymentStatus];
                return (
                  <tr
                    key={agent.agentId}
                    className="border-b border-border/30 transition-colors last:border-0 hover:bg-muted/20"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={workspace.agents.detail(ctx, agent.slug)}
                        className="flex flex-col gap-0.5"
                      >
                        <span className="font-semibold text-foreground hover:underline">
                          {agent.name}
                        </span>
                        {agent.description && (
                          <span className="line-clamp-1 text-xs text-muted-foreground">
                            {agent.description}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={lifecycle.variant} size="sm">
                        {lifecycle.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={deployment.variant} size="sm">
                        {deployment.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {agent.latestVersion != null ? `v${agent.latestVersion}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{agent.triggerCount}</td>
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
