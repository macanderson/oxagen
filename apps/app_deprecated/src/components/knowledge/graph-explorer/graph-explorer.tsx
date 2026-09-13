/**
 * graph-explorer.tsx — the knowledge-graph explorer orchestrator.
 *
 * Composes the toolbar, type-filter panel, the (lazily loaded) WebGL canvas or
 * the table view, and the node/edge detail panels. Owns view mode, type
 * visibility, selection, hover, and search; reads tenant slugs
 * from context and the live graph from `useExplorerData`.
 *
 * The reagraph canvas is `next/dynamic({ ssr:false })` so the page paints its
 * chrome and the table view immediately while the heavy WebGL bundle hydrates
 * behind a skeleton — graceful, non-blocking load.
 */

"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  Loader2,
  Network,
  AlertTriangle,
  RefreshCw,
  SlidersHorizontal,
  EyeOff,
} from "lucide-react";
import { useTenant } from "@/lib/tenant/tenant-context";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useExplorerData } from "./use-explorer-data";
import { useIsMobile, useHasHover } from "./use-mobile";
import { GraphToolbar } from "./graph-toolbar";
import { TypeFilterPanel } from "./type-filter-panel";
import { GraphTableView } from "./graph-table-view";
import { NodeDetailPanel } from "./node-detail-panel";
import { EdgeDetailPanel } from "./edge-detail-panel";
import { EdgeHoverPopover } from "./edge-hover-popover";
import { searchNodes } from "./api-client";
import { countEdgesByType, countNodesByLabel } from "./lib/transform";
import type { ExploreView, ExplorerEdge, ExplorerNode } from "./types";
import type { GraphCanvasApi } from "./graph-canvas-view";

