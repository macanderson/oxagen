/**
 * activity-panel.tsx — Overview HUD → Agent activity data panel.
 *
 * Last 30 top-level agent executions via agent.execution.list (same invoke()
 * idiom as runs-section.tsx, which this panel supersedes visually with a
 * richer summary row + 14-day trend). Renders a count summary (derived
 * honestly from the 30-row sample, not a true 30-day total), a MiniBars
 * runs-per-day trend for the last 14 UTC days, and the 5 most recent runs as
 * compact rows — same row markup as runs-section.tsx.
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentExecutionListOutput } from "@oxagen/oxagen/contracts/agent.execution.list";
import Link from "next/link";
import { Activity } from "lucide-react";
import { Card, CardHeader, CardTitle, CardPanel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { workspace } from "@/lib/routes";
import { EmptyState, ErrorState } from "../_shared/components";
import {
  formatCost,
  formatDuration,
  statusBadgeVariant,
  timeAgo,
} from "@/components/activity/format";
import { MiniBars } from "./hud/mini-bars";

interface ActivityPanelProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

const SAMPLE_LIMIT = 30;
const RECENT_ROWS = 5;
const TREND_DAYS = 14;

/** UTC day key (YYYY-MM-DD) for bucketing. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Zero-filled ascending array of the last `days` UTC day keys, ending today. */
function lastNDayKeys(days: number, now = new Date()): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i),
    );
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

export async function ActivityPanel({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: ActivityPanelProps) {
  const ctx = { orgSlug, workspaceSlug };
  const activityHref = workspace.activity.root(ctx);
  const askHref = workspace.ask(ctx);

  let executions: AgentExecutionListOutput["executions"] = [];
  let failed = false;
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "list_executions",
        { limit: SAMPLE_LIMIT },
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

  const total = executions.length;
  const succeeded = executions.filter((e) => e.status === "completed").length;
  const failedCount = executions.filter((e) => e.status === "failed").length;
  const running = executions.filter(
    (e) => e.status === "running" || e.status === "planning",
  ).length;

  const dayKeys = lastNDayKeys(TREND_DAYS);
  const counts = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  for (const run of executions) {
    const key = dayKey(run.startedAt ?? run.createdAt);
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const trend = dayKeys.map((k) => counts.get(k) ?? 0);

  const recent = executions.slice(0, RECENT_ROWS);

  return (
    <div data-testid="overview-activity-panel">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Agent activity</CardTitle>
          <Link
            href={activityHref}
            className="text-sm font-medium text-primary hover:underline"
          >
            View all runs →
          </Link>
        </CardHeader>
        <CardPanel className="pt-4">
          {failed ? (
            <ErrorState
              title="Activity unavailable"
              description="Could not load recent agent runs."
            />
          ) : total === 0 ? (
            <EmptyState
              icon={Activity}
              title="No runs yet"
              description="Ask a question to kick off your first agent run."
              action={
                <Link
                  href={askHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Open Ask →
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                  <div className="flex items-baseline gap-1.5">
                    <dt className="text-xs text-muted-foreground">
                      Last {total} runs
                    </dt>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <dd className="font-semibold tabular-nums text-foreground">
                      {succeeded}
                    </dd>
                    <dt className="text-xs text-muted-foreground">succeeded</dt>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <dd className="font-semibold tabular-nums text-foreground">
                      {failedCount}
                    </dd>
                    <dt className="text-xs text-muted-foreground">failed</dt>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <dd className="font-semibold tabular-nums text-foreground">
                      {running}
                    </dd>
                    <dt className="text-xs text-muted-foreground">running</dt>
                  </div>
                </dl>
                <MiniBars
                  values={trend}
                  highlightLast
                  aria-label="Runs per day, last 14 days"
                />
              </div>
              <ul className="flex flex-col divide-y divide-border">
                {recent.map((run) => (
                  <li key={run.executionId}>
                    <Link
                      href={workspace.activity.run(ctx, run.executionId)}
                      className="-mx-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/60"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge
                          variant={statusBadgeVariant(run.status)}
                          size="sm"
                        >
                          {run.status}
                        </Badge>
                        <span className="truncate text-muted-foreground">
                          {run.originType}
                        </span>
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
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
