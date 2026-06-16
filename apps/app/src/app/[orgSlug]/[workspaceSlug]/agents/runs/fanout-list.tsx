"use client";
/**
 * fanout-list.tsx — live list of subagent fan-outs (the "agent monitor").
 *
 * Presentational + polling client component. Seeded with server-fetched data,
 * then refreshes every POLL_MS via the read server action so a user can watch
 * fan-outs progress in real time — the same feel as Claude Code's agent
 * monitor. Polling stops automatically when no fan-out is still live.
 */
import * as React from "react";
import Link from "next/link";
import { Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardPanel } from "@/components/ui/card";
import { workspace } from "@/lib/routes";
import { listFanoutsAction, type AgentSubagentFanoutListOutput } from "./fanout-actions";
import {
  FANOUT_BADGE,
  isFanoutLive,
  progressLabel,
  relativeTime,
} from "./fanout-ui";

const POLL_MS = 4000;

export type FanoutRow = AgentSubagentFanoutListOutput["fanouts"][number];

export interface FanoutListProps {
  initialFanouts: FanoutRow[];
  orgSlug: string;
  workspaceSlug: string;
}

export function FanoutList({ initialFanouts, orgSlug, workspaceSlug }: FanoutListProps) {
  const [fanouts, setFanouts] = React.useState<FanoutRow[]>(initialFanouts);
  const ctx = { orgSlug, workspaceSlug };

  // Poll while any fan-out is still pending/running. The effect re-subscribes
  // whenever liveness changes so a list that goes fully terminal stops polling.
  const anyLive = fanouts.some((f) => isFanoutLive(f.status));
  React.useEffect(() => {
    if (!anyLive) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const next = await listFanoutsAction({ orgSlug, workspaceSlug });
        if (!cancelled) setFanouts(next.fanouts);
      } catch {
        // Transient errors are non-fatal — keep the last good snapshot and let
        // the next tick retry.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [anyLive, orgSlug, workspaceSlug]);

  if (fanouts.length === 0) {
    return (
      <Card>
        <CardPanel className="flex flex-col items-center gap-2 py-12 text-center">
          <Network className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">No subagent fan-outs yet</p>
          <p className="max-w-md text-xs text-muted-foreground">
            When the agent dispatches a fan-out of subagents, each run shows up
            here with live status — like watching a fleet of agents work.
          </p>
        </CardPanel>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="fanout-list">
      <ul className="flex flex-col gap-2">
        {fanouts.map((f) => {
          const badge = FANOUT_BADGE[f.status];
          return (
            <li key={f.fanoutId}>
              <Link
                href={workspace.agents.run(ctx, f.fanoutId)}
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-mono text-xs text-foreground">{f.fanoutId}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {progressLabel(f.completedChildren, f.totalChildren)} children · {relativeTime(f.createdAt)}
                  </span>
                </div>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
