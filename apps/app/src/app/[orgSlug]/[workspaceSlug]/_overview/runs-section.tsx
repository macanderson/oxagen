/**
 * runs-section.tsx — Overview → Recent runs tile.
 *
 * Last 5 top-level agent executions via agent.execution.list, same invoke()
 * shape as apps/app/src/app/[orgSlug]/[workspaceSlug]/activity/activity-section.tsx.
 * Renders its own compact rows (rather than reusing <ActivityList>, which is
 * built for the full paginated Activity page) so the tile stays scoped to five
 * rows plus a footer link — no "load older" affordance here.
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentExecutionListOutput } from "@oxagen/oxagen/contracts/agent.execution.list";
import Link from "next/link";
import { PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { workspace } from "@/lib/routes";
import { Tile, EmptyState, ErrorState } from "../_shared/components";
import { formatCost, formatDuration, statusBadgeVariant, timeAgo } from "@/components/activity/format";

interface RunsTileProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export async function RunsTile({ orgId, workspaceId, userId, orgSlug, workspaceSlug }: RunsTileProps) {
  const ctx = { orgSlug, workspaceSlug };
  const activityHref = workspace.activity.root(ctx);
  const askHref = workspace.ask(ctx);

  let executions: AgentExecutionListOutput["executions"] = [];
  let failed = false;
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "list_executions",
        { limit: 5 },
        {
          orgId,
          workspaceId,
          userId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        },
        { surface: "agent" },
      ),
    )) as AgentExecutionListOutput;
    executions = result.executions;
  } catch (e) {
    console.error("list_executions failed:", e);
    failed = true;
  }

  const footer = (
    <Link href={activityHref} className="text-sm font-medium text-primary hover:underline">
      View all runs →
    </Link>
  );

  return (
    <div data-testid="overview-runs-tile">
      <Tile title="Recent runs" footer={footer}>
        {failed ? (
          <ErrorState
            title="Runs unavailable"
            description="Could not load recent agent runs."
          />
        ) : executions.length === 0 ? (
          <EmptyState
            icon={PlayCircle}
            title="No runs yet"
            description="Ask a question to kick off your first agent run."
            action={
              <Link href={askHref} className="text-sm font-medium text-primary hover:underline">
                Open Ask →
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {executions.map((run) => (
              <li key={run.executionId}>
                <Link
                  href={workspace.activity.run(ctx, run.executionId)}
                  className="-mx-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/60"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge variant={statusBadgeVariant(run.status)} size="sm">
                      {run.status}
                    </Badge>
                    <span className="truncate text-muted-foreground">{run.originType}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 font-mono text-xs text-muted-foreground">
                    <span>{formatDuration(run.latencyMs)}</span>
                    <span>{formatCost(run.estimatedCostUsd) ?? "—"}</span>
                    <span>{timeAgo(run.startedAt ?? run.createdAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Tile>
    </div>
  );
}
