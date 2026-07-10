"use client";
import * as React from "react";
import { resolveRecordHref } from "@oxagen/oxagen/capability-meta";
import { ArrowRight, Sparkles, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * graph-edge-card — renders graph.edge.upsert output. The edgeId is the
 * composite "fromNodeId:EDGE_TYPE:toNodeId"; we split it and deep-link the two
 * endpoint nodes.
 *
 * componentId: "graph-edge-card"
 */

interface GraphEdgeCardProps {
  capability?: string;
  output?: unknown;
  orgSlug?: string;
  workspaceSlug?: string;
}

function parseEdgeId(edgeId: string): { from?: string; type?: string; to?: string } {
  const parts = edgeId.split(":");
  if (parts.length < 3) return {};
  // EDGE_TYPE is the middle segment; endpoints are the first and last.
  return { from: parts[0], type: parts.slice(1, -1).join(":"), to: parts[parts.length - 1] };
}

function NodeChip({
  id,
  href,
}: {
  id: string;
  href: string | null;
}): React.ReactElement {
  const label = id.length > 12 ? `${id.slice(0, 8)}…` : id;
  const cls = cn(
    "inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs",
  );
  return href ? (
    <a
      href={href}
      title={id}
      className={cn(
        cls,
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {label}
    </a>
  ) : (
    <span className={cls} title={id}>
      {label}
    </span>
  );
}

export default function GraphEdgeCard(props: GraphEdgeCardProps): React.ReactElement {
  const o =
    typeof props.output === "object" && props.output !== null
      ? (props.output as Record<string, unknown>)
      : {};
  const edgeId = typeof o.edgeId === "string" ? o.edgeId : "";
  const created = o.created === true;
  const { from, type, to } = parseEdgeId(edgeId);
  const slugs = { orgSlug: props.orgSlug, workspaceSlug: props.workspaceSlug };

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="graph-edge-card"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <GitMerge className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">
          Relationship {created ? "created" : "exists"}
        </span>
        {created ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
            <Sparkles className="size-3" aria-hidden="true" /> New
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {from ? <NodeChip id={from} href={resolveRecordHref("graph.node", from, slugs)} /> : null}
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <ArrowRight className="size-3.5" aria-hidden="true" />
          {type ? <span className="font-mono">{type}</span> : "related to"}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </span>
        {to ? <NodeChip id={to} href={resolveRecordHref("graph.node", to, slugs)} /> : null}
        {!from && !to ? (
          <span className="font-mono text-xs text-muted-foreground">{edgeId}</span>
        ) : null}
      </div>
    </div>
  );
}
