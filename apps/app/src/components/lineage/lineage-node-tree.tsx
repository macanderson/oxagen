/**
 * lineage-node-tree.tsx — indented tree list of every run in a fleet dispatch
 * (issue #1078). Renders the nested `LineageTreeNode[]` from
 * `buildLineageTree` (lib/lineage/tree.ts) as a keyboard-navigable list.
 *
 * Every run is cited through `NodeRef` (never a raw runId as the primary
 * on-screen identity — CLAUDE.md "Citing nodes & edges in the UI"), and a
 * delegation-ceiling violation is flagged with a dedicated red badge + tinted
 * row background so it cannot be missed while scanning the list.
 */

"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { Badge } from "@/components/ui/badge";
import {
  formatCost,
  formatDuration,
  statusBadgeVariant,
  timeAgo,
} from "@/components/activity/format";
import { cn } from "@/lib/utils";
import { lineageNodeRef } from "@/lib/lineage/node-ref";
import type { LineageTreeNode } from "@/lib/lineage/tree";

export interface LineageNodeTreeProps {
  tree: LineageTreeNode[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  className?: string;
}

export function LineageNodeTree({
  tree,
  selectedRunId,
  onSelect,
  className,
}: LineageNodeTreeProps) {
  if (tree.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        No runs in this dispatch yet.
      </p>
    );
  }

  return (
    <div
      className={cn("divide-y divide-border", className)}
      role="tree"
      aria-label="Fleet dispatch runs"
    >
      {tree.map((entry) => (
        <LineageTreeRow
          key={entry.node.runId}
          entry={entry}
          depth={0}
          selectedRunId={selectedRunId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function LineageTreeRow({
  entry,
  depth,
  selectedRunId,
  onSelect,
}: {
  entry: LineageTreeNode;
  depth: number;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const { node, children } = entry;
  const violation = node.delegationViolation !== null;
  const selected = selectedRunId === node.runId;
  const ref = React.useMemo(() => lineageNodeRef(node), [node]);

  return (
    <div role="treeitem" aria-selected={selected} aria-level={depth + 1}>
      <div
        role="button"
        tabIndex={0}
        data-testid={`lineage-row-${node.runId}`}
        onClick={() => onSelect(node.runId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node.runId);
          }
        }}
        style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
        className={cn(
          "flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 pr-3 text-sm transition-colors hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          selected && "bg-accent/60",
          violation && "bg-error/5",
        )}
      >
        <NodeRef node={ref} />

        <Badge variant={statusBadgeVariant(node.outcome)} size="sm">
          {node.outcome}
        </Badge>

        {violation && (
          <Badge
            variant="error"
            size="sm"
            data-testid={`violation-flag-${node.runId}`}
          >
            <AlertTriangle className="size-3" aria-hidden="true" />
            Delegation violation
          </Badge>
        )}

        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {formatCost(String(node.spend.costUsd)) ?? "$0"}
        </span>

        {node.model && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {node.model}
          </span>
        )}

        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {formatDuration(node.durationMs)}
        </span>

        {node.startedAt && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {timeAgo(node.startedAt)}
          </span>
        )}
      </div>

      {children.length > 0 && (
        <div role="group">
          {children.map((child) => (
            <LineageTreeRow
              key={child.node.runId}
              entry={child}
              depth={depth + 1}
              selectedRunId={selectedRunId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
