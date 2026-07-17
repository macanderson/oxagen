/**
 * node-ref.tsx — the canonical way to cite a knowledge-graph node in the UI.
 *
 * RULE: a node (or edge endpoint) is never shown by its raw UUID. It is cited by
 * its human label — a colour-coded domain dot + `displayName` — and every
 * citation is hover/focus/click inspectable, revealing the node's domain label,
 * a copyable id, and its full property bag. Reuse this component (and the
 * `sourceNodeRef`/`targetNodeRef` helpers) anywhere a node is referenced so the
 * presentation stays consistent across the graph explorer, inference review,
 * lineage, and future surfaces.
 *
 * Built on the shared graph-domain primitives (colour map, property list,
 * copyable id) so there is exactly one implementation of "show a node nicely".
 */

"use client";

import * as React from "react";
import type { KnowledgeNodeRef, SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CopyableId } from "../graph-explorer/copyable-id";
import { PropertyList } from "../graph-explorer/property-list";
import { colorForLabel } from "../graph-explorer/lib/colors";
import { truncate } from "../graph-explorer/lib/format";

// Property keys already shown in the citation header — omit them from the bag so
// the inspect panel doesn't repeat the name/label/id.
const OMITTED_PROPERTY_KEYS = ["displayName", "name", "publicId", "label", "id"];

/** Resolve a friendly citation for an inferred edge's source node. */
export function sourceNodeRef(edge: SemanticEdge): KnowledgeNodeRef {
  return (
    edge.sourceNode ?? {
      id: edge.sourceNodeId,
      label: "Node",
      displayName: edge.sourceNodeId,
      properties: {},
    }
  );
}

/** Resolve a friendly citation for an inferred edge's target node. */
export function targetNodeRef(edge: SemanticEdge): KnowledgeNodeRef {
  return (
    edge.targetNode ?? {
      id: null,
      label: "Node",
      displayName: edge.targetNodeId,
      properties: {},
    }
  );
}

/**
 * The best human label for a node — never an empty string, and never the raw
 * id. A `displayName` that is exactly the node's own id is the server's
 * last-resort coalesce fallback (`displayName → name → publicId`), not a human
 * name — skip it and cite by the domain label instead, so a UUID is never the
 * primary on-screen identifier (the id still lives in the copyable secondary).
 */
export function nodeCitationLabel(node: KnowledgeNodeRef): string {
  const name = node.displayName?.trim();
  if (name && name !== node.id) return name;
  if (node.label && node.label !== "Node") return node.label;
  // No human name and no domain label — prefer even the generic base label over
  // the raw id. A UUID is never the primary identifier; it lives only in the
  // copyable secondary (`??` would also leak the id, or an empty displayName).
  return node.label || "Unknown node";
}

export interface NodeRefProps {
  node: KnowledgeNodeRef;
  /** Visual weight of the chip's label. */
  emphasis?: "default" | "muted";
  className?: string;
}

/**
 * A node citation chip. Hovering/focusing/clicking opens a popover with the
 * node's domain label, copyable id, and full property list.
 */
export function NodeRef({ node, emphasis = "default", className }: NodeRefProps) {
  const label = nodeCitationLabel(node);
  const properties = node.properties ?? {};
  const color = colorForLabel(node.label);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={120}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border border-transparent px-1 py-0.5 text-left align-middle",
          "transition-colors hover:border-border/60 hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          className,
        )}
        aria-label={`Inspect ${node.label} ${label}`}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span
          className={cn(
            "truncate text-sm font-medium",
            emphasis === "muted" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {truncate(label, 48)}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5">
          <span
            className="mt-1 size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <Badge variant="outline" size="sm">
              {node.label}
            </Badge>
            <p className="mt-1 break-words text-sm font-semibold text-foreground">{label}</p>
            {node.id ? (
              <div className="mt-1.5">
                <CopyableId value={node.id} label="ID" max={24} />
              </div>
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Candidate — not yet materialised in the graph.
              </p>
            )}
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto px-3 py-2.5">
          <PropertyList properties={properties} omit={OMITTED_PROPERTY_KEYS} dense />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
