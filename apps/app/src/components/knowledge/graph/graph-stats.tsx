/**
 * GraphStatsBoxes — at-a-glance counts for the knowledge graph.
 *
 * Pure presentational (no hooks), so it renders in both Server Components (the
 * Knowledge → Graph tab, server-fetched via invoke("get_graph_stats")) and Client
 * Components (the chat registry's "graph-stats" renderer, fed the agent's
 * graph.stats output). One component, one source of truth — no drift between the
 * page boxes and the agent-rendered boxes.
 *
 * Shape mirrors the graph.stats contract output.
 */
import { Boxes, GitGraph, Sparkles, Plug } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GraphStatsData {
  nodeCount: number;
  edgeCount: number;
  inferredEdgeCount: number;
  sourceCount: number;
  nodesByLabel?: Record<string, number>;
  edgesByType?: Record<string, number>;
  lastModifiedAt?: string;
}

const STAT_BOXES = [
  { key: "nodeCount", label: "Nodes", Icon: Boxes },
  { key: "edgeCount", label: "Edges", Icon: GitGraph },
  { key: "inferredEdgeCount", label: "Inferred", Icon: Sparkles },
  { key: "sourceCount", label: "Sources", Icon: Plug },
] as const;

function formatCount(n: number | undefined): string {
  return (typeof n === "number" ? n : 0).toLocaleString();
}

export function GraphStatsBoxes({
  stats,
  className,
}: {
  stats: GraphStatsData;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      data-testid="graph-stats"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAT_BOXES.map(({ key, label, Icon }) => (
          <div
            key={key}
            className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Icon className="size-3.5" aria-hidden="true" />
              <span className="text-[11px] font-medium uppercase tracking-wide">
                {label}
              </span>
            </div>
            <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">
              {formatCount(stats[key])}
            </span>
          </div>
        ))}
      </div>
      {stats.lastModifiedAt && new Date(stats.lastModifiedAt).getTime() > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Last updated {new Date(stats.lastModifiedAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}
