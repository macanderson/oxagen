/**
 * activity-list.tsx — recent agent runs, one row per top-level execution,
 * each linking to its span-tree trace page. Server-safe (no client hooks):
 * rows are Links and "Load older" is a query-param navigation, so the list
 * needs no client-side fetching.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { AgentExecutionListOutput } from "@oxagen/oxagen/contracts/agent.execution.list";
import { Badge } from "@/components/ui/badge";
import {
  formatCost,
  formatDuration,
  formatTokens,
  statusBadgeVariant,
  timeAgo,
} from "./format";

type Execution = AgentExecutionListOutput["executions"][number];

export function ActivityList({
  executions,
  nextCursor,
  basePath,
}: {
  executions: Execution[];
  nextCursor: string | null;
  /** e.g. /acme/production/activity — used for row + pagination links. */
  basePath: string;
}) {
  if (executions.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No agent runs yet. Runs appear here as agents execute in this workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="hidden items-center gap-3 border-b px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground md:flex">
          <span className="w-24 shrink-0">Status</span>
          <span className="min-w-0 flex-1">Run</span>
          <span className="w-24 shrink-0 text-right">Duration</span>
          <span className="w-28 shrink-0 text-right">Tokens</span>
          <span className="w-20 shrink-0 text-right">Cost</span>
          <span className="w-20 shrink-0 text-right">When</span>
        </div>
        <ul className="divide-y">
          {executions.map((run) => {
            const tokens = formatTokens(run.inputTokens, run.outputTokens);
            const cost = formatCost(run.estimatedCostUsd);
            return (
              <li key={run.executionId}>
                <Link
                  href={`${basePath}/${encodeURIComponent(run.executionId)}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60"
                >
                  <span className="w-24 shrink-0">
                    <Badge variant={statusBadgeVariant(run.status)} size="sm">
                      {run.status}
                    </Badge>
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="font-mono text-sm">{run.executionId}</span>
                    <span className="text-xs text-muted-foreground">{run.originType}</span>
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {formatDuration(run.latencyMs)}
                  </span>
                  <span className="w-28 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {tokens || "—"}
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {cost ?? "—"}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                    {timeAgo(run.createdAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      {nextCursor ? (
        <div className="flex justify-center">
          <Link
            href={`${basePath}?before=${encodeURIComponent(nextCursor)}`}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted/60"
          >
            Load older runs
            <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
