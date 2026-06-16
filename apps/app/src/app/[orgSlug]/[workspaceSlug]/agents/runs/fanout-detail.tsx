"use client";
/**
 * fanout-detail.tsx — live detail of one subagent fan-out.
 *
 * Shows the aggregate status plus every child run (capability, status, duration,
 * error, output preview). Polls the read server action while the fan-out is
 * still live, then settles. This is the per-fan-out drill-down of the monitor.
 */
import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardPanel } from "@/components/ui/card";
import { workspace } from "@/lib/routes";
import { getFanoutAction, type AgentSubagentFanoutGetOutput } from "./fanout-actions";
import {
  FANOUT_BADGE,
  RUN_BADGE,
  isFanoutLive,
  formatDuration,
  formatBytes,
  progressLabel,
} from "./fanout-ui";

const POLL_MS = 3000;

export interface FanoutDetailProps {
  initialFanout: AgentSubagentFanoutGetOutput;
  orgSlug: string;
  workspaceSlug: string;
}

export function FanoutDetail({ initialFanout, orgSlug, workspaceSlug }: FanoutDetailProps) {
  const [fanout, setFanout] = React.useState<AgentSubagentFanoutGetOutput>(initialFanout);
  const ctx = { orgSlug, workspaceSlug };

  const live = isFanoutLive(fanout.status);
  React.useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const next = await getFanoutAction({ orgSlug, workspaceSlug }, fanout.fanoutId);
        if (!cancelled) setFanout(next);
      } catch {
        // Keep the last good snapshot; retry on the next tick.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live, orgSlug, workspaceSlug, fanout.fanoutId]);

  const badge = FANOUT_BADGE[fanout.status];

  return (
    <div className="flex flex-col gap-5" data-testid="fanout-detail">
      <Link
        href={workspace.agents.runs(ctx)}
        className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to fan-outs
      </Link>

      <Card>
        <CardPanel className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-xs text-foreground">{fanout.fanoutId}</span>
            <span className="text-[11px] text-muted-foreground">
              {progressLabel(fanout.completedChildren, fanout.totalChildren)} children complete
            </span>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </CardPanel>
      </Card>

      <ul className="flex flex-col gap-2">
        {fanout.runs.map((run) => {
          const runBadge = RUN_BADGE[run.status];
          return (
            <li key={run.runId}>
              <Card>
                <CardPanel className="flex flex-col gap-2 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs text-foreground">
                      {run.capabilityName}
                    </span>
                    <Badge variant={runBadge.variant}>{runBadge.label}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>Duration: {formatDuration(run.durationMs)}</span>
                    <span>In: {formatBytes(run.inputBytes)}</span>
                    <span>Out: {formatBytes(run.outputBytes)}</span>
                  </div>
                  {run.errorReason && (
                    <p className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                      {run.errorReason}
                    </p>
                  )}
                  {run.outputPreview && (
                    <pre className="overflow-x-auto rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                      {run.outputPreview}
                    </pre>
                  )}
                </CardPanel>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