// Lazy, client-only. The fallback keeps layout stable while WebGL hydrates.
const GraphCanvasView = dynamic(() => import("./graph-canvas-view"), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

interface Selection {
  type: "node" | "edge";
  id: string;
}

export interface GraphExplorerProps {
  /**
   * publicId of a node to focus on mount — used by the chat "Grounded in"
   * citations' "View in graph" deep-link (`?focus=<publicId>`). The explorer
   * expands that node's neighborhood into view, selects it (so the focus/mute
   * highlight centers on it), and fits the canvas. Absent for the normal
   * whole-graph browse.
   */
  focusNodeId?: string;
}

export function GraphExplorer({ focusNodeId }: GraphExplorerProps = {}) {
  const tenant = useTenant();
  const slugs = React.useMemo(
    () => ({ orgSlug: tenant.orgSlug, workspaceSlug: tenant.workspaceSlug }),
    [tenant.orgSlug, tenant.workspaceSlug],
  );

  const data = useExplorerData(slugs);

  // Responsive behaviour: below `lg` the side panels become bottom sheets, and
  // touch devices (no real hover) never see the cursor-anchored edge popover.
  const isMobile = useIsMobile();
  const hasHover = useHasHover();

  const [view, setView] = React.useState<ExploreView>("2d");
  const [draggable, setDraggable] = React.useState(true);
  const [selection, setSelection] = React.useState<Selection | null>(null);
  const [hover, setHover] = React.useState<{
    edge: ExplorerEdge;
    pos: { x: number; y: number };
  } | null>(null);
  const [hiddenNodeTypes, setHiddenNodeTypes] = React.useState<Set<string>>(
    new Set(),
  );
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = React.useState<Set<string>>(
    new Set(),
  );
  const [inferredHidden, setInferredHidden] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(true);
  const [mobileFiltersOpen, setMobileFiltersOpen] = React.useState(false);
  const [isDark, setIsDark] = React.useState(false);

  const [animated, setAnimated] = React.useState(false);

  // Mobile canvas defaults, applied once when a small viewport is detected:
  // 2D layout (3D orbit is unusable on touch), node dragging off (it fights
  // one-finger pan), and animation off (WebGL perf on phones).
  const appliedMobileDefaults = React.useRef(false);
  React.useEffect(() => {
    if (!isMobile || appliedMobileDefaults.current) return;
    appliedMobileDefaults.current = true;
    setDraggable(false);
    setAnimated(false);
    setView((v) => (v === "3d" ? "2d" : v));
  }, [isMobile]);
  const canvasApi = React.useRef<GraphCanvasApi | null>(null);
  const [canvasReady, setCanvasReady] = React.useState(false);

  // Deep-link focus (from the chat citation "View in graph" action). Once the
  // graph has loaded, pull the focused node's neighborhood into view, select it
  // so the focus/mute highlight centers on it, and fit the canvas. Guarded by a
  // ref so it runs once per distinct focus target, never re-triggering on every
  // data change.
  const focusedRef = React.useRef<string | null>(null);
  const dataStatus = data.status;
  const expandNode = data.expand;
  React.useEffect(() => {
    if (!focusNodeId || dataStatus !== "ready") return;
    if (focusedRef.current === focusNodeId) return;
    focusedRef.current = focusNodeId;
    setView((v) => (v === "table" ? "2d" : v));
    void expandNode(focusNodeId).finally(() => {
      setSelection({ type: "node", id: focusNodeId });
      canvasApi.current?.fit();
    });
  }, [focusNodeId, dataStatus, expandNode]);

  React.useEffect(() => {
    const checkDark = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    checkDark();
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // ── Derived view data ────────────────────────────────────────────────────
  const nodeById = React.useMemo(
    () => new Map(data.nodes.map((n) => [n.id, n])),
    [data.nodes],
  );

  const visibleNodes = React.useMemo(
    () => data.nodes.filter((n) => !hiddenNodeTypes.has(n.label)),
    [data.nodes, hiddenNodeTypes],
  );
  const visibleNodeIds = React.useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes],
  );
  const visibleEdges = React.useMemo(
    () =>
      data.edges.filter(
        (e) =>
          !hiddenEdgeTypes.has(e.type) &&
          (!inferredHidden || !e.inferred) &&
          visibleNodeIds.has(e.source) &&
          visibleNodeIds.has(e.target),
      ),
    [data.edges, hiddenEdgeTypes, inferredHidden, visibleNodeIds],
  );

  const nodeCounts = React.useMemo(
    () => countNodesByLabel(data.nodes),
    [data.nodes],
  );
  const edgeCounts = React.useMemo(
    () => countEdgesByType(data.edges),
    [data.edges],
  );
  const inferredCount = React.useMemo(
    () => data.edges.filter((e) => e.inferred).length,
    [data.edges],
  );
  const confirmedCount = data.edges.length - inferredCount;

  // Focus/mute: when something is selected, only the selection + its immediate
  // graph neighbourhood stay "active"; reagraph dims the rest.
  const actives = React.useMemo(() => {
    if (!selection) return [];
    if (selection.type === "edge") {
      const edge = data.edges.find((e) => e.id === selection.id);
      return edge ? [edge.id, edge.source, edge.target] : [selection.id];
    }
    const ids = new Set<string>([selection.id]);
    for (const e of visibleEdges) {
      if (e.source === selection.id || e.target === selection.id) {
        ids.add(e.id);
        ids.add(e.source);
        ids.add(e.target);
      }
    }
    return [...ids];
  }, [selection, data.edges, visibleEdges]);

  const selectedEdge =
    selection?.type === "edge"
      ? (data.edges.find((e) => e.id === selection.id) ?? null)
      : null;

  // ── Handlers ─────────────────────────────────────────────────────────────
  const onSearch = React.useCallback(
    async (query: string) => {
      setSearching(true);
      try {
        const result = await searchNodes(slugs, query);
        if (result.nodes.length > 0) {
          data.addSubgraph(result.nodes, []);
          const first = result.nodes[0] as ExplorerNode;
          setSelection({ type: "node", id: first.id });
          if (view === "table") setView("2d");
        }
      } catch (err) {
        // Search failure is non-fatal — the graph is left untouched — but it
        // must not vanish: an empty result and a failed request look identical
        // on screen otherwise.
        console.error("graph explorer: node search failed:", err);
      } finally {
        setSearching(false);
      }
    },
    [slugs, data, view],
  );

  const onScreenshot = React.useCallback(() => {
    const url = canvasApi.current?.exportImage();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `knowledge-graph-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const onApiReady = React.useCallback((api: GraphCanvasApi | null) => {
    canvasApi.current = api;
    setCanvasReady(api !== null);
  }, []);

  const toggleNodeType = React.useCallback((type: string) => {
    setHiddenNodeTypes((prev) => toggleInSet(prev, type));
  }, []);
  const toggleEdgeType = React.useCallback((type: string) => {
    setHiddenEdgeTypes((prev) => toggleInSet(prev, type));
  }, []);

  // The node/edge detail content is shared between the desktop side panel and
  // the mobile bottom sheet — one implementation, two containers.
  const detailPanel = !selection ? null : selection.type === "node" ? (
    <NodeDetailPanel
      tenant={slugs}
      nodeId={selection.id}
      {...(nodeById.get(selection.id)
        ? { fallback: nodeById.get(selection.id)! }
        : {})}
      onSelectNode={(id) => setSelection({ type: "node", id })}
      onExpand={(id) => void data.expand(id)}
      onClose={() => setSelection(null)}
    />
  ) : selectedEdge ? (
    <EdgeDetailPanel
      edge={selectedEdge}
      {...(nodeById.get(selectedEdge.source)
        ? { sourceNode: nodeById.get(selectedEdge.source)! }
        : {})}
      {...(nodeById.get(selectedEdge.target)
        ? { targetNode: nodeById.get(selectedEdge.target)! }
        : {})}
      onSelectNode={(id) => setSelection({ type: "node", id })}
      onClose={() => setSelection(null)}
    />
  ) : null;

  const filterPanel = (
    <TypeFilterPanel
      nodeCounts={nodeCounts}
      edgeCounts={edgeCounts}
      hiddenNodeTypes={hiddenNodeTypes}
      hiddenEdgeTypes={hiddenEdgeTypes}
      inferredHidden={inferredHidden}
      inferredCount={inferredCount}
      confirmedCount={confirmedCount}
      onToggleNodeType={toggleNodeType}
      onToggleEdgeType={toggleEdgeType}
      onToggleInferred={() => setInferredHidden((v) => !v)}
      onShowAllNodeTypes={() => setHiddenNodeTypes(new Set())}
      onHideAllNodeTypes={() =>
        setHiddenNodeTypes(new Set(nodeCounts.map((c) => c.type)))
      }
    />
  );

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <GraphToolbar
        view={view}
        onViewChange={setView}
        stats={data.stats}
        inViewNodeCount={visibleNodes.length}
        inViewEdgeCount={visibleEdges.length}
        searching={searching}
        onSearch={onSearch}
        draggable={draggable}
        onToggleDraggable={() => setDraggable((d) => !d)}
        animated={animated}
        onToggleAnimated={() => setAnimated((a) => !a)}
        canvasReady={canvasReady}
        onFit={() => canvasApi.current?.fit()}
        onZoomIn={() => canvasApi.current?.zoomIn()}
        onZoomOut={() => canvasApi.current?.zoomOut()}
        onScreenshot={onScreenshot}
        onReload={data.reload}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left: type-visibility filters (desktop inline panel; a sheet below lg) */}
        {!isMobile && showFilters && (
          <aside className="hidden w-60 shrink-0 border-r border-border lg:block">
            {filterPanel}
          </aside>
        )}

        {/* Center: canvas or table */}
        <main className="relative min-w-0 flex-1">
          <FilterToggle
            showFilters={isMobile ? mobileFiltersOpen : showFilters}
            onToggle={() =>
              isMobile ? setMobileFiltersOpen(true) : setShowFilters((s) => !s)
            }
          />

          {data.status === "error" ? (
            <ErrorState message={data.error} onRetry={data.reload} />
          ) : data.status === "loading" ? (
            <CanvasSkeleton />
          ) : data.nodes.length === 0 ? (
            <EmptyState />
          ) : view === "table" ? (
            <GraphTableView
              tenant={slugs}
              visibleLabels={
                hiddenNodeTypes.size > 0
                  ? nodeCounts
                      .filter((c) => !hiddenNodeTypes.has(c.type))
                      .map((c) => c.type)
                  : undefined
              }
              selectedNodeId={selection?.type === "node" ? selection.id : null}
              onSelectNode={(id) => setSelection({ type: "node", id })}
            />
          ) : visibleNodes.length === 0 ? (
            // Nodes are loaded but every one is hidden by the type-visibility
            // filters — a blank canvas here reads as "empty graph". Offer a
            // one-click clear instead.
            <FilteredEmptyState
              count={data.nodes.length}
              description="Every node type is hidden by the visibility filters."
              actionLabel="Clear filters"
              onAction={() => setHiddenNodeTypes(new Set())}
            />
          ) : (
            <GraphCanvasView
              nodes={visibleNodes}
              edges={visibleEdges}
              selectedId={selection?.id ?? null}
              actives={actives}
              view={view === "3d" ? "3d" : "2d"}
              draggable={draggable}
              animated={animated}
              isDark={isDark}
              onSelectNode={(id) => setSelection({ type: "node", id })}
              onSelectEdge={(id) => setSelection({ type: "edge", id })}
              onClearSelection={() => setSelection(null)}
              onExpandNode={(id) => void data.expand(id)}
              onEdgeHover={(edge, pos) =>
                setHover(edge && pos ? { edge, pos } : null)
              }
              onApiReady={onApiReady}
            />
          )}

          {/* `nodes.length > 0` guard: with zero loaded nodes the EmptyState
              owns the canvas — the sample pill would overlap its copy and
              tell the user to tap nodes that aren't there. */}
          {data.truncated &&
            data.status === "ready" &&
            data.nodes.length > 0 && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-full border border-border bg-card/90 px-3 py-1 text-center text-[11px] text-muted-foreground shadow-sm">
                {isMobile
                  ? "Showing a sample — tap a node, then “Expand neighbours”."
                  : "Showing a sample of the graph — double-click a node to expand, or use search."}
              </div>
            )}
        </main>

        {/* Right: detail panel (desktop side panel; a bottom sheet below lg) */}
        {!isMobile && detailPanel && (
          <aside className="w-80 shrink-0 border-l border-border">
            {detailPanel}
          </aside>
        )}
      </div>

      {/* Mobile: node/edge detail in a bottom sheet (~70vh, scrollable). The
          sheet's built-in close is hidden — the panel header's own close button
          does the job and would otherwise overlap it. */}
      {isMobile && (
        <Sheet
          open={detailPanel !== null}
          onOpenChange={(open) => {
            if (!open) setSelection(null);
          }}
        >
          <SheetPopup
            side="bottom"
            aria-label="Selection details"
            className="flex h-[70vh] flex-col gap-0 overflow-hidden rounded-t-xl p-0 [&>button:last-child]:hidden"
          >
            <SheetTitle className="sr-only">Selection details</SheetTitle>
            <div className="min-h-0 flex-1 overflow-hidden">{detailPanel}</div>
          </SheetPopup>
        </Sheet>
      )}

      {/* Mobile: type filters in a bottom sheet. */}
      {isMobile && (
        <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <SheetPopup
            side="bottom"
            aria-label="Graph filters"
            className="flex h-[70vh] flex-col gap-0 overflow-hidden rounded-t-xl p-0"
          >
            <SheetHeader className="border-b border-border px-4 py-3 text-left">
              <SheetTitle className="text-sm">Filters</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">{filterPanel}</div>
          </SheetPopup>
        </Sheet>
      )}

      {/* Cursor-anchored edge popover: pointer-fine (hover-capable) devices
          only. On touch, tapping an edge selects it and the detail sheet opens
          instead. */}
      {hover && hasHover && (
        <EdgeHoverPopover
          edge={hover.edge}
          pos={hover.pos}
          {...(nodeById.get(hover.edge.source)
            ? { sourceNode: nodeById.get(hover.edge.source)! }
            : {})}
          {...(nodeById.get(hover.edge.target)
            ? { targetNode: nodeById.get(hover.edge.target)! }
            : {})}
        />
      )}
    </div>
  );
}

function toggleInSet(prev: Set<string>, value: string): Set<string> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function FilterToggle({
  showFilters,
  onToggle,
}: {
  showFilters: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={onToggle}
      aria-label={showFilters ? "Hide filters" : "Show filters"}
      title={showFilters ? "Hide filters" : "Show filters"}
      className={cn(
        "absolute left-3 top-3 z-10",
        showFilters && "bg-accent text-accent-foreground",
      )}
    >
      <SlidersHorizontal className="size-4" />
    </Button>
  );
}

function CanvasSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading graph…</p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <Network
          className="mx-auto mb-3 size-8 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-foreground">
          No graph data yet
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a data source and run a sync to populate the knowledge graph.
          Entities and their relationships will appear here.
        </p>
      </div>
    </div>
  );
}

/**
 * Shown when the graph is NOT empty but the current view has nothing to draw —
 * every node was filtered out (agent-activity toggle, or type visibility). It
 * names the hidden count and offers the one action that brings them back, so
 * the user is never told "no data" while data plainly exists in the stats rail.
 */
function FilteredEmptyState({
  count,
  description,
  actionLabel,
  onAction,
}: {
  count: number;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <EyeOff
          className="mx-auto mb-3 size-8 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-foreground">
          {count.toLocaleString()} {count === 1 ? "node" : "nodes"} hidden by
          filters
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          startIcon={<Network className="size-3.5" />}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <AlertTriangle
          className="mx-auto mb-3 size-8 text-destructive"
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-foreground">
          Couldn’t load the graph
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {message ?? "An unexpected error occurred."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          startIcon={<RefreshCw className="size-3.5" />}
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}
