"use client";
/**
 * recommended-connections.tsx — the "connect this next" panel for the Agent
 * Builder.
 *
 * agent.definition.suggest returns `recommendations[]`: tools the agent SHOULD
 * have that are NOT registered in the workspace yet — MCP servers from the
 * synced registry catalog. They are deliberately kept out of
 * suggestion.config.agentTools — an agent can't be allowlisted for what isn't
 * there — so the builder surfaces them separately here: each row cites the
 * server by name, explains why the agent needs it, and links to the org's
 * developer MCP page where it is connected. Connect links open in a new tab so
 * the in-progress builder isn't lost. Renders nothing when there is nothing to
 * recommend.
 *
 * Per ADR-041 the skill recommendation kind is filtered out: skills are gone
 * with the runtime, so a skill recommendation has no surface to connect on.
 *
 * Extracted from agent-builder.tsx so the panel is unit-testable without
 * mounting the whole wizard (mirrors suggestion-mapping.ts's extraction).
 */
import Link from "next/link";
import { ExternalLink, Plug, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { org } from "@/lib/routes";
import type { AgentRecommendation } from "./suggestion-mapping";

export interface RecommendedConnectionsProps {
  recommendations: AgentRecommendation[];
  orgSlug: string;
}

export function RecommendedConnections({
  recommendations,
  orgSlug,
}: RecommendedConnectionsProps) {
  const connectable = recommendations.filter(
    (rec) => rec.kind === "mcp_server",
  );
  if (connectable.length === 0) return null;
  const href = org.developer.mcp({ orgSlug });

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
        Not registered in this workspace yet, so they weren&rsquo;t allowlisted.
        Connect one, then re-generate or add it under Tools.
      </p>
      <ul className="flex flex-col gap-2">
        {connectable.map((rec) => (
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
                  <Server className="h-3 w-3" aria-hidden="true" />
                  MCP server
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
              endIcon={<ExternalLink className="h-3 w-3" aria-hidden="true" />}
              data-testid={`agent-recommendation-connect-${rec.ref}`}
              render={<Link href={href} target="_blank" rel="noreferrer" />}
            >
              Connect
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
