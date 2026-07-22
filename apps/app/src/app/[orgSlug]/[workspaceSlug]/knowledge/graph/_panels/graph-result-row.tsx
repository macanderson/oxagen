"use client";

/**
 * graph-result-row.tsx — one node citation row shared by the Browse, Search,
 * and Query-console panels.
 *
 * Citation rule split into two distinct affordances so neither fights the
 * other:
 *   - `NodeRef` itself is the inspect surface (hover/click opens the property
 *     popover) — never a navigation target, per its own contract.
 *   - A separate "Open detail" icon-button navigates to the node-detail route
 *     (`workspace.knowledge.node`). Hidden entirely for unmaterialised
 *     candidates (`node.id === null`) — there is nowhere to navigate to.
 *
 * The optional `expand` affordance (Browse panel only) discloses a node's
 * one-hop neighborhood inline via `ontology.neighbors`, rendered as nested
 * `GraphResultRow`s so a neighbor is itself inspectable/openable.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { Button } from "@/components/ui/button";
import { workspace } from "@/lib/routes";
import { cn } from "@/lib/utils";

export interface GraphResultRowExpand {
  expanded: boolean;
  loading: boolean;
  onToggle: () => void;
}

export interface GraphResultRowProps {
  node: KnowledgeNodeRef;
  orgSlug: string;
  workspaceSlug: string;
  /** Optional trailing content (e.g. a relevance-score badge). */
  meta?: React.ReactNode;
  expand?: GraphResultRowExpand;
  /** Rendered under the row when `expand.expanded` is true. */
  children?: React.ReactNode;
  className?: string;
}

export function GraphResultRow({
  node,
  orgSlug,
  workspaceSlug,
  meta,
  expand,
  children,
  className,
}: GraphResultRowProps) {
  const canOpen = node.id != null;

  return (
    <div
      className={cn("rounded-md border border-border/60", className)}
      data-testid="graph-result-row"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {expand ? (
          <button
            type="button"
            onClick={expand.onToggle}
            aria-label={
              expand.expanded
                ? `Collapse ${node.displayName} neighbors`
                : `Expand ${node.displayName} neighbors`
            }
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {expand.loading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : expand.expanded ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
          </button>
        ) : null}
        <NodeRef node={node} className="min-w-0 flex-1" />
        {meta}
        {canOpen ? (
          <Button
            size="icon-sm"
            variant="ghost"
            render={
              <Link
                href={workspace.knowledge.node(
                  { orgSlug, workspaceSlug },
                  node.id as string,
                )}
              />
            }
            aria-label={`Open ${node.displayName} detail`}
          >
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {expand?.expanded ? (
        <div className="border-t border-border/50 py-1.5 pl-8 pr-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
