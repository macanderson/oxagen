/**
 * execution-lineage-canvas.tsx — the "file lineage as a graph" proof for one
 * agent run.
 *
 * Renders `(:Execution)-[:TOUCHED_FILE]->(:SourceFile)` on the SAME shared
 * reagraph canvas the knowledge explorer uses (`GraphCanvasView`), centered on
 * the execution node with an edge out to every source file it actually
 * modified. Under the canvas the touched files are ALSO cited as inspectable
 * `NodeRef` chips (human label + hover/inspect property bag), so the lineage is
 * both a live graph and a set of citable facts — never a flat list of raw ids.
 *
 * This is the auditable half of the graph-grounding story: "what files did this
 * agent actually touch, as a real graph" — reachable from the run's trace page.
 */
"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Loader2, Network } from "lucide-react";
import type { AgentExecutionLineageOutput } from "@oxagen/oxagen/contracts/agent.execution.lineage";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import type {
  ExplorerEdge,
  ExplorerNode,
} from "@/components/knowledge/graph-explorer/types";
import type { GraphCanvasApi } from "@/components/knowledge/graph-explorer/graph-canvas-view";

// Lazy, client-only — the WebGL bundle hydrates behind a skeleton (same pattern
// as the graph explorer).
const GraphCanvasView = dynamic(
  () => import("@/components/knowledge/graph-explorer/graph-canvas-view"),
  { ssr: false, loading: () => <CanvasSkeleton /> },
);

type LineageFile = AgentExecutionLineageOutput["files"][number];
type LineageExecution = NonNullable<AgentExecutionLineageOutput["execution"]>;

export interface ExecutionLineageCanvasProps {
  execution: LineageExecution;
  files: LineageFile[];
}

/** Stable canvas id for a citation whose node id may be null (defensive). */
function nodeCanvasId(id: string | null, fallback: string): string {
  return id ?? fallback;
}

export function ExecutionLineageCanvas({
  execution,
  files,
}: ExecutionLineageCanvasProps) {
  const [isDark, setIsDark] = React.useState(false);
  const canvasApi = React.useRef<GraphCanvasApi | null>(null);

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

  const execId = nodeCanvasId(execution.id, "execution");

  const nodes: ExplorerNode[] = React.useMemo(
    () => [
      {
        id: execId,
        label: execution.label,
        displayName: execution.displayName,
        properties: execution.properties,
        degree: files.length,
        hydrated: true,
      },
      ...files.map((f) => ({
        id: nodeCanvasId(f.node.id, f.node.displayName),
        label: f.node.label,
        displayName: f.node.displayName,
        properties: f.node.properties,
        degree: 1,
        hydrated: true,
      })),
    ],
    [execId, execution, files],
  );

  const edges: ExplorerEdge[] = React.useMemo(
    () =>
      files.map((f) => {
        const target = nodeCanvasId(f.node.id, f.node.displayName);
        return {
          id: `${execId}->${target}:${f.edgeType}`,
          source: execId,
          target,
          type: f.edgeType,
          inferred: false,
        };
      }),
    [execId, files],
  );

  return (
    <section className="flex flex-col gap-3" data-component="execution-lineage">
      <div className="flex flex-wrap items-center gap-2">
        <Network className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground">
          Execution file lineage
        </span>
        <span className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} touched · queried
          live from the knowledge graph
        </span>
      </div>

      <div className="relative h-[420px] w-full overflow-hidden rounded-xl border border-border bg-card">
        <GraphCanvasView
          nodes={nodes}
          edges={edges}
          selectedId={execId}
          actives={[]}
          view="2d"
          draggable
          animated={false}
          isDark={isDark}
          onSelectNode={() => {}}
          onSelectEdge={() => {}}
          onClearSelection={() => {}}
          onExpandNode={() => {}}
          onEdgeHover={() => {}}
          onApiReady={(api) => {
            canvasApi.current = api;
            api?.fit();
          }}
        />
      </div>

      {files.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Touched files ({files.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <NodeRef key={nodeCanvasId(f.node.id, f.node.displayName)} node={f.node} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
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
