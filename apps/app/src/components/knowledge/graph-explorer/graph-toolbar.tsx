/**
 * graph-toolbar.tsx — the explorer's top control bar.
 *
 * Left: natural-language search over the node vector store. Right: the 2D / 3D /
 * Table view switch and (for the canvas views) auto-layout/fit, zoom, drag
 * toggle, pause/play animation, screenshot download, and reload.
 * Canvas-only actions disable in the table view.
 */

"use client";

import * as React from "react";
import {
  Search,
  Loader2,
  Network,
  Boxes,
  Table2,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Camera,
  RefreshCw,
  Move,
  Plus,
  GitBranch,
  Play,
  Pause,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { ExploreView, ExplorerStats } from "./types";

export interface GraphToolbarProps {
  view: ExploreView;
  onViewChange: (view: ExploreView) => void;
  stats: ExplorerStats | null;
  inViewNodeCount: number;
  inViewEdgeCount: number;
  searching: boolean;
  onSearch: (query: string) => void;
  draggable: boolean;
  onToggleDraggable: () => void;
  canvasReady: boolean;
  animated: boolean;
  onToggleAnimated: () => void;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onScreenshot: () => void;
  onReload: () => void;
  onCreateNode: () => void;
  onCreateEdge: () => void;
}

export function GraphToolbar(props: GraphToolbarProps) {
  const [query, setQuery] = React.useState("");
  const isTable = props.view === "table";
  const canvasDisabled = isTable || !props.canvasReady;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) props.onSearch(q);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
      {!isTable && (
        <form
          onSubmit={submit}
          className="relative min-w-[14rem] flex-1 sm:max-w-md"
        >
          {props.searching ? (
            <Loader2
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the graph in natural language…"
            aria-label="Search the graph"
            className="pl-8"
          />
        </form>
      )}

      {props.stats && (
        <div
          className="hidden items-center gap-1 text-xs text-muted-foreground md:flex"
          aria-live="polite"
        >
          <span className="tabular-nums">
            {props.inViewNodeCount.toLocaleString()}
          </span>
          <span>/</span>
          <span className="tabular-nums">
            {props.stats.nodeCount.toLocaleString()} nodes
          </span>
          <span className="mx-1 text-border">·</span>
          <span className="tabular-nums">
            {props.inViewEdgeCount.toLocaleString()}
          </span>
          <span>/</span>
          <span className="tabular-nums">
            {props.stats.edgeCount.toLocaleString()} edges
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {!isTable && (
          <div className="flex items-center gap-0.5">
            <IconAction
              label="Fit to view"
              onClick={props.onFit}
              disabled={canvasDisabled}
            >
              <Maximize2 className="size-4" />
            </IconAction>
            <IconAction
              label="Zoom in"
              onClick={props.onZoomIn}
              disabled={canvasDisabled}
            >
              <ZoomIn className="size-4" />
            </IconAction>
            <IconAction
              label="Zoom out"
              onClick={props.onZoomOut}
              disabled={canvasDisabled}
            >
              <ZoomOut className="size-4" />
            </IconAction>
            <IconAction
              label={props.draggable ? "Dragging on" : "Dragging off"}
              onClick={props.onToggleDraggable}
              disabled={canvasDisabled}
              active={props.draggable}
            >
              <Move className="size-4" />
            </IconAction>
            <IconAction
              label="Download screenshot"
              onClick={props.onScreenshot}
              disabled={canvasDisabled}
            >
              <Camera className="size-4" />
            </IconAction>
            <IconAction
              label={props.animated ? "Pause animation" : "Resume animation"}
              onClick={props.onToggleAnimated}
              disabled={canvasDisabled}
              active={props.animated}
            >
              {props.animated ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </IconAction>
          </div>
        )}

        {/* Create actions */}
        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="outline"
            onClick={props.onCreateNode}
            className="gap-1.5"
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">Node</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={props.onCreateEdge}
            className="gap-1.5"
          >
            <GitBranch className="size-3.5" />
            <span className="hidden sm:inline">Edge</span>
          </Button>
        </div>

        <IconAction label="Reload graph" onClick={props.onReload}>
          <RefreshCw className="size-4" />
        </IconAction>

        <SegmentedControl
          value={props.view}
          onValueChange={(v) => props.onViewChange(v as ExploreView)}
          aria-label="View mode"
        >
          <SegmentedControlItem value="2d" aria-label="2D graph">
            <Network className="size-4" />
          </SegmentedControlItem>
          <SegmentedControlItem value="3d" aria-label="3D graph">
            <Boxes className="size-4" />
          </SegmentedControlItem>
          <SegmentedControlItem value="table" aria-label="Table">
            <Table2 className="size-4" />
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(active && "bg-accent text-accent-foreground")}
    >
      {children}
    </Button>
  );
}
