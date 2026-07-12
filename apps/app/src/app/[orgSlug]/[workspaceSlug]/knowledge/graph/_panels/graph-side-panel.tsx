"use client";

/**
 * graph-side-panel.tsx — the Browse / Search / Query side panel mounted
 * alongside the existing WebGL `GraphExplorer` canvas on Knowledge → Graph.
 *
 * Owns the panel-header summary (graph.stats), the Browse/Search/Query tab
 * strip, and subgraph export — the canvas itself is untouched (rendered by
 * the parent page.tsx) and this component never talks to
 * `/api/v1/graph/explore`.
 *
 * The zero-node "Connect a source" empty state (per the spec) lives INSIDE
 * `BrowsePanel`, not here — Search and the Query console (Cypher/traversal)
 * don't need any customer data ingested to be useful (a Cypher query can
 * still confirm the graph really is empty, or inspect system-owned nodes), so
 * the tab strip itself is never hidden behind a workspace-wide empty gate.
 *
 * `useTenant()` supplies orgSlug/workspaceSlug so this can mount without any
 * props threaded from the server page, mirroring how `GraphExplorer` itself
 * resolves its tenant.
 */

import * as React from "react";
import { Download } from "lucide-react";
import { useTenant } from "@/lib/tenant/tenant-context";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ErrorState, LoadingState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { GraphStatsBoxes, type GraphStatsData } from "@/components/knowledge/graph/graph-stats";
import { graphStatsAction, exportGraphAction } from "../actions";
import { BrowsePanel } from "./browse-panel";
import { SearchPanel } from "./search-panel";
import { QueryConsole } from "./query-console";

type PanelTab = "browse" | "search" | "query";

type StatsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; stats: GraphStatsData; labels: string[] };

export function GraphSidePanel() {
  const { orgSlug, workspaceSlug } = useTenant();
  const { add: addToast } = useToast();
  const [tab, setTab] = React.useState<PanelTab>("browse");
  const [state, setState] = React.useState<StatsState>({ status: "loading" });
  const [exporting, setExporting] = React.useState(false);
  const [activeLabels, setActiveLabels] = React.useState<string[]>([]);

  const loadStats = React.useCallback(async () => {
    setState({ status: "loading" });
    const res = await graphStatsAction({ orgSlug, workspaceSlug, includeByType: true });
    if (!res.ok) {
      setState({ status: "error", message: res.error });
      return;
    }
    setState({
      status: "ready",
      stats: res.stats,
      labels: Object.keys(res.stats.nodesByLabel ?? {}).sort((a, b) => a.localeCompare(b)),
    });
  }, [orgSlug, workspaceSlug]);

  React.useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const handleExport = React.useCallback(async () => {
    setExporting(true);
    try {
      const res = await exportGraphAction({
        orgSlug,
        workspaceSlug,
        ...(activeLabels.length > 0 ? { labels: activeLabels } : {}),
        includeEdges: true,
        limit: 1000,
      });
      if (!res.ok) {
        addToast({ title: "Export failed", description: res.error, type: "error" });
        return;
      }
      const payload = JSON.stringify({ nodes: res.nodes, edges: res.edges }, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${workspaceSlug}-graph-export.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      addToast({
        title: "Export ready",
        description: `Exported ${res.nodes.length} node${res.nodes.length === 1 ? "" : "s"} and ${res.edges.length} edge${res.edges.length === 1 ? "" : "s"}.`,
        type: "success",
      });
    } finally {
      setExporting(false);
    }
  }, [orgSlug, workspaceSlug, activeLabels, addToast]);

  // Computed outside the JSX disabled expression so it doesn't lean on
  // control-flow narrowing through a `||` short-circuit for a discriminated
  // union field access.
  const nodeCount = state.status === "ready" ? state.stats.nodeCount : null;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-card">
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Graph</h2>
          <p className="text-xs text-muted-foreground">Browse, search, and query the workspace graph.</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          startIcon={<Download className="size-3.5" />}
          onClick={() => void handleExport()}
          loading={exporting}
          disabled={nodeCount === null || nodeCount === 0}
        >
          Export
        </Button>
      </div>

      <div className="border-b border-border/60 px-4 py-3">
        {state.status === "loading" ? (
          <LoadingState variant="cards" />
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load graph stats"
            description={state.message}
            retry={() => void loadStats()}
          />
        ) : (
          <GraphStatsBoxes stats={state.stats} />
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="underline" className="px-4 pt-2">
          <TabsTab value="browse">Browse</TabsTab>
          <TabsTab value="search">Search</TabsTab>
          <TabsTab value="query">Query</TabsTab>
        </TabsList>
        <TabsPanel value="browse" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <BrowsePanel
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            availableLabels={state.status === "ready" ? state.labels : []}
            onLabelsChange={setActiveLabels}
          />
        </TabsPanel>
        <TabsPanel value="search" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <SearchPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
        </TabsPanel>
        <TabsPanel value="query" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <QueryConsole orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
