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
import { formatConfidence, formatPropertyValue, truncate } from "./lib/format";

export interface EdgeHoverPopoverProps {
  edge: ExplorerEdge;
  pos: { x: number; y: number };
  sourceNode?: ExplorerNode;
  targetNode?: ExplorerNode;
}

export function EdgeHoverPopover({
  edge,
  pos,
  sourceNode,
  targetNode,
}: EdgeHoverPopoverProps) {
  // Offset from the cursor and clamp to the viewport so the card never clips.
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(
      pos.x + 14,
      (typeof window !== "undefined" ? window.innerWidth : 1024) - 260,
    ),
    top: Math.min(
      pos.y + 14,
      (typeof window !== "undefined" ? window.innerHeight : 768) - 140,
    ),
    zIndex: 60,
    pointerEvents: "none",
  };

  return (
    <div
      style={style}
      className="max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
      role="tooltip"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono font-semibold text-foreground">
          {edge.type}
        </span>
        <Badge variant={edge.inferred ? "secondary" : "outline"} size="sm">
          {edge.inferred ? "Inferred" : "Confirmed"}
        </Badge>
      </div>
      <div className="mb-3 space-y-2 border-b border-border pb-2">
        <div>
          <p className="text-muted-foreground">From</p>
          <p
            className="font-medium text-foreground"
            title={sourceNode?.displayName ?? edge.source}
          >
            {sourceNode?.displayName ?? truncate(edge.source, 24)}
          </p>
          {sourceNode?.label && (
            <p className="text-[10px] text-muted-foreground">
              {sourceNode.label}
            </p>
          )}
        </div>
        <div>
          <p className="text-muted-foreground">To</p>
          <p
            className="font-medium text-foreground"
            title={targetNode?.displayName ?? edge.target}
          >
            {targetNode?.displayName ?? truncate(edge.target, 24)}
          </p>
          {targetNode?.label && (
            <p className="text-[10px] text-muted-foreground">
              {targetNode.label}
            </p>
          )}
        </div>
        {edge.inferred && typeof edge.confidence === "number" && (
          <div>
            <p className="text-muted-foreground">Confidence</p>
            <p className="font-medium tabular-nums text-foreground">
              {formatConfidence(edge.confidence)}
            </p>
          </div>
        )}
      </div>
      {(sourceNode?.properties || targetNode?.properties) && (
        <div className="space-y-1 text-[10px]">
          {sourceNode?.properties &&
            Object.keys(sourceNode.properties).length > 0 && (
              <div>
                <p className="font-medium text-muted-foreground">
                  Source properties
                </p>
                {Object.entries(sourceNode.properties)
                  .slice(0, 3)
                  .map(([k, v]) => (
                    <p key={k} className="truncate text-foreground/70">
                      {/* formatPropertyValue, not String(v) — nested values would
                        render as "[object Object]" otherwise. */}
                      <span className="font-mono text-muted-foreground">
                        {k}:
                      </span>{" "}
                      {truncate(formatPropertyValue(v), 20)}
                    </p>
                  ))}
              </div>
            )}
          {targetNode?.properties &&
            Object.keys(targetNode.properties).length > 0 && (
              <div>
                <p className="font-medium text-muted-foreground">
                  Target properties
                </p>
                {Object.entries(targetNode.properties)
                  .slice(0, 3)
                  .map(([k, v]) => (
                    <p key={k} className="truncate text-foreground/70">
                      <span className="font-mono text-muted-foreground">
                        {k}:
                      </span>{" "}
                      {truncate(formatPropertyValue(v), 20)}
                    </p>
                  ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}
