"use client";
/**
 * graph-stats — chat registry renderer for the graph.stats capability.
 *
 * When the in-app agent calls graph.stats, the handler attaches a render
 * directive { componentId: "graph-stats", props: <graph.stats output> }
 * (app surface only). translate-stream emits a "component" event, and this
 * renderer maps the (untyped) block props onto the SHARED GraphStatsBoxes
 * component — so the chat shows the exact same boxes as the Knowledge → Graph
 * tab. Props arrive as Record<string, unknown>, so each field is coerced
 * defensively.
 */
import {
  GraphStatsBoxes,
  type GraphStatsData,
} from "@/components/knowledge/graph/graph-stats";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export default function GraphStatsBlock(props: Record<string, unknown>) {
  const stats: GraphStatsData = {
    nodeCount: num(props.nodeCount),
    edgeCount: num(props.edgeCount),
    inferredEdgeCount: num(props.inferredEdgeCount),
    sourceCount: num(props.sourceCount),
    lastModifiedAt:
      typeof props.lastModifiedAt === "string"
        ? props.lastModifiedAt
        : undefined,
  };
  return <GraphStatsBoxes stats={stats} className="my-1" />;
}
