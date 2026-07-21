/**
 * graph-toolbar.tsx — the explorer's top control bar.
 *
 * Left: natural-language search over the node vector store. Right: the 2D / 3D /
 * Table view switch and (for the canvas views) auto-layout/fit, zoom, drag
 * toggle, pause/play animation, screenshot download, and reload.
 * Canvas-only actions disable in the table view.
 *
 * Below `md` the toolbar collapses: search goes full-width (16px font so iOS
 * doesn't zoom the page on focus), fit-to-view and the view switcher stay
 * inline, and every other action moves into a "More actions" menu.
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
  Play,
  Pause,
  MoreVertical,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui/menu";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { useIsCompact } from "./use-mobile";
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
}

export function GraphToolbar(props: GraphToolbarProps) {
  const [query, setQuery] = React.useState("");
  const compact = useIsCompact();
  const isTable = props.view === "table";
  const canvasDisabled = isTable || !props.canvasReady;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) props.onSearch(q);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
      {!isTable && (
        <form
          onSubmit={submit}
          className={cn(
            "relative flex-1",
            compact ? "min-w-0 basis-full" : "min-w-[14rem] sm:max-w-md",
          )}
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
            // 16px font below md so iOS Safari doesn't auto-zoom on focus.
            className="pl-8 text-base md:text-sm"
          />
        </form>
      )}

      {props.stats && (
        <div
          className="flex items-center gap-1 text-xs text-muted-foreground"
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

      {compact ? (
        <CompactActions {...props} canvasDisabled={canvasDisabled} />
      ) : (
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
              <Button
                size="sm"
                variant={props.animated ? "default" : "outline"}
                onClick={props.onToggleAnimated}
                disabled={canvasDisabled}
                className="gap-1.5"
                title={props.animated ? "Pause animation" : "Resume animation"}
              >
                {props.animated ? (
                  <>
                    <Pause className="size-3.5" />
                    <span className="hidden sm:inline text-xs">Pause</span>
                  </>
                ) : (
                  <>
                    <Play className="size-3.5" />
                    <span className="hidden sm:inline text-xs">Play</span>
                  </>
                )}
              </Button>
            </div>
          )}

          <IconAction label="Reload graph" onClick={props.onReload}>
            <RefreshCw className="size-4" />
          </IconAction>

          <ViewSwitch view={props.view} onViewChange={props.onViewChange} />
        </div>
      )}
    </div>
  );
}

/**
 * Below-`md` action cluster: fit-to-view and the view switcher stay inline,
 * everything else collapses into a "More actions" menu so the toolbar fits a
 * phone without wrapping into an icon soup.
 */
function CompactActions(
  props: GraphToolbarProps & { canvasDisabled: boolean },
) {
  const isTable = props.view === "table";
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {!isTable && (
        <IconAction
          label="Fit to view"
          onClick={props.onFit}
          disabled={props.canvasDisabled}
        >
          <Maximize2 className="size-4" />
        </IconAction>
      )}

      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="More actions"
              title="More actions"
            />
          }
        >
          <MoreVertical className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {!isTable && (
            <>
              <MenuItem
                onClick={props.onZoomIn}
                disabled={props.canvasDisabled}
              >
                <ZoomIn className="size-4" /> Zoom in
              </MenuItem>
              <MenuItem
                onClick={props.onZoomOut}
                disabled={props.canvasDisabled}
              >
                <ZoomOut className="size-4" /> Zoom out
              </MenuItem>
              <MenuItem
                onClick={props.onToggleDraggable}
                disabled={props.canvasDisabled}
              >
                <Move className="size-4" />{" "}
                {props.draggable ? "Disable dragging" : "Enable dragging"}
              </MenuItem>
              <MenuItem
                onClick={props.onToggleAnimated}
                disabled={props.canvasDisabled}
              >
                {props.animated ? (
                  <>
                    <Pause className="size-4" /> Pause animation
                  </>
                ) : (
                  <>
                    <Play className="size-4" /> Resume animation
                  </>
                )}
              </MenuItem>
              <MenuItem
                onClick={props.onScreenshot}
                disabled={props.canvasDisabled}
              >
                <Camera className="size-4" /> Download screenshot
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem onClick={props.onReload}>
            <RefreshCw className="size-4" /> Reload graph
          </MenuItem>
        </MenuPopup>
      </Menu>

      <ViewSwitch view={props.view} onViewChange={props.onViewChange} />
    </div>
  );
}

function ViewSwitch({
  view,
  onViewChange,
}: {
  view: ExploreView;
  onViewChange: (view: ExploreView) => void;
}) {
  return (
    <SegmentedControl
      value={view}
      onValueChange={(v) => onViewChange(v as ExploreView)}
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
