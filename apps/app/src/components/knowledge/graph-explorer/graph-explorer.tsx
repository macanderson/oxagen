/**
 * graph-explorer.tsx — the knowledge-graph explorer orchestrator.
 *
 * Composes the toolbar, type-filter panel, the (lazily loaded) WebGL canvas or
 * the table view, and the node/edge detail panels. Owns view mode, type
 * visibility, selection, hover, search, and CRUD dialogs; reads tenant slugs
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
} from "lucide-react";
import { useTenant } from "@/lib/tenant/tenant-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useExplorerData } from "./use-explorer-data";
import { GraphToolbar } from "./graph-toolbar";
import { TypeFilterPanel } from "./type-filter-panel";
import { GraphTableView } from "./graph-table-view";
import { NodeDetailPanel } from "./node-detail-panel";
import { EdgeDetailPanel } from "./edge-detail-panel";
import { EdgeHoverPopover } from "./edge-hover-popover";
import { CreateNodeDialog } from "./create-node-dialog";
import { CreateEdgeDialog } from "./create-edge-dialog";
import { EditNodeDialog } from "./edit-node-dialog";
import { EditEdgeDialog } from "./edit-edge-dialog";
import { searchNodes, fetchVocab } from "./api-client";
import { countEdgesByType, countNodesByLabel } from "./lib/transform";
import type {
  ExploreView,
  ExplorerEdge,
  ExplorerNode,
  ExplorerVocabPayload,
} from "./types";
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

export function GraphExplorer() {
  const tenant = useTenant();
  const slugs = React.useMemo(
    () => ({ orgSlug: tenant.orgSlug, workspaceSlug: tenant.workspaceSlug }),
    [tenant.orgSlug, tenant.workspaceSlug],
  );

  const data = useExplorerData(slugs);

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
  const [systemHidden, setSystemHidden] = React.useState(true);
  const [searching, setSearching] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(true);
  const [isDark, setIsDark] = React.useState(false);

  // CRUD dialog state
  const [animated, setAnimated] = React.useState(false);
  const [vocab, setVocab] = React.useState<ExplorerVocabPayload>({
    labels: [],
    relationshipTypes: [],
  });
  const [createNodeOpen, setCreateNodeOpen] = React.useState(false);
  const [createEdgeOpen, setCreateEdgeOpen] = React.useState(false);
  const [editingNode, setEditingNode] = React.useState<ExplorerNode | null>(
    null,
  );
  const [editingEdge, setEditingEdge] = React.useState<ExplorerEdge | null>(
    null,
  );

  const canvasApi = React.useRef<GraphCanvasApi | null>(null);
  const [canvasReady, setCanvasReady] = React.useState(false);

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

  // Fetch workspace vocabulary (labels + relationship types) for create/edit selects.
  React.useEffect(() => {
    let active = true;
    fetchVocab(slugs)
      .then((v) => {
        if (active) setVocab(v);
      })
      .catch(() => {
        /* Non-fatal; forms work without pre-populated vocab */
      });
    return () => {
      active = false;
    };
  }, [slugs]);

  // ── Derived view data ────────────────────────────────────────────────────
  const nodeById = React.useMemo(
    () => new Map(data.nodes.map((n) => [n.id, n])),
    [data.nodes],
  );

  const visibleNodes = React.useMemo(
    () =>
      data.nodes.filter(
        (n) =>
          !hiddenNodeTypes.has(n.label) &&
          (!systemHidden || !isSystemLabel(n.label)),
      ),
    [data.nodes, hiddenNodeTypes, systemHidden],
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
      } catch {
        // Search failure is non-fatal; leave the graph untouched.
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
        onCreateNode={() => setCreateNodeOpen(true)}
        onCreateEdge={() => setCreateEdgeOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left: type-visibility filters */}
        {showFilters && (
          <aside className="hidden w-60 shrink-0 border-r border-border lg:block">
            <TypeFilterPanel
              nodeCounts={nodeCounts}
              edgeCounts={edgeCounts}
              hiddenNodeTypes={hiddenNodeTypes}
              hiddenEdgeTypes={hiddenEdgeTypes}
              inferredHidden={inferredHidden}
              systemHidden={systemHidden}
              inferredCount={inferredCount}
              confirmedCount={confirmedCount}
              onToggleNodeType={toggleNodeType}
              onToggleEdgeType={toggleEdgeType}
              onToggleInferred={() => setInferredHidden((v) => !v)}
              onToggleSystem={() => setSystemHidden((v) => !v)}
              onShowAllNodeTypes={() => setHiddenNodeTypes(new Set())}
              onHideAllNodeTypes={() =>
                setHiddenNodeTypes(new Set(nodeCounts.map((c) => c.type)))
              }
            />
          </aside>
        )}

        {/* Center: canvas or table */}
        <main className="relative min-w-0 flex-1">
          <FilterToggle
            showFilters={showFilters}
            onToggle={() => setShowFilters((s) => !s)}
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

          {data.truncated && data.status === "ready" && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/90 px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
              Showing a sample of the graph — double-click a node to expand, or
              use search.
            </div>
          )}
        </main>

        {/* Right: detail panel */}
        {selection && (
          <aside className="w-80 shrink-0 border-l border-border">
            {selection.type === "node" ? (
              <NodeDetailPanel
                tenant={slugs}
                nodeId={selection.id}
                {...(nodeById.get(selection.id)
                  ? { fallback: nodeById.get(selection.id)! }
                  : {})}
                onSelectNode={(id) => setSelection({ type: "node", id })}
                onExpand={(id) => void data.expand(id)}
                onClose={() => setSelection(null)}
                onEditNode={(node) => setEditingNode(node)}
                onDeleteNode={() => {
                  setSelection(null);
                  data.reload();
                }}
              />
            ) : selectedEdge ? (
              <EdgeDetailPanel
                edge={selectedEdge}
                tenant={slugs}
                {...(nodeById.get(selectedEdge.source)
                  ? { sourceNode: nodeById.get(selectedEdge.source)! }
                  : {})}
                {...(nodeById.get(selectedEdge.target)
                  ? { targetNode: nodeById.get(selectedEdge.target)! }
                  : {})}
                onSelectNode={(id) => setSelection({ type: "node", id })}
                onClose={() => setSelection(null)}
                onEditEdge={(edge) => setEditingEdge(edge)}
                onDeleteEdge={() => {
                  setSelection(null);
                  data.reload();
                }}
              />
            ) : null}
          </aside>
        )}
      </div>

      {hover && (
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

      {/* CRUD Dialogs */}
      <CreateNodeDialog
        open={createNodeOpen}
        onOpenChange={setCreateNodeOpen}
        tenant={slugs}
        labels={vocab.labels}
        onCreated={() => data.reload()}
      />
      <CreateEdgeDialog
        open={createEdgeOpen}
        onOpenChange={setCreateEdgeOpen}
        tenant={slugs}
        relationshipTypes={vocab.relationshipTypes}
        onCreated={() => data.reload()}
      />
      {editingNode && (
        <EditNodeDialog
          open={!!editingNode}
          onOpenChange={(open) => {
            if (!open) setEditingNode(null);
          }}
          tenant={slugs}
          node={editingNode}
          labels={vocab.labels}
          onUpdated={() => data.reload()}
        />
      )}
      {editingEdge && (
        <EditEdgeDialog
          open={!!editingEdge}
          onOpenChange={(open) => {
            if (!open) setEditingEdge(null);
          }}
          tenant={slugs}
          edge={editingEdge}
          sourceNode={nodeById.get(editingEdge.source)}
          targetNode={nodeById.get(editingEdge.target)}
          onUpdated={() => data.reload()}
          onDeleted={() => {
            setEditingEdge(null);
            setSelection(null);
            data.reload();
          }}
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

function isSystemLabel(label: string): boolean {
  const systemLabels = new Set([
    "System",
    "__System",
    "_System",
    "Internal",
    "__Internal",
    "_Internal",
    "Metadata",
    "__Metadata",
    "_Metadata",
  ]);
  return systemLabels.has(label);
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
        "absolute left-3 top-3 z-10 hidden lg:inline-flex",
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
