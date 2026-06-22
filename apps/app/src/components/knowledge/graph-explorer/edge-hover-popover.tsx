/**
 * edge-hover-popover.tsx — a lightweight, cursor-anchored card shown while the
 * pointer hovers an edge in the canvas.
 *
 * reagraph edges have no DOM anchor, so this is positioned at the last cursor
 * position (captured by the canvas wrapper) using fixed coordinates. It is
 * purely presentational and never intercepts pointer events.
 */

"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { ExplorerEdge, ExplorerNode } from "./types";
import { formatConfidence } from "./lib/format";
import { truncate } from "./lib/format";

export interface EdgeHoverPopoverProps {
  edge: ExplorerEdge;
  pos: { x: number; y: number };
  sourceNode?: ExplorerNode;
  targetNode?: ExplorerNode;
}

export function EdgeHoverPopover({ edge, pos, sourceNode, targetNode }: EdgeHoverPopoverProps) {
  // Offset from the cursor and clamp to the viewport so the card never clips.
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(pos.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1024) - 260),
    top: Math.min(pos.y + 14, (typeof window !== "undefined" ? window.innerHeight : 768) - 140),
    zIndex: 60,
    pointerEvents: "none",
  };

  return (
    <div
      style={style}
      className="w-60 rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
      role="tooltip"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono font-semibold text-foreground">{edge.type}</span>
        <Badge variant={edge.inferred ? "secondary" : "outline"} size="sm">
          {edge.inferred ? "Inferred" : "Confirmed"}
        </Badge>
      </div>
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <dt className="text-muted-foreground">From</dt>
        <dd className="truncate text-foreground" title={sourceNode?.displayName ?? edge.source}>
          {sourceNode?.displayName ?? truncate(edge.source, 24)}
        </dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="truncate text-foreground" title={targetNode?.displayName ?? edge.target}>
          {targetNode?.displayName ?? truncate(edge.target, 24)}
        </dd>
        {edge.inferred && typeof edge.confidence === "number" && (
          <>
            <dt className="text-muted-foreground">Confidence</dt>
            <dd className="font-medium tabular-nums text-foreground">{formatConfidence(edge.confidence)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
