"use client";
/**
 * recommended-connections.tsx — the "connect this next" panel for the Agent
 * Builder.
 *
 * agent.definition.suggest returns `recommendations[]`: tools the agent SHOULD
 * have that are NOT available in the workspace yet (MCP servers from the synced
 * registry catalog, or disabled skills). They are deliberately kept out of
 * suggestion.config.agentTools — an agent can't equip what isn't there — so the
 * builder surfaces them separately here: each row cites the tool by name,
 * explains why the agent needs it, and links to the surface where it's
 * connected (MCP server → the org's developer MCP page; skill → the workspace
 * Workbench skills page). Connect links open in a new tab so the in-progress
 * builder isn't lost. Renders nothing when there are no recommendations.
 *
 * Extracted from agent-builder.tsx so the panel is unit-testable without
 * mounting the whole wizard (mirrors suggestion-mapping.ts's extraction).
 */
import Link from "next/link";
import { ExternalLink, Plug, Puzzle, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { org, workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import type { AgentRecommendation } from "./suggestion-mapping";

const RECOMMENDATION_KIND: Record<
  AgentRecommendation["kind"],
  { label: string; Icon: typeof Server }
> = {
  mcp_server: { label: "MCP server", Icon: Server },
  skill: { label: "Skill", Icon: Puzzle },
};

export interface RecommendedConnectionsProps {
  recommendations: AgentRecommendation[];
  orgSlug: string;
  workspaceSlug: string;
}

export function RecommendedConnections({
  recommendations,
  orgSlug,
  workspaceSlug,
}: RecommendedConnectionsProps) {
  if (recommendations.length === 0) return null;
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  return (
    <div
      className="rounded-md border border-primary/30 bg-primary/[0.03] p-3"
      data-testid="agent-recommendations"
    >
      <div className="mb-1 flex items-center gap-2">
        <Plug className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          Recommended connections
        </p>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Not available in this workspace yet, so they weren&rsquo;t equipped.
        Connect one, then re-generate or add it in Equip.
      </p>
      <ul className="flex flex-col gap-2">
        {recommendations.map((rec) => {
          const { label, Icon } = RECOMMENDATION_KIND[rec.kind];
          const href =
            rec.kind === "mcp_server"
              ? org.developer.mcp({ orgSlug })
              : workspace.workbench.tools.skills(routeCtx);
          return (
            <li
              key={`${rec.kind}:${rec.ref}`}
              className="flex items-start justify-between gap-3 rounded-md border bg-card px-3 py-2"
              data-testid={`agent-recommendation-${rec.ref}`}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] font-medium"
                  >
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {label}
                  </Badge>
                  <span
                    className="truncate text-sm font-medium text-foreground"
                    data-testid="agent-recommendation-name"
                  >
                    {rec.name}
                  </span>
                </div>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="agent-recommendation-reason"
                >
                  {rec.reason}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 flex-shrink-0"
                endIcon={
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                }
                data-testid={`agent-recommendation-connect-${rec.ref}`}
                render={<Link href={href} target="_blank" rel="noreferrer" />}
              >
                Connect
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
