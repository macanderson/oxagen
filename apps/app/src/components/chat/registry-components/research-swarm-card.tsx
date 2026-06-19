"use client";
import * as React from "react";
import { Radar, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/**
 * research-swarm-card — renders research.swarm.start and research.swarm.status.
 * Shows a live progress indicator (completed / total tasks) and, once results
 * land, the per-query breakdown. This is the surface the user watches while the
 * swarm runs.
 *
 * componentId: "research-swarm-card"
 */

interface SwarmResult {
  query: string;
  resultCount: number;
}

interface ResearchSwarmCardProps {
  capability?: string;
  output?: unknown;
}

interface SwarmShape {
  swarmId?: string;
  status: "running" | "complete" | "failed" | string;
  completed: number;
  total: number;
  results: SwarmResult[];
}

function readSwarm(output: unknown): SwarmShape {
  const o =
    typeof output === "object" && output !== null
      ? (output as Record<string, unknown>)
      : {};
  const total =
    typeof o.totalTasks === "number"
      ? o.totalTasks
      : typeof o.estimatedTasks === "number"
        ? o.estimatedTasks
        : 0;
  const results = Array.isArray(o.results)
    ? o.results.flatMap((r): SwarmResult[] => {
        if (typeof r !== "object" || r === null) return [];
        const rr = r as Record<string, unknown>;
        if (typeof rr.query !== "string") return [];
        return [{ query: rr.query, resultCount: typeof rr.resultCount === "number" ? rr.resultCount : 0 }];
      })
    : [];
  return {
    swarmId: typeof o.swarmId === "string" ? o.swarmId : undefined,
    status: typeof o.status === "string" ? o.status : "running",
    completed: typeof o.completedTasks === "number" ? o.completedTasks : 0,
    total,
    results,
  };
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  if (status === "complete") {
    return (
      <Badge variant="outline" className="gap-1 text-success">
        <CheckCircle2 className="size-3" aria-hidden="true" /> Complete
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="gap-1 text-error">
        <XCircle className="size-3" aria-hidden="true" /> Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Running
    </Badge>
  );
}

export default function ResearchSwarmCard(
  props: ResearchSwarmCardProps,
): React.ReactElement {
  const s = readSwarm(props.output);
  const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : s.status === "complete" ? 100 : 0;

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="research-swarm-card"
      data-status={s.status}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Radar className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">Research swarm</span>
        <span className="ml-auto">
          <StatusBadge status={s.status} />
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {s.completed} / {s.total || "?"} tasks
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                s.status === "failed" ? "bg-error" : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {s.results.length > 0 ? (
          <ul className="space-y-1">
            {s.results.slice(0, 20).map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate" title={r.query}>
                  {r.query}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {r.resultCount} result{r.resultCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        ) : s.status === "running" ? (
          <p className="text-xs text-muted-foreground">
            Searching across {s.total || "several"} queries in parallel…
          </p>
        ) : null}

        {s.swarmId ? (
          <p className="font-mono text-[11px] text-muted-foreground" title={s.swarmId}>
            {s.swarmId}
          </p>
        ) : null}
      </div>
    </div>
  );
}
