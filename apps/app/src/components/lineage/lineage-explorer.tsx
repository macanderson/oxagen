/**
 * lineage-explorer.tsx — the fleet-lineage explorer orchestrator (issue
 * #1078).
 *
 * Composes the reagraph canvas (lazily loaded, `ssr:false`) with the indented
 * run list, a root-dispatch summary strip, and honest truncation/violation
 * banners. Receives an already-fetched, already-validated `query_lineage`
 * result as plain props — this component NEVER imports `actions.ts` or any
 * server-only module (it is "use client"; the data crossed the server→client
 * boundary once, in the parent Server Component).
 *
 * The reagraph canvas is `next/dynamic({ ssr: false })` — same discipline as
 * `@/components/knowledge/graph-explorer/graph-explorer.tsx` — so the page
 * paints its chrome + run list immediately while the WebGL bundle hydrates
 * behind a skeleton.
 */

"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  AlertTriangle,
  Loader2,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import {
  formatCost,
  statusBadgeVariant,
  timeAgo,
} from "@/components/activity/format";
import { cn } from "@/lib/utils";
import { buildLineageTree, summarizeLineage } from "@/lib/lineage/tree";
import { lineageNodeRef } from "@/lib/lineage/node-ref";
import { LineageNodeTree } from "./lineage-node-tree";
import type { LineageCanvasApi } from "./lineage-canvas-view";
import type { LineageQueryOutput } from "@oxagen/oxagen/contracts/lineage.query";

const LineageCanvasView = dynamic(() => import("./lineage-canvas-view"), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

export interface LineageExplorerProps {
  data: LineageQueryOutput;
  /** Link back to the dispatch picker (e.g. "?dispatchId=" removed). */
  pickerHref: string;
  /** Builds a URL re-querying the same dispatch with a larger maxDepth/maxNodes. */
  deeperHref?: string;
  moreNodesHref?: string;
}

export function LineageExplorer({
  data,
  pickerHref,
  deeperHref,
  moreNodesHref,
}: LineageExplorerProps) {
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const [isDark, setIsDark] = React.useState(false);
  const canvasApi = React.useRef<LineageCanvasApi | null>(null);
  const [canvasReady, setCanvasReady] = React.useState(false);

  React.useEffect(() => {
    const checkDark = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    checkDark();
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  const tree = React.useMemo(() => buildLineageTree(data.nodes), [data.nodes]);
  const summary = React.useMemo(
    () => summarizeLineage(data.nodes),
    [data.nodes],
  );

  const onApiReady = React.useCallback((api: LineageCanvasApi | null) => {
    canvasApi.current = api;
    setCanvasReady(api !== null);
  }, []);

  const violatingRefs = React.useMemo(
    () =>
      data.nodes
        .filter((n) => n.delegationViolation !== null)
        .map((n) => ({ node: n, ref: lineageNodeRef(n) })),
    [data.nodes],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Root dispatch summary strip */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <span
          className="font-mono text-xs text-muted-foreground"
          title={data.dispatchId}
        >
          {data.dispatchId}
        </span>
        <Badge
          variant={statusBadgeVariant(data.rootStatus)}
          size="sm"
          data-testid="root-status-badge"
        >
          {data.rootStatus}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {data.completedChildren}/{data.totalChildren} children
        </span>
        <span className="text-xs text-muted-foreground">
          {summary.nodeCount} runs
        </span>
        <span
          className="font-mono text-xs text-muted-foreground"
          data-testid="total-spend"
        >
          {formatCost(String(summary.totalSpendUsd)) ?? "$0"} total
        </span>
        <span className="text-xs text-muted-foreground">
          Updated {timeAgo(data.updatedAt)}
        </span>
        <Link
          href={pickerHref}
          className="ml-auto text-xs font-medium text-primary hover:underline"
        >
          Change dispatch
        </Link>
      </div>

      {/* Honesty banners — truncation / depth limits are never hidden. */}
      {data.truncated && (
        <Alert variant="warning" data-testid="truncated-banner">
          <AlertTriangle />
          <AlertTitle>Showing a partial tree</AlertTitle>
          <AlertDescription>
            This dispatch has more runs than fit in one query —{" "}
            {summary.nodeCount} of a larger tree are shown.
            {moreNodesHref && (
              <>
                {" "}
                <Link
                  href={moreNodesHref}
                  className="font-medium text-primary hover:underline"
                >
                  Load more nodes
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      {data.maxDepthReached && (
        <Alert variant="warning" data-testid="max-depth-banner">
          <AlertTriangle />
          <AlertTitle>The tree continues deeper</AlertTitle>
          <AlertDescription>
            At least one run at the deepest level shown dispatched its own
            subagents.
            {deeperHref && (
              <>
                {" "}
                <Link
                  href={deeperHref}
                  className="font-medium text-primary hover:underline"
                >
                  Load deeper
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Delegation-ceiling violation banner — unmistakable, per issue #1078. */}
      {violatingRefs.length > 0 && (
        <Alert variant="error" data-testid="violation-banner">
          <AlertTriangle />
          <AlertTitle>
            {violatingRefs.length} run{violatingRefs.length === 1 ? "" : "s"}{" "}
            hit an authorization / delegation-ceiling denial
          </AlertTitle>
          <AlertDescription>
            <div className="mt-1 flex flex-wrap gap-2">
              {violatingRefs.map(({ node, ref }) => (
                <NodeRef key={node.runId} node={ref} />
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Main split: canvas (reagraph) + run list */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card lg:h-[32rem] lg:flex-row">
        <div className="relative min-h-[320px] flex-1 border-b border-border lg:border-b-0 lg:border-r">
          <div className="absolute right-2 top-2 z-10 flex gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Fit to view"
              disabled={!canvasReady}
              onClick={() => canvasApi.current?.fit()}
            >
              <Maximize2 className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Zoom in"
              disabled={!canvasReady}
              onClick={() => canvasApi.current?.zoomIn()}
            >
              <ZoomIn className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Zoom out"
              disabled={!canvasReady}
              onClick={() => canvasApi.current?.zoomOut()}
            >
              <ZoomOut className="size-3.5" />
            </Button>
          </div>
          <LineageCanvasView
            nodes={data.nodes}
            dispatchId={data.dispatchId}
            selectedRunId={selectedRunId}
            isDark={isDark}
            onSelectRun={setSelectedRunId}
            onClearSelection={() => setSelectedRunId(null)}
            onApiReady={onApiReady}
          />
        </div>
        <div className={cn("min-h-0 overflow-y-auto lg:w-[26rem] lg:shrink-0")}>
          <LineageNodeTree
            tree={tree}
            selectedRunId={selectedRunId}
            onSelect={setSelectedRunId}
          />
        </div>
      </div>
    </div>
  );
}

function CanvasSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading lineage graph…</p>
      </div>
    </div>
  );
}
